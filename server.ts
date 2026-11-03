// Receives Pebble Index 01 webhook deliveries (protocol v1) and starts a new bb thread in the
// Obsidian project with the transcript, verbatim, as the prompt.
// Webhook spec: experimental/.../indexwebhook/INDEX_WEBHOOK_API.md in github.com/coredevices/mobileapp.

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";
const SECRET = process.env.INDEX_WEBHOOK_SECRET ?? "";
const BB = process.env.BB_BIN ?? "bb";
const BB_PROJECT = process.env.BB_PROJECT ?? "proj_xxxxxxxxxx"; // obsidian
const BB_ENVIRONMENT = process.env.BB_ENVIRONMENT ?? "env_xxxxxxxxxx"; // /path/to/vault
const BB_PERMISSION_MODE = process.env.BB_PERMISSION_MODE ?? "auto";
const MAX_SPAWNS_PER_HOUR = Number(process.env.MAX_SPAWNS_PER_HOUR ?? 30);
const STATE_FILE = process.env.STATE_FILE ?? "./state/deliveries.json";
const MAX_SKEW_SEC = 300;
// Deliveries are remembered well past the signature window so an app-side retry of a recording
// that already started a thread does not start a second one.
const DELIVERY_TTL_SEC = 7 * 24 * 3600;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function signedBytes(
  version: string, timestamp: string, deliveryId: string, trigger: string, isTest: boolean,
  body: Uint8Array,
): Buffer {
  const prefix = `v${version}\n${timestamp}\n${deliveryId}\n${trigger}\n${isTest ? 1 : 0}\n`;
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(body)]);
}

export function sign(secret: string, bytes: Buffer): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(bytes).digest("hex");
}

export function signatureMatches(expectedHex: string, givenHex: string): boolean {
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(givenHex.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type Deliveries = Record<string, { at: number; threadId?: string }>;

function loadDeliveries(): Deliveries {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveDeliveries(d: Deliveries) {
  const now = Date.now() / 1000;
  for (const [id, v] of Object.entries(d)) if (now - v.at > DELIVERY_TTL_SEC) delete d[id];
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(d));
  renameSync(tmp, STATE_FILE);
}

const deliveries = loadDeliveries();
const recentSpawns: number[] = [];

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

export type Spawner = (prompt: string) => Promise<{ id: string }>;

/** Starts a bb thread with [prompt] passed on stdin, so it reaches the agent byte-for-byte. */
export const bbSpawn: Spawner = async (prompt) => {
  const proc = Bun.spawn(
    [BB, "thread", "spawn", "--project", BB_PROJECT, "--environment", BB_ENVIRONMENT,
      "--permission-mode", BB_PERMISSION_MODE, "--prompt-file", "-", "--json"],
    { stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`bb exited ${code}: ${(err || out).slice(0, 400)}`);
  const id = JSON.parse(out)?.id;
  if (!id) throw new Error(`bb returned no thread id: ${out.slice(0, 200)}`);
  return { id };
};

export function makeHandler(spawn: Spawner = bbSpawn) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (req.method !== "POST" || url.pathname !== "/index") return new Response("not found", { status: 404 });

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return new Response("too large", { status: 413 });

    const version = req.headers.get("x-index-webhook-version") ?? "";
    const signature = req.headers.get("x-index-signature") ?? "";
    const timestamp = req.headers.get("x-index-timestamp") ?? "";
    const deliveryId = req.headers.get("x-index-delivery") ?? "";
    const trigger = req.headers.get("x-index-trigger") ?? "";
    const isTest = req.headers.get("x-index-test") === "true";

    if (version !== "1") return new Response("unsupported webhook version", { status: 400 });
    if (!signature || !deliveryId) return new Response("unsigned request", { status: 401 });
    const ts = Number(timestamp);
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SEC) {
      return new Response("expired or malformed timestamp", { status: 401 });
    }

    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) return new Response("too large", { status: 413 });
    const expected = sign(SECRET, signedBytes(version, timestamp, deliveryId, trigger, isTest, raw));
    if (!signatureMatches(expected, signature)) {
      log("rejected: bad signature", { trigger });
      return new Response("invalid signature", { status: 401 });
    }

    if (deliveries[deliveryId]) {
      log("duplicate delivery ignored", { deliveryId, threadId: deliveries[deliveryId].threadId });
      return new Response("duplicate delivery", { status: 200 });
    }

    let form: FormData;
    try {
      const contentType = req.headers.get("content-type") ?? "";
      form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    } catch (e) {
      log("unparseable multipart body", { bytes: raw.byteLength, error: String(e) });
      return new Response("unparseable body", { status: 400 });
    }
    const transcription = String(form.get("transcription") ?? "");

    if (isTest) {
      log("test event verified", { trigger });
      return new Response("ok (test event verified, no thread started)");
    }
    if (!transcription.trim()) {
      log("no transcription in payload; set payload mode to 'Transcription only' or 'Both'", { trigger });
      return new Response("no transcription", { status: 422 });
    }

    const hourAgo = Date.now() - 3600_000;
    while (recentSpawns.length && recentSpawns[0] < hourAgo) recentSpawns.shift();
    if (recentSpawns.length >= MAX_SPAWNS_PER_HOUR) {
      log("rate limited", { trigger });
      return new Response("rate limited", { status: 429 });
    }

    try {
      recentSpawns.push(Date.now());
      const thread = await spawn(transcription);
      deliveries[deliveryId] = { at: Date.now() / 1000, threadId: thread.id };
      saveDeliveries(deliveries);
      log("thread started", { trigger, threadId: thread.id, chars: transcription.length });
      return Response.json({ ok: true, threadId: thread.id });
    } catch (e) {
      // Not recorded as delivered, so an app retry with the same delivery ID can still succeed.
      log("bb spawn failed", { trigger, error: String(e) });
      return new Response("spawn failed", { status: 502 });
    }
  };
}

if (import.meta.main) {
  if (!SECRET) {
    console.error("INDEX_WEBHOOK_SECRET must be set");
    process.exit(1);
  }
  Bun.serve({ port: PORT, hostname: HOST, maxRequestBodySize: MAX_BODY_BYTES, fetch: makeHandler() });
  log("listening", { host: HOST, port: PORT, project: BB_PROJECT, environment: BB_ENVIRONMENT });
}
