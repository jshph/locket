// Index 01 ring webhook -> agent. Verifies each signed delivery, saves it as a job, answers the
// phone immediately, then routes the transcript with `claude -p` into vault notes, Todoist tasks
// and bb threads (see src/worker.ts). Omi conversations arrive at /omi/<secret> and become
// distilled, connected notes (see src/omi-worker.ts and src/distill.ts).

import { createTodoistTask, spawnThread, writeNote } from "./src/actions.ts";
import { calendarConfigured, createCalendarEvent, finishGoogleAuth } from "./src/google.ts";
import { childEnv, config, configProblems, MIN_OMI_SECRET_LENGTH } from "./src/config.ts";
import { ntfyNotifier } from "./src/notify.ts";
import { claudeRouter } from "./src/router.ts";
import { JobStore } from "./src/store.ts";
import { verifyDelivery, MAX_BODY_BYTES } from "./src/webhook.ts";
import { startWorker, type Deps } from "./src/worker.ts";
import { claudeDistiller } from "./src/distill.ts";
import { exclusionReason, OmiStore, parseOmiPayload } from "./src/omi.ts";
import { startOmiWorker } from "./src/omi-worker.ts";
import { asrAvailable, localAsr, startAsrService, sttWebsocket, upgradeStt } from "./src/asr.ts";
import type { Server } from "bun";
import { timingSafeEqual } from "node:crypto";

import { log } from "./src/util.ts";

export type OmiRoute = { store: OmiStore; kick: () => void; secret: string; backgroundKeepOwnerWords?: number; enrich?: boolean };

function secretMatches(expected: string, given: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return expected.length >= MIN_OMI_SECRET_LENGTH && a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Omi "Conversation created" webhook at /omi/<secret>. Omi doesn't sign requests, so the secret
 * path is the credential. Save, then answer 200 at once: Omi never retries 4xx and disables the
 * webhook after 100 failures, so only an unusable request gets an error.
 */
export async function handleOmi(req: Request, url: URL, omi: OmiRoute): Promise<Response> {
  if (!secretMatches(omi.secret, url.pathname.slice("/omi/".length))) return new Response("not found", { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    log("omi rejected", { reason: "invalid JSON" });
    return new Response("invalid JSON", { status: 400 });
  }
  const conv = parseOmiPayload(body, Date.now());
  if (typeof conv === "string") {
    log("omi rejected", { reason: conv });
    return new Response(conv, { status: 422 });
  }
  if (omi.store.hasConversation(conv.id)) {
    log("omi duplicate ignored", { id: conv.id });
    return new Response("duplicate conversation");
  }
  // Excluded conversations (Omi discarded them, or background) are kept only for dedupe: never
  // distilled, and never merged, so ambient TV can't chain two real conversations into one note.
  // With the speech service on, the background check waits for our re-transcription (it needs to
  // know which lines are the owner's), so only Omi's discards are settled here.
  const excluded = omi.enrich
    ? (conv.discarded ? "discarded" : null)
    : exclusionReason(conv, omi.backgroundKeepOwnerWords ?? config.omiBackgroundKeepOwnerWords);
  omi.store.saveConversation(excluded ? { ...conv, noteId: excluded } : omi.enrich ? { ...conv, enrich: "pending" } : conv);
  log(excluded ? "omi excluded" : "omi queued", { id: conv.id, segments: conv.segments.length, salience: conv.salience, excluded });
  omi.kick();
  return Response.json({ ok: true, queued: conv.id });
}

export function makeHandler(store: JobStore, kick: () => void, secret = config.webhookSecret, omi?: OmiRoute) {
  return async function handle(req: Request, server?: Server<any>): Promise<Response | undefined> {
    const url = new URL(req.url);
    // The Omi app's Custom live transcription (WebSocket), piped to the local speech service.
    if (omi?.enrich && server && req.method === "GET" && url.pathname.startsWith("/stt/")) {
      if (!secretMatches(omi.secret, url.pathname.slice("/stt/".length))) return new Response("not found", { status: 404 });
      if (upgradeStt(req, server, url)) {
        log("stt connected");
        return undefined;
      }
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    if (req.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (req.method === "GET" && url.pathname === "/oauth/google/callback") return finishGoogleAuth(url);
    if (omi && req.method === "POST" && url.pathname.startsWith("/omi/")) return handleOmi(req, url, omi);
    if (req.method !== "POST" || url.pathname !== "/index") return new Response("not found", { status: 404 });

    const delivery = await verifyDelivery(req, secret);
    if (delivery instanceof Response) {
      log("rejected", { status: delivery.status });
      return delivery;
    }
    if (delivery.kind === "test") {
      log("test event verified", { trigger: delivery.trigger });
      return new Response("ok (test event verified)");
    }
    if (store.has(delivery.id)) {
      log("duplicate delivery ignored", { id: delivery.id });
      return new Response("duplicate delivery");
    }
    const now = Date.now();
    store.save({
      id: delivery.id, trigger: delivery.trigger, transcript: delivery.transcription,
      recordedAt: delivery.recordedAt, receivedAt: now, status: "pending", nextAttemptAt: now,
      routeAttempts: 0,
    });
    log("queued", { id: delivery.id, trigger: delivery.trigger, chars: delivery.transcription.length });
    kick();
    return Response.json({ ok: true, queued: delivery.id });
  };
}

async function selfCheck() {
  for (const [name, cmd] of [["claude", [config.claudeBin, "--version"]], ["bb", [config.bbBin, "--version"]]] as const) {
    try {
      const p = Bun.spawn([...cmd], { env: childEnv(), stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(p.stdout).text()).trim();
      if ((await p.exited) !== 0) throw new Error("non-zero exit");
      log("self-check ok", { name, version: out.split("\n")[0] });
    } catch (e) {
      log("self-check failed", { name, error: String(e) });
      await ntfyNotifier("Index: needs attention", `${name} is not runnable on the server: ${e}`, { urgent: true });
    }
  }
}

if (import.meta.main) {
  if (!config.webhookSecret) {
    console.error("INDEX_WEBHOOK_SECRET must be set");
    process.exit(1);
  }
  const store = new JobStore(config.stateDir);
  const deps: Deps = {
    store,
    route: claudeRouter,
    effects: { writeNote, createTask: createTodoistTask, spawnThread, createEvent: createCalendarEvent },
    notify: ntfyNotifier,
  };
  const worker = startWorker(deps);
  const problems = configProblems();
  for (const p of problems) log("config problem", { problem: p });
  if (problems.length) void ntfyNotifier("Index: needs attention", problems.join("\n"), { urgent: true });
  const omiOn = config.omiWebhookSecret.length >= MIN_OMI_SECRET_LENGTH;
  const omiStore = new OmiStore(config.stateDir);
  const speech = omiOn && config.asrEnabled && asrAvailable() ? startAsrService(ntfyNotifier) : null;
  const omiWorker = omiOn
    ? startOmiWorker({
      store: omiStore, distill: claudeDistiller, notify: ntfyNotifier,
      mergeGapMs: config.omiMergeGapMs, minWords: config.omiMinWords, maxNotesPerDay: config.omiMaxNotesPerDay,
      backgroundKeepOwnerWords: config.omiBackgroundKeepOwnerWords, asr: speech ? localAsr : undefined,
    })
    : null;
  const omi = omiWorker
    ? { store: omiStore, kick: omiWorker.kick, secret: config.omiWebhookSecret, enrich: Boolean(speech) }
    : undefined;
  setInterval(() => {
    store.prune(Date.now());
    omiStore.prune(Date.now());
  }, 6 * 3600_000);
  const server = Bun.serve({
    port: config.port, hostname: config.host, maxRequestBodySize: MAX_BODY_BYTES,
    fetch: makeHandler(store, worker.kick, config.webhookSecret, omi) as (req: Request, server: Server<any>) => Promise<Response | undefined>,
    websocket: sttWebsocket,
  });
  // Restarts are a plain SIGTERM (see scripts/restart.sh); systemd's Restart=always brings the
  // service back on the current code. Finish the job in progress first; saved jobs resume after.
  process.on("SIGTERM", async () => {
    log("stopping: finishing the job in progress");
    server.stop();
    await Promise.race([Promise.all([worker.stop(), omiWorker?.stop()]), Bun.sleep(25_000)]);
    speech?.stop();
    process.exit(0);
  });
  log("listening", { host: config.host, port: config.port, model: config.claudeModel, tz: config.localTz, calendar: calendarConfigured(), omi: Boolean(omi), speech: Boolean(speech) });
  void selfCheck();
}
