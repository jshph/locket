import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const stateDir = mkdtempSync(join(tmpdir(), "idx-bb-webhook-"));
process.env.INDEX_WEBHOOK_SECRET = SECRET;
process.env.STATE_FILE = join(stateDir, "deliveries.json");
process.env.MAX_SPAWNS_PER_HOUR = "6";

const { makeHandler, sign, signedBytes } = await import("./server.ts");

const prompts: string[] = [];
let spawnFails = false;
const handle = makeHandler(async (prompt) => {
  if (spawnFails) throw new Error("bb down");
  prompts.push(prompt);
  return { id: `thr_test${prompts.length}` };
});

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

async function delivery(opts: {
  transcription?: string; deliveryId?: string; isTest?: boolean; secret?: string; skewSec?: number;
} = {}) {
  const form = new FormData();
  if (opts.transcription !== undefined) form.set("transcription", opts.transcription);
  form.set("recordedAt", String(Date.now()));
  form.set("client", "ring");
  if (opts.isTest) form.set("test", "true");
  // Serialise exactly as it will go over the wire, then sign those bytes.
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data; boundary=")) throw new Error(`bad test content-type: ${contentType}`);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const timestamp = String(Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0));
  const deliveryId = opts.deliveryId ?? crypto.randomUUID();
  const trigger = opts.isTest ? "test-event" : "double-click-hold";
  const sig = sign(opts.secret ?? SECRET, signedBytes("1", timestamp, deliveryId, trigger, !!opts.isTest, body));
  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-index-webhook-version": "1",
    "x-index-trigger": trigger,
    "x-index-signature": sig,
    "x-index-timestamp": timestamp,
    "x-index-delivery": deliveryId,
  };
  if (opts.isTest) headers["x-index-test"] = "true";
  return new Request("http://localhost/index", { method: "POST", headers, body });
}

test("transcript is passed to the spawned thread verbatim", async () => {
  const transcript = "  Look through my notes from last week and draft a summary of \"Project X\";\nthen list open questions. $(not-a-command) `nor this`  ";
  const res = await handle(await delivery({ transcription: transcript }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, threadId: "thr_test1" });
  expect(prompts.at(-1)).toBe(transcript);
});

test("wrong secret is rejected and starts nothing", async () => {
  const before = prompts.length;
  expect((await handle(await delivery({ transcription: "x", secret: "wrong" }))).status).toBe(401);
  expect(prompts.length).toBe(before);
});

test("stale timestamp is rejected", async () => {
  expect((await handle(await delivery({ transcription: "x", skewSec: -600 }))).status).toBe(401);
});

test("test event verifies without starting a thread", async () => {
  const before = prompts.length;
  expect((await handle(await delivery({ transcription: "test", isTest: true }))).status).toBe(200);
  expect(prompts.length).toBe(before);
});

test("retried delivery ID does not start a second thread", async () => {
  const id = crypto.randomUUID();
  await handle(await delivery({ transcription: "Summarise today", deliveryId: id }));
  const before = prompts.length;
  expect((await handle(await delivery({ transcription: "Summarise today", deliveryId: id }))).status).toBe(200);
  expect(prompts.length).toBe(before);
});

test("spawn failure returns 502 and a retry can still succeed", async () => {
  const id = crypto.randomUUID();
  spawnFails = true;
  expect((await handle(await delivery({ transcription: "Plan my week", deliveryId: id }))).status).toBe(502);
  spawnFails = false;
  expect((await handle(await delivery({ transcription: "Plan my week", deliveryId: id }))).status).toBe(200);
});

test("audio-only payload is refused with a clear status", async () => {
  expect((await handle(await delivery({}))).status).toBe(422);
});

test("spawns are capped per hour", async () => {
  // 4 spawn attempts so far (incl. the failed one) against a cap of 6.
  expect((await handle(await delivery({ transcription: "a" }))).status).toBe(200);
  expect((await handle(await delivery({ transcription: "b" }))).status).toBe(200);
  expect((await handle(await delivery({ transcription: "c" }))).status).toBe(429);
});
