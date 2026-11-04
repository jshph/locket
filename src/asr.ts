// The local speech service (asr/service.py): started and restarted by this process, reached over
// localhost. The Omi app's Custom live transcription connects to /stt/<secret> here and is piped
// through to it, and after Omi closes a conversation the service's /process re-transcribes and
// diarizes that window from the audio it stored, labeling the owner by voiceprint.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { config } from "./config.ts";
import type { OmiConversation, OmiSegment } from "./omi.ts";

export type AsrSpeaker = {
  label: string;
  cluster: number;
  seconds: number;
  is_user: boolean;
  owner_source: string | null;
  owner_score: number | null;
  voice_match: { name: string; score: number } | null;
};

export type AsrResult = {
  covered_seconds: number;
  owner_enrolled: boolean;
  run_id?: string;
  speakers: AsrSpeaker[];
  segments: { text: string; speaker: string; is_user: boolean; start_ms: number; end_ms: number; cluster: number }[];
};

export type Asr = {
  process: (startMs: number, endMs: number) => Promise<AsrResult>;
  learn: (name: string, runId: string, cluster: number) => Promise<string>;
};

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

const base = () => `http://127.0.0.1:${config.asrPort}`;

async function post(path: string, body: unknown, timeoutMs: number) {
  const res = await fetch(base() + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export const localAsr: Asr = {
  async process(startMs, endMs) {
    // Roughly 0.2x real time on this CPU; allow a long conversation plenty of room.
    const r = await post("/process", { start_ms: startMs, end_ms: endMs }, Math.max(120_000, (endMs - startMs) * 0.6));
    if (!r.ok) throw new Error(`speech service /process HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json as AsrResult;
  },
  async learn(name, runId, cluster) {
    const r = await post("/voices/learn", { name, run_id: runId, cluster }, 30_000);
    if (!r.ok) throw new Error(String(r.json?.error ?? `HTTP ${r.status}`));
    return `${name} (${r.json.samples} sample${r.json.samples === 1 ? "" : "s"})`;
  },
};

/** Spoken words in the transcript Omi sent, and in ours, decide which one to trust. */
function words(texts: string[]) {
  return texts.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0);
}

/**
 * Replaces Omi's transcript with the speech service's when our stored audio really covers the
 * conversation. Recordings the pendant stored offline are transcribed by Omi and aren't in our
 * audio, so those keep Omi's transcript (and speakers).
 */
export function applyAsr(conv: OmiConversation, r: AsrResult): OmiConversation {
  const omiWords = words(conv.segments.map((s) => s.text));
  const ourWords = words(r.segments.map((s) => s.text));
  const omiSpeech = conv.segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0);
  const covers = r.segments.length > 0 && r.covered_seconds >= Math.max(3, 0.3 * omiSpeech) && ourWords >= 0.4 * omiWords;
  if (!covers) return { ...conv, transcriptSource: "omi" };
  const byCluster = new Map(r.speakers.map((s) => [s.cluster, s]));
  const segments: OmiSegment[] = r.segments.map((s) => {
    const sp = byCluster.get(s.cluster);
    return {
      text: s.text,
      speaker: s.is_user ? "OWNER" : s.speaker,
      isUser: s.is_user,
      label: s.is_user ? undefined : s.speaker,
      start: Math.max(0, (s.start_ms - conv.startedAt) / 1000),
      end: Math.max(0, (s.end_ms - conv.startedAt) / 1000),
      ...(sp?.voice_match && !s.is_user ? { voiceMatch: sp.voice_match } : {}),
    };
  });
  const owner = r.speakers.find((s) => s.is_user);
  return {
    ...conv,
    segments,
    transcriptSource: "server",
    asr: {
      runId: r.run_id,
      ownerEnrolled: r.owner_enrolled,
      ownerSource: owner?.owner_source ?? null,
      speakers: r.speakers.map((s) => ({ label: s.is_user ? "Me" : s.label, cluster: s.cluster, seconds: s.seconds, isUser: s.is_user, voiceMatch: s.voice_match })),
    },
  };
}

// --- the process ---

export function asrAvailable() {
  return existsSync(config.asrPython) && existsSync(join(config.asrDir, "service.py"));
}

/** Runs asr/service.py and restarts it if it exits; stop() ends it for good. */
export function startAsrService() {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const start = () => {
    proc = Bun.spawn([config.asrPython, "service.py"], {
      cwd: config.asrDir,
      env: {
        HOME: process.env.HOME ?? "/home/you", PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8",
        STATE_DIR: resolve(config.stateDir), OMI_ASR_PORT: String(config.asrPort),
        OMI_AUDIO_RETENTION_DAYS: String(config.omiAudioRetentionDays),
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^OMI_(OWNER|PERSON|VOICE|DIARIZE|ASR_THREADS)/.test(k)) as [string, string][]),
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.exited.then((code) => {
      if (stopping) return;
      log("speech service exited, restarting", { code });
      setTimeout(start, 5_000);
    });
  };
  start();
  return {
    stop: () => {
      stopping = true;
      proc?.kill();
    },
  };
}

// --- the public WebSocket, piped to the service ---

type SttSocketData = { query: string; upstream?: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[]; queued: number };
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export function upgradeStt(req: Request, server: Server, url: URL): boolean {
  return server.upgrade(req, { data: { query: url.search, queue: [], queued: 0 } satisfies SttSocketData });
}

export const sttWebsocket = {
  idleTimeout: 120,
  maxPayloadLength: 8 * 1024 * 1024,
  open(ws: ServerWebSocket<SttSocketData>) {
    const up = new WebSocket(`ws://127.0.0.1:${config.asrPort}/stt${ws.data.query}`);
    up.binaryType = "arraybuffer";
    ws.data.upstream = up;
    up.onopen = () => {
      for (const m of ws.data.queue) up.send(m);
      ws.data.queue = [];
      ws.data.queued = 0;
    };
    up.onmessage = (e) => ws.send(e.data as string);
    up.onclose = () => ws.close();
    up.onerror = () => {
      log("speech service connection failed");
      ws.close(1011, "speech service unavailable");
    };
  },
  message(ws: ServerWebSocket<SttSocketData>, msg: string | Buffer) {
    const up = ws.data.upstream;
    const data = typeof msg === "string" ? msg : new Uint8Array(msg);
    if (up?.readyState === WebSocket.OPEN) return up.send(data);
    ws.data.queued += typeof data === "string" ? data.length : data.byteLength;
    if (ws.data.queued > MAX_QUEUED_BYTES) return ws.close(1011, "speech service not ready");
    ws.data.queue.push(data);
  },
  close(ws: ServerWebSocket<SttSocketData>) {
    const up = ws.data.upstream;
    if (up && up.readyState <= WebSocket.OPEN) up.close();
  },
};
