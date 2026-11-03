import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, localStamp, noteContent, writeNote } from "./src/actions.ts";
import { config } from "./src/config.ts";
import { parseActions, routerUserMessage } from "./src/router.ts";
import { JobStore, type Job } from "./src/store.ts";
import { sign, signedBytes } from "./src/webhook.ts";
import { ACTION_BACKOFF_MS, ROUTE_BACKOFF_MS, processJob, type Deps } from "./src/worker.ts";
import { makeHandler } from "./server.ts";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const tmp = mkdtempSync(join(tmpdir(), "index-agent-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function delivery(opts: { transcription?: string; id?: string; isTest?: boolean; secret?: string; skewSec?: number } = {}) {
  const form = new FormData();
  if (opts.transcription !== undefined) form.set("transcription", opts.transcription);
  form.set("recordedAt", "1793683200000");
  form.set("client", "ring");
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type")!;
  const body = new Uint8Array(await encoded.arrayBuffer());
  const ts = String(Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0));
  const id = opts.id ?? crypto.randomUUID();
  const trigger = opts.isTest ? "test-event" : "double-click-hold";
  const headers: Record<string, string> = {
    "content-type": contentType, "x-index-webhook-version": "1", "x-index-trigger": trigger,
    "x-index-timestamp": ts, "x-index-delivery": id,
    "x-index-signature": sign(opts.secret ?? SECRET, signedBytes("1", ts, id, trigger, !!opts.isTest, body)),
  };
  if (opts.isTest) headers["x-index-test"] = "true";
  return new Request("http://localhost/index", { method: "POST", headers, body });
}

// --- webhook handler ---

test("signed delivery is saved as a pending job and acknowledged at once", async () => {
  const store = new JobStore(join(tmp, "h1"));
  let kicked = 0;
  const handle = makeHandler(store, () => kicked++, SECRET);
  const req = await delivery({ transcription: "  Call the bank tomorrow  ", id: "dlv-1" });
  const res = await handle(req);
  expect(res.status).toBe(200);
  expect(kicked).toBe(1);
  const [job] = store.all();
  expect(job.id).toBe("dlv-1");
  expect(job.transcript).toBe("  Call the bank tomorrow  ");
  expect(job.recordedAt).toBe(1793683200000);
  expect(job.status).toBe("pending");
});

test("bad signature, stale timestamp, test events and duplicates create no job", async () => {
  const store = new JobStore(join(tmp, "h2"));
  const handle = makeHandler(store, () => {}, SECRET);
  expect((await handle(await delivery({ transcription: "x", secret: "wrong" }))).status).toBe(401);
  expect((await handle(await delivery({ transcription: "x", skewSec: -600 }))).status).toBe(401);
  expect((await handle(await delivery({ transcription: "x", isTest: true }))).status).toBe(200);
  expect((await handle(await delivery({}))).status).toBe(422);
  expect(store.all().length).toBe(0);
  await handle(await delivery({ transcription: "once", id: "dup" }));
  await handle(await delivery({ transcription: "once", id: "dup" }));
  expect(store.all().length).toBe(1);
});

// --- note format ---

test("note is named and formatted like the vault's quick capture notes", () => {
  const vault = join(tmp, "vault");
  mkdirSync(join(vault, "inbox"), { recursive: true });
  const opts = { ...config, vaultDir: vault, inboxDir: "inbox", localTz: "America/Bogota" };
  // 2026-11-03T05:34:12Z is 00:34:12 in New York (EST).
  const at = Date.parse("2026-11-03T05:34:12Z");
  const rel = writeNote("The gate code is 4321", "Gate code for Sam's building", at, opts);
  expect(rel).toBe("inbox/2026-11-03-00-34-12 gate code for sam's building.md");
  expect(readFileSync(join(vault, rel), "utf8")).toBe(
    "---\ntags:\n  - index\npeople:\ncreated: '[[2026-11-03]]'\n---\n\nThe gate code is 4321\n",
  );
  // Same second and title never overwrites; an empty title is just the timestamp.
  expect(writeNote("again", "Gate code for Sam's building", at, opts)).toBe("inbox/2026-11-03-00-34-12 gate code for sam's building (2).md");
  expect(writeNote("plain", "", at, opts)).toBe("inbox/2026-11-03-00-34-12.md");
});

test("titles are cleaned of path and Obsidian-special characters", () => {
  expect(cleanTitle("  Plan: Q4 / roadmap [draft] #ideas?  ")).toBe("plan q4 roadmap draft ideas");
  expect(localStamp(Date.parse("2026-07-01T16:00:00Z"), "America/Bogota").stamp).toBe("2026-07-01-12-00-00");
  expect(noteContent("hi\n\n", "2026-01-01")).toEndWith("\n\nhi\n");
});

// --- router output handling ---

test("router output is validated strictly", () => {
  expect(parseActions({ actions: [{ tool: "create_reminder", title: " Milk ", list: "Shopping", due: "" }] }))
    .toEqual([{ tool: "create_reminder", title: "Milk", list: "Shopping" }]);
  expect(() => parseActions({ actions: [{ tool: "create_calendar_event", title: "x" }] })).toThrow();
  expect(() => parseActions({ actions: [{ tool: "create_note", title: "" }] })).toThrow();
  expect(() => parseActions({})).toThrow();
  expect(routerUserMessage("hi", Date.parse("2026-11-03T05:34:00Z"), "America/Bogota"))
    .toBe("Recorded: Tuesday, November 3, 2026 at 12:34 AM (America/Bogota)\nTranscript:\nhi");
});

// --- worker ---

function harness(route: Deps["route"]) {
  const store = new JobStore(join(tmp, `w-${crypto.randomUUID()}`));
  const calls = { notes: [] as string[], tasks: [] as string[], threads: [] as string[], notified: [] as string[] };
  let clock = 1_000_000;
  let taskFailures = 0;
  const deps: Deps = {
    store, route, now: () => clock,
    effects: {
      writeNote: (t, title) => { calls.notes.push(`${title}|${t}`); return `inbox/${title || "untitled"}.md`; },
      createTask: async (a) => { if (taskFailures-- > 0) throw new Error("todoist down"); calls.tasks.push(a.title); return a.title; },
      spawnThread: async (p) => { calls.threads.push(p); return "thr_x"; },
    },
    notify: async (title, msg) => { calls.notified.push(`${title}: ${msg}`); },
  };
  const job: Job = {
    id: "j1", trigger: "double-click-hold", transcript: "Remind me to call the bank, and look into flights",
    recordedAt: clock, receivedAt: clock, status: "pending", nextAttemptAt: clock, routeAttempts: 0,
  };
  store.save(job);
  return {
    store, calls, deps, job: () => store.all()[0],
    advance: (ms: number) => { clock += ms; },
    failTasks: (n: number) => { taskFailures = n; },
  };
}

test("routed actions run once each; threads get the transcript verbatim", async () => {
  const h = harness(async () => [
    { tool: "create_reminder", title: "Call the bank" },
    { tool: "start_thread", title: "flight research" },
  ]);
  await processJob(h.job(), h.deps);
  expect(h.calls.tasks).toEqual(["Call the bank"]);
  expect(h.calls.threads).toEqual(["Remind me to call the bank, and look into flights"]);
  expect(h.calls.notes).toEqual([]);
  expect(h.job().status).toBe("done");
  expect(h.calls.notified).toEqual(["Index: Todoist: Call the bank\nThread: flight research"]);
});

test("an empty plan still captures the words as a note", async () => {
  const h = harness(async () => []);
  await processJob(h.job(), h.deps);
  expect(h.calls.notes).toEqual(["|Remind me to call the bank, and look into flights"]);
});

test("router failures retry with backoff, then fall back to a note", async () => {
  const h = harness(async () => { throw new Error("usage limit"); });
  for (let i = 0; i < ROUTE_BACKOFF_MS.length; i++) {
    await processJob(h.job(), h.deps);
    expect(h.job().status).toBe("pending");
    expect(h.job().nextAttemptAt).toBe(1_000_000 + ROUTE_BACKOFF_MS.slice(0, i).reduce((a, b) => a + b, 0) + ROUTE_BACKOFF_MS[i]);
    h.advance(ROUTE_BACKOFF_MS[i]);
  }
  await processJob(h.job(), h.deps);
  expect(h.job().routedBy).toBe("fallback");
  expect(h.calls.notes.length).toBe(1);
  expect(h.calls.notified[0]).toStartWith("Index: needs attention: Router unavailable");
});

test("a failing action is retried without repeating finished ones", async () => {
  const h = harness(async () => [
    { tool: "start_thread", title: "flights" },
    { tool: "create_reminder", title: "Call the bank" },
  ]);
  h.failTasks(2);
  await processJob(h.job(), h.deps);
  expect(h.job().status).toBe("pending");
  h.advance(ACTION_BACKOFF_MS[0]);
  await processJob(h.job(), h.deps);
  h.advance(ACTION_BACKOFF_MS[1]);
  await processJob(h.job(), h.deps);
  expect(h.calls.threads.length).toBe(1);
  expect(h.calls.tasks).toEqual(["Call the bank"]);
  expect(h.job().status).toBe("done");
});

test("an action that fails for good leaves the words in a fallback note and alerts", async () => {
  const h = harness(async () => [{ tool: "create_reminder", title: "Call the bank" }]);
  h.failTasks(99);
  for (const wait of [0, ...ACTION_BACKOFF_MS]) {
    h.advance(wait);
    await processJob(h.job(), h.deps);
  }
  const job = h.job();
  expect(job.status).toBe("done");
  expect(job.plan![0].status).toBe("failed");
  expect(job.fallbackNote).toBe("inbox/untitled.md");
  expect(h.calls.notified[0]).toContain("Couldn't create Todoist task: Call the bank");
});
