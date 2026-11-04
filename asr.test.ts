import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAsr, type Asr, type AsrResult } from "./src/asr.ts";
import { userMessage } from "./src/distill.ts";
import { OmiStore, type OmiConversation } from "./src/omi.ts";
import { ENRICH_BACKOFF_MS, enrichConversations, groupConversations, learnVoices, type OmiDeps } from "./src/omi-worker.ts";
import { JobStore } from "./src/store.ts";
import { makeHandler } from "./server.ts";

const tmp = mkdtempSync(join(tmpdir(), "asr-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MIN = 60_000;
const T0 = Date.parse("2026-11-04T19:00:00Z");

function omiConv(id: string, over: Partial<OmiConversation> = {}): OmiConversation {
  return {
    id, startedAt: T0, finishedAt: T0 + 2 * MIN, receivedAt: T0 + 2 * MIN, discarded: false,
    segments: [
      { text: "so where did you land on the scorecard thing", speaker: "SPEAKER_00", isUser: false, start: 1, end: 4 },
      { text: "the team likes it but does not trust it yet at all", speaker: "SPEAKER_01", isUser: false, start: 5, end: 9 },
    ],
    ...over,
  };
}

const ours: AsrResult = {
  covered_seconds: 110, owner_enrolled: true, run_id: "run-1",
  speakers: [
    { label: "Me", cluster: 0, seconds: 40, is_user: true, owner_source: "voiceprint", owner_score: 0.95, voice_match: null },
    { label: "Speaker A", cluster: 1, seconds: 30, is_user: false, owner_source: null, owner_score: 0.4, voice_match: { name: "Dana Okafor", score: 0.91 } },
    { label: "Speaker B", cluster: 2, seconds: 4, is_user: false, owner_source: null, owner_score: 0.3, voice_match: null },
  ],
  segments: [
    { text: "So where did you land on the scorecard thing?", speaker: "Me", is_user: true, start_ms: T0 + 1000, end_ms: T0 + 4000, cluster: 0 },
    { text: "The team likes it but doesn't trust it yet.", speaker: "Speaker A", is_user: false, start_ms: T0 + 5000, end_ms: T0 + 9000, cluster: 1 },
    { text: "Hi.", speaker: "Speaker B", is_user: false, start_ms: T0 + 9500, end_ms: T0 + 9800, cluster: 2 },
  ],
};

test("our transcript replaces Omi's when our audio covers the conversation", () => {
  const c = applyAsr(omiConv("a"), ours);
  expect(c.transcriptSource).toBe("server");
  expect(c.segments[0]).toMatchObject({ isUser: true, start: 1, end: 4 });
  expect(c.segments[1]).toMatchObject({ label: "Speaker A", voiceMatch: { name: "Dana Okafor", score: 0.91 } });
  expect(c.asr).toMatchObject({ runId: "run-1", ownerSource: "voiceprint" });
  expect(c.asr!.speakers.map((s) => s.label)).toEqual(["Me", "Speaker A", "Speaker B"]);
});

test("Omi's transcript stays for audio we never received (offline sync) or barely covered", () => {
  expect(applyAsr(omiConv("b"), { ...ours, covered_seconds: 0, segments: [], speakers: [] }).transcriptSource).toBe("omi");
  const long = omiConv("c", { segments: Array.from({ length: 40 }, (_, i) => ({ text: "lots of words spoken here by someone", speaker: "S", isUser: false, start: i * 3, end: i * 3 + 3 })) });
  expect(applyAsr(long, ours).transcriptSource).toBe("omi"); // ours has a fraction of Omi's words
});

function deps(name: string, asr: Asr): OmiDeps & { setNow: (n: number) => void } {
  let now = T0 + 3 * MIN;
  return {
    store: new OmiStore(join(tmp, name)), asr, distill: async () => ({ status: "skipped", reason: "x" }),
    notify: async () => {}, now: () => now, mergeGapMs: 10 * MIN, minWords: 5, maxNotesPerDay: 30,
    backgroundKeepOwnerWords: 60, setNow: (n: number) => (now = n),
  };
}

test("enrichment runs before grouping, and the background check uses our owner labels", async () => {
  const calls: number[][] = [];
  const asr: Asr = { process: async (s, e) => (calls.push([s, e]), ours), learn: async () => "" };
  const d = deps("e1", asr);
  d.store.saveConversation({ ...omiConv("bg", { salience: "background" }), enrich: "pending" });
  d.store.saveConversation({ ...omiConv("hl", { startedAt: T0 + 30 * MIN, finishedAt: T0 + 32 * MIN }), enrich: "pending" });
  d.setNow(T0 + 60 * MIN);
  expect(groupConversations(d)).toEqual([]); // nothing groups while enrichment is pending
  await enrichConversations(d);
  expect(calls[0]).toEqual([T0 - 3000, T0 + 2 * MIN + 3000]); // padded window
  expect(d.store.conversation("bg")).toMatchObject({ enrich: "done", noteId: "background" }); // owner said < 60 words
  expect(d.store.conversation("hl")?.noteId).toBeUndefined();
  expect(groupConversations(d).map((n) => n.conversationIds)).toEqual([["hl"]]);
});

test("enrichment failures retry, then fall back to Omi's transcript", async () => {
  const asr: Asr = { process: async () => { throw new Error("service down"); }, learn: async () => "" };
  const d = deps("e2", asr);
  d.store.saveConversation({ ...omiConv("x"), enrich: "pending" });
  let t = T0 + 3 * MIN;
  for (const wait of ENRICH_BACKOFF_MS) {
    await enrichConversations(d);
    expect(d.store.conversation("x")?.enrich).toBe("pending");
    t += wait;
    d.setNow(t);
  }
  await enrichConversations(d);
  expect(d.store.conversation("x")).toMatchObject({ enrich: "failed", transcriptSource: "omi" });
  expect(d.store.conversation("x")?.segments[0].text).toBe("so where did you land on the scorecard thing");
});

test("only strong evidence for a real person note teaches a voice", async () => {
  const learned: [string, string, number][] = [];
  const asr: Asr = { process: async () => ours, learn: async (n, r, c) => (learned.push([n, r, c]), n) };
  const d = deps("l1", asr);
  const people = join(tmp, "people");
  mkdirSync(people, { recursive: true });
  writeFileSync(join(people, "Dana Okafor.md"), "");
  writeFileSync(join(people, "Mira Castillo.md"), "");
  const conv = applyAsr(omiConv("l"), ours);
  const got = await learnVoices([conv], [
    { conversation: 1, label: "Speaker A", person: "Dana Okafor", evidence: "direct_address" },
    { conversation: 1, label: "Speaker B", person: "Mira Castillo", evidence: "self_introduction" }, // 4 s: too little
    { conversation: 1, label: "Me", person: "Sam Rivera", evidence: "omi_name" }, // never the owner
    { conversation: 1, label: "Speaker C", person: "Ghost Person", evidence: "voice_match" }, // weak evidence
    { conversation: 2, label: "Speaker A", person: "Dana Okafor", evidence: "direct_address" }, // no such section
  ], d, people);
  expect(learned).toEqual([["Dana Okafor", "run-1", 1]]);
  expect(got).toEqual(["Dana Okafor"]);
  // One label claimed as two people: ambiguous, nothing learned.
  learned.length = 0;
  await learnVoices([conv], [
    { conversation: 1, label: "Speaker A", person: "Dana Okafor", evidence: "direct_address" },
    { conversation: 1, label: "Speaker A", person: "Mira Castillo", evidence: "self_introduction" },
  ], d, people);
  expect(learned).toEqual([]);
});

test("the distiller sees voice hints and where Me came from", () => {
  const c = applyAsr(omiConv("m"), ours);
  const msg = userMessage([c], "America/Bogota");
  expect(msg).toContain("- Me: 9 words; found by voiceprint");
  expect(msg).toContain("- Speaker A: 9 words; voice resembles Dana Okafor (similarity 0.91)");
  expect(msg).toContain("Transcript from: home server");
  const two = userMessage([c, { ...c, id: "m2", startedAt: T0 + 5 * MIN, finishedAt: T0 + 6 * MIN }], "America/Bogota");
  expect(two).toContain("- Conversation 2, Speaker A:");
});

test("/stt needs the secret and a WebSocket upgrade", async () => {
  const SECRET = "omi-secret-0123456789abcdef0123";
  const handle = makeHandler(new JobStore(join(tmp, "stt-jobs")), () => {}, "x",
    { store: new OmiStore(join(tmp, "stt")), kick: () => {}, secret: SECRET, enrich: true });
  const fakeServer = { upgrade: () => false } as any;
  expect((await handle(new Request("http://localhost/stt/wrong"), fakeServer))!.status).toBe(404);
  expect((await handle(new Request(`http://localhost/stt/${SECRET}`), fakeServer))!.status).toBe(426);
  const upgrading = { upgrade: () => true } as any;
  expect(await handle(new Request(`http://localhost/stt/${SECRET}?language=en`), upgrading)).toBeUndefined();
});
