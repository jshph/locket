import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notePrefix, userMessage, type Distiller } from "./src/distill.ts";
import { exclusionReason, OmiStore, parseOmiPayload, readyGroups, renderTranscript, type OmiConversation } from "./src/omi.ts";
import { decide, MAX_PEOPLE, runHook, type GuardContext } from "./src/omi-guard.ts";
import { DISTILL_BACKOFF_MS, groupConversations, processNote, type OmiDeps } from "./src/omi-worker.ts";
import { JobStore } from "./src/store.ts";
import { makeHandler } from "./server.ts";

/** The handler returns undefined only after a WebSocket upgrade, which these tests never do. */
const http = (h: ReturnType<typeof makeHandler>) => (req: Request) => h(req) as Promise<Response>;

const tmp = mkdtempSync(join(tmpdir(), "omi-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SECRET = "omi-secret-0123456789abcdef0123";
const MIN = 60_000;
const T0 = Date.parse("2026-11-04T19:00:00Z"); // 14:00 New York

function payload(over: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    created_at: "2026-11-04T19:06:00Z",
    started_at: "2026-11-04T19:00:00Z",
    finished_at: "2026-11-04T19:05:00Z",
    transcript_segments: [
      { text: "So the ring agent works now.", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 1, end: 3 },
      { text: "Nice, what does it do?", speaker: "SPEAKER_01", speakerId: 1, is_user: false, start: 4, end: 5 },
      { text: "It routes into Todoist.", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 6, end: 7 },
      { text: "And Omi next.", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 7, end: 8 },
      { text: "Cool.", speaker: "SPEAKER_02", speakerId: 2, speaker_name: "Mira Shah", person_id: "p1", is_user: false, start: 9, end: 10 },
      { text: "Hello.", speaker: "SPEAKER_03", speakerId: 3, speaker_name: "Speaker B", is_user: false, start: 10, end: 11 },
      { text: "Mine.", speaker: "SPEAKER_00", speakerId: 0, speaker_name: "Sam", is_user: true, start: 11, end: 11 },
      { text: "   ", speaker: "SPEAKER_01", is_user: false, start: 11, end: 12 },
    ],
    structured: { title: "Ring agent" },
    discarded: false,
    ...over,
  };
}

function conv(id: string, startMin: number, endMin: number, receivedMin = endMin, words = 50): OmiConversation {
  return {
    id, startedAt: T0 + startMin * MIN, finishedAt: T0 + endMin * MIN, receivedAt: T0 + receivedMin * MIN, discarded: false,
    segments: [{ text: Array(words).fill("word").join(" "), speaker: "SPEAKER_00", isUser: true, start: 0, end: 1 }],
  };
}

// --- payload and transcript ---

test("parses the Omi payload, keeping speakers and dropping empty segments", () => {
  const c = parseOmiPayload(payload(), T0) as OmiConversation;
  expect(c.id).toBe("conv-1");
  expect(c.startedAt).toBe(T0);
  expect(c.finishedAt).toBe(T0 + 5 * MIN);
  expect(c.segments).toHaveLength(7);
  expect(c.segments[4]).toMatchObject({ name: "Mira Shah", isUser: false });
  expect(c.segments[5]).toMatchObject({ label: "Speaker B" });
  expect(c.segments[5].name).toBeUndefined(); // Omi's neutral label is not an identity
  expect(c.segments[6].name).toBeUndefined();
  expect(parseOmiPayload({}, T0)).toBe("missing conversation id");
  expect(parseOmiPayload({ id: "x", started_at: "nope", transcript_segments: [] }, T0)).toBe("missing started_at");
  expect(parseOmiPayload({ id: "x", started_at: "2026-11-04T19:00:00Z" }, T0)).toBe("missing transcript_segments");
});

test("transcript labels Me, Omi-named voices and numbered speakers, joining turns", () => {
  const c = parseOmiPayload(payload(), T0) as OmiConversation;
  const text = renderTranscript([c], "America/Bogota");
  expect(text).toContain("## Conversation 1: 14:00:00–14:05:00");
  expect(text).toContain("[14:00:01] Me: So the ring agent works now.");
  expect(text).toContain("[14:00:04] Speaker 2: Nice, what does it do?");
  expect(text).toContain("[14:00:06] Me: It routes into Todoist. And Omi next.");
  expect(text).toContain("[14:00:09] Mira Shah: Cool.");
  expect(text).toContain("[14:00:10] Speaker B: Hello.");
  expect(text).toContain("[14:00:11] Me: Mine.");
  const msg = userMessage([c], "America/Bogota");
  expect(msg).toContain('Note filename prefix (use exactly): "2026-11-04-14-00-00 "');
  expect(msg).toContain("- Me: 14 words");
  expect(notePrefix([c], "America/Bogota")).toBe("2026-11-04-14-00-00 ");
});

test("background conversations are excluded unless the owner talked enough; discards always are", () => {
  const owner = (words: number) => ({ text: Array(words).fill("w").join(" "), speaker: "SPEAKER_00", isUser: true, start: 0, end: 1 });
  const tv = { text: Array(500).fill("w").join(" "), speaker: "SPEAKER_01", isUser: false, start: 0, end: 1 };
  const base = conv("x", 0, 5);
  expect(exclusionReason({ ...base, salience: "background", segments: [tv, owner(10)] }, 60)).toBe("background");
  expect(exclusionReason({ ...base, salience: "background", segments: [tv, owner(60)] }, 60)).toBeNull();
  expect(exclusionReason({ ...base, salience: "highlight", segments: [tv] }, 60)).toBeNull();
  expect(exclusionReason({ ...base, segments: [tv] }, 60)).toBeNull(); // no salience: keep
  expect(exclusionReason({ ...base, discarded: true, salience: "highlight" }, 60)).toBe("discarded");
  const parsed = parseOmiPayload(payload({ structured: { title: "t", salience: "background" } }), T0) as OmiConversation;
  expect(parsed.salience).toBe("background");
});

// --- merging ---

test("conversations within the gap merge; a group closes only after the gap passes", () => {
  const convs = [conv("a", 0, 5), conv("b", 12, 20), conv("c", 45, 50), { ...conv("d", 21, 22), discarded: true }];
  const gap = 10 * MIN;
  expect(readyGroups(convs, T0 + 25 * MIN, gap)).toEqual([]); // b ended 5 min ago
  const at31 = readyGroups(convs, T0 + 31 * MIN, gap);
  expect(at31.map((g) => g.map((c) => c.id))).toEqual([["a", "b"]]);
  const late = readyGroups([conv("e", 0, 5, 200)], T0 + 205 * MIN, gap); // offline sync arriving late
  expect(late).toEqual([]);
  expect(readyGroups([conv("e", 0, 5, 200)], T0 + 211 * MIN, gap)).toHaveLength(1);
});

function deps(name: string, distill: Distiller, over: Partial<OmiDeps> = {}) {
  const sent: { title: string; message: string; opts?: any }[] = [];
  let now = T0 + 60 * MIN;
  const d: OmiDeps = {
    store: new OmiStore(join(tmp, name)), distill,
    notify: async (title, message, opts) => void sent.push({ title, message, opts }),
    now: () => now, mergeGapMs: 10 * MIN, minWords: 40, maxNotesPerDay: 30, ...over,
  };
  return { d, sent, advance: (ms: number) => (now += ms) };
}

test("short groups are skipped without running the distiller; others are queued once", async () => {
  let calls = 0;
  const { d } = deps("g1", async () => (calls++, { status: "skipped", reason: "x" }));
  d.store.saveConversation(conv("short", 0, 1, 1, 10));
  d.store.saveConversation(conv("long", 30, 40));
  const made = groupConversations(d);
  expect(made.map((n) => [n.id, n.status])).toEqual([["omi-short", "skipped"], ["omi-long", "pending"]]);
  expect(groupConversations(d)).toEqual([]); // already assigned
  expect(d.store.conversation("long")?.noteId).toBe("omi-long");
  expect(calls).toBe(0);
});

test("a written note is recorded and announced with any new people", async () => {
  const { d, sent } = deps("g2", async () => ({ status: "written", notePath: "inbox/2026-11-04-14-00-00 omi test.md", title: "omi test", peopleCreated: ["Mira Shah"], identities: [] }));
  d.store.saveConversation(conv("w", 0, 5));
  const [note] = groupConversations(d);
  await processNote(note, d);
  expect(d.store.note(note.id)).toMatchObject({ status: "done", notePath: "inbox/2026-11-04-14-00-00 omi test.md" });
  expect(sent[0].title).toBe("Omi note");
  expect(sent[0].message).toContain("New people: Mira Shah");
});

test("distiller failures retry with backoff, then alert urgently and never dump the transcript", async () => {
  const { d, sent, advance } = deps("g3", async () => {
    throw new Error("usage limit");
  });
  d.store.saveConversation(conv("f", 0, 5));
  const [note] = groupConversations(d);
  for (let i = 0; i < DISTILL_BACKOFF_MS.length; i++) {
    await processNote(d.store.note(note.id)!, d);
    expect(d.store.note(note.id)!.status).toBe("pending");
    advance(DISTILL_BACKOFF_MS[i]);
  }
  await processNote(d.store.note(note.id)!, d);
  expect(d.store.note(note.id)!.status).toBe("failed");
  expect(sent).toHaveLength(1);
  expect(sent[0].opts?.urgent).toBe(true);
});

test("the daily cap defers notes instead of dropping them", async () => {
  let calls = 0;
  const { d, sent } = deps("g4", async () => (calls++, { status: "written", notePath: "inbox/x.md", title: "x", peopleCreated: [], identities: [] }), { maxNotesPerDay: 1 });
  d.store.saveConversation(conv("c1", 0, 5));
  d.store.saveConversation(conv("c2", 30, 35));
  const notes = groupConversations(d);
  await processNote(notes[0], d);
  await processNote(notes[1], d);
  expect(calls).toBe(1);
  expect(d.store.note(notes[1].id)!.status).toBe("pending");
  expect(sent.at(-1)!.title).toBe("Omi: daily limit reached");
});

// --- webhook route ---

test("the /omi route needs the secret, saves once, and keeps discarded and background conversations out", async () => {
  const store = new OmiStore(join(tmp, "route"));
  let kicked = 0;
  const handle = http(makeHandler(new JobStore(join(tmp, "route-jobs")), () => {}, "x", { store, kick: () => kicked++, secret: SECRET }));
  const post = (path: string, body: unknown) =>
    handle(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  expect((await post("/omi/wrong", payload())).status).toBe(404);
  expect((await post(`/omi/${SECRET}?uid=u1`, payload())).status).toBe(200);
  expect(await (await post(`/omi/${SECRET}?uid=u1`, payload())).text()).toBe("duplicate conversation");
  expect((await post(`/omi/${SECRET}`, payload({ id: "conv-2", discarded: true }))).status).toBe(200);
  expect((await post(`/omi/${SECRET}`, payload({ id: "conv-3", structured: { title: "TV", salience: "background" } }))).status).toBe(200);
  expect((await post(`/omi/${SECRET}`, { nope: 1 })).status).toBe(422);
  expect(kicked).toBe(3);
  expect(store.conversation("conv-2")?.noteId).toBe("discarded");
  expect(store.conversation("conv-3")?.noteId).toBe("background");
  expect(store.conversation("conv-1")?.noteId).toBeUndefined();
});

// --- guard ---

function guardCtx(name: string): GuardContext {
  const vault = join(tmp, name, "vault");
  mkdirSync(join(vault, "inbox"), { recursive: true });
  mkdirSync(join(vault, "people"), { recursive: true });
  writeFileSync(join(vault, "people", "Dana Okafor.md"), "");
  writeFileSync(join(vault, "inbox", "existing.md"), "keep me");
  return { vaultDir: vault, inboxDir: join(vault, "inbox"), peopleDir: join(vault, "people"), notePrefix: "2026-11-04-14-00-00 ", workspaceId: "obsidian", created: [] };
}

test("guard: reads stay in the vault; Bash is only a quoted margins recall", () => {
  const ctx = guardCtx("g-read");
  expect(decide("Read", { file_path: join(ctx.vaultDir, "people", "Dana Okafor.md") }, ctx).allow).toBe(true);
  expect(decide("Read", { file_path: join(ctx.vaultDir, "..", "secret.env") }, ctx).allow).toBe(false);
  expect(decide("Grep", { pattern: "x", path: "/etc" }, ctx).allow).toBe(false);
  expect(decide("Glob", { pattern: "people/*.md" }, ctx).allow).toBe(true);
  expect(decide("Glob", { pattern: "/etc/*" }, ctx).allow).toBe(false);
  expect(decide("Glob", { pattern: `${ctx.vaultDir}/people/*.md` }, ctx).allow).toBe(true);
  expect(decide("Glob", { pattern: "../**/*.env", path: ctx.vaultDir }, ctx).allow).toBe(false);
  expect(decide("Glob", { pattern: "~/.ssh/*" }, ctx).allow).toBe(false);
  expect(decide("Grep", { pattern: "x", path: ctx.vaultDir, glob: "/home/**" }, ctx).allow).toBe(false);
  expect(decide("Grep", { pattern: "a/../b", path: ctx.vaultDir }, ctx).allow).toBe(true); // regex, not a path
  expect(decide("Bash", { command: 'margins --workspace obsidian recall "ring agent omi"' }, ctx).allow).toBe(true);
  for (const bad of [
    'margins --workspace obsidian recall "x"; rm -rf /', 'margins --workspace obsidian recall "$(cat ~/.env)"',
    'margins --workspace obsidian recall "x" > /tmp/y', "ls /", 'margins --workspace other recall "x"',
  ]) expect(decide("Bash", { command: bad }, ctx).allow).toBe(false);
  expect(decide("WebFetch", { url: "https://x" }, ctx).allow).toBe(false);
  expect(decide("StructuredOutput", { status: "written" }, ctx).allow).toBe(true);
});

test("guard: one new prefixed inbox note, new people only, edits only to files from this run", () => {
  const ctx = guardCtx("g-write");
  const note = join(ctx.inboxDir, "2026-11-04-14-00-00 omi ring agent.md");
  expect(decide("Write", { file_path: join(ctx.inboxDir, "existing.md") }, ctx).allow).toBe(false);
  expect(decide("Write", { file_path: join(ctx.inboxDir, "other name.md") }, ctx).allow).toBe(false);
  expect(decide("Write", { file_path: join(ctx.vaultDir, "daily", "x.md") }, ctx).allow).toBe(false);
  expect(decide("Write", { file_path: join(ctx.inboxDir, "sub", "2026-11-04-14-00-00 x.md") }, ctx).allow).toBe(false);
  const first = decide("Write", { file_path: note }, ctx);
  expect(first).toEqual({ allow: true, created: note });
  ctx.created.push(note);
  expect(decide("Write", { file_path: join(ctx.inboxDir, "2026-11-04-14-00-00 second.md") }, ctx).allow).toBe(false);
  expect(decide("Edit", { file_path: note }, ctx).allow).toBe(true);
  expect(decide("Edit", { file_path: join(ctx.inboxDir, "existing.md") }, ctx).allow).toBe(false);
  expect(decide("Edit", { file_path: join(ctx.peopleDir, "Dana Okafor.md") }, ctx).allow).toBe(false);
  // people
  expect(decide("Write", { file_path: join(ctx.peopleDir, "dana okafor.md") }, ctx).allow).toBe(false); // case clash
  expect(decide("Write", { file_path: join(ctx.peopleDir, "[[Sam Rivera.md") }, ctx).allow).toBe(false);
  expect(decide("Write", { file_path: join(ctx.peopleDir, "[].md") }, ctx).allow).toBe(false);
  expect(decide("Write", { file_path: join(ctx.peopleDir, "Édouard D'Arcy-Smith.md") }, ctx).allow).toBe(true);
  for (let i = 0; i < MAX_PEOPLE; i++) ctx.created.push(join(ctx.peopleDir, `Person ${"abc"[i]}.md`));
  expect(decide("Write", { file_path: join(ctx.peopleDir, "Mira Shah.md") }, ctx).allow).toBe(false);
});

test("guard hook records created files between calls and blocks with exit 2", async () => {
  const ctx = guardCtx("g-hook");
  const state = join(tmp, "g-hook", "guard.json");
  writeFileSync(state, JSON.stringify(ctx));
  const note = join(ctx.inboxDir, "2026-11-04-14-00-00 a.md");
  const ev = (tool: string, input: object) => JSON.stringify({ tool_name: tool, tool_input: input });
  expect(await runHook(ev("Write", { file_path: note }), { OMI_GUARD_STATE: state })).toBe(0);
  expect(await runHook(ev("Write", { file_path: join(ctx.inboxDir, "2026-11-04-14-00-00 b.md") }), { OMI_GUARD_STATE: state })).toBe(2);
  expect(await runHook(ev("Edit", { file_path: note }), { OMI_GUARD_STATE: state })).toBe(0);
  expect(await runHook("not json", { OMI_GUARD_STATE: state })).toBe(2);
  expect(await runHook(ev("Read", {}), {})).toBe(2);
});
