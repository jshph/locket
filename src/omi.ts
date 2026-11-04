// Omi "Conversation created" webhook: payload parsing, the on-disk store, and how nearby
// conversations are merged into one note. Omi's backend POSTs the finished conversation (full
// diarized transcript) once; it retries only on 5xx/408/429/timeouts and disables the webhook
// after 100 consecutive failures, so the endpoint acknowledges as soon as the JSON is saved and
// all distillation problems stay on this side.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type OmiSegment = {
  text: string;
  speaker: string;
  isUser: boolean;
  /** A person the user named in Omi (the segment has a person_id). */
  name?: string;
  /** Omi's (or the speech service's) neutral label for an unnamed voice, e.g. "Speaker A". */
  label?: string;
  /** The speech service thinks this voice is a known person: a hint, not an identification. */
  voiceMatch?: { name: string; score: number };
  start: number;
  end: number;
};

export type AsrInfo = {
  runId?: string;
  ownerEnrolled: boolean;
  /** How "Me" was found: "voiceprint", "loudest voice (owner not enrolled)", or null if not found. */
  ownerSource: string | null;
  speakers: { label: string; cluster: number; seconds: number; isUser: boolean; voiceMatch: { name: string; score: number } | null }[];
};

export type OmiConversation = {
  id: string;
  startedAt: number;
  finishedAt: number;
  receivedAt: number;
  discarded: boolean;
  /** Omi's label: "highlight" (owner engaged) or "background" (TV, ambient, others talking). */
  salience?: string;
  omiTitle?: string;
  segments: OmiSegment[];
  /** The note job this conversation was assigned to, once grouped. */
  noteId?: string;
  /**
   * Re-transcription from our own stored audio (src/asr.ts): "pending" until tried, then "done"
   * or "failed" (Omi's transcript is kept). Absent when the speech service is off.
   */
  enrich?: "pending" | "done" | "failed";
  enrichAttempts?: number;
  enrichNextAt?: number;
  transcriptSource?: "server" | "omi";
  asr?: AsrInfo;
};

export type NoteJob = {
  id: string;
  conversationIds: string[];
  status: "pending" | "done" | "skipped" | "failed";
  createdAt: number;
  nextAttemptAt: number;
  attempts: number;
  notePath?: string;
  title?: string;
  reason?: string;
  error?: string;
  finishedAt?: number;
};

function ms(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Validates an Omi conversation payload; returns an error string for anything unusable. */
export function parseOmiPayload(body: unknown, receivedAt: number): OmiConversation | string {
  if (!body || typeof body !== "object") return "body is not a JSON object";
  const b = body as Record<string, any>;
  if (typeof b.id !== "string" || !b.id.trim()) return "missing conversation id";
  const startedAt = ms(b.started_at) ?? ms(b.created_at);
  const finishedAt = ms(b.finished_at) ?? startedAt;
  if (startedAt === null || finishedAt === null) return "missing started_at";
  if (!Array.isArray(b.transcript_segments)) return "missing transcript_segments";
  const segments: OmiSegment[] = b.transcript_segments.flatMap((s: any) => {
    if (!s || typeof s.text !== "string" || !s.text.trim()) return [];
    const speakerNum = typeof s.speakerId === "number" ? s.speakerId : typeof s.speaker_id === "number" ? s.speaker_id : null;
    // Omi fills speaker_name for every segment: the owner's name, a named person (only when
    // person_id is set), or a neutral "Speaker A". Only a person_id makes it an identity.
    const shown = typeof s.speaker_name === "string" && s.speaker_name.trim() ? s.speaker_name.trim() : undefined;
    const named = s.is_user !== true && Boolean(s.person_id) && shown;
    return [{
      text: s.text.trim(),
      speaker: typeof s.speaker === "string" ? s.speaker : speakerNum !== null ? `SPEAKER_${String(speakerNum).padStart(2, "0")}` : "SPEAKER",
      isUser: s.is_user === true,
      name: named ? shown : undefined,
      label: !named && s.is_user !== true && shown && /^Speaker [A-Z]+$/.test(shown) ? shown : undefined,
      start: Number(s.start) || 0,
      end: Number(s.end) || Number(s.start) || 0,
    }];
  });
  return {
    id: b.id.trim(),
    startedAt,
    finishedAt: Math.max(finishedAt, startedAt),
    receivedAt,
    discarded: b.discarded === true,
    salience: typeof b.structured?.salience === "string" ? b.structured.salience : undefined,
    omiTitle: typeof b.structured?.title === "string" ? b.structured.title : undefined,
    segments,
  };
}

export function wordCount(c: OmiConversation, onlyOwner = false): number {
  return c.segments.filter((s) => !onlyOwner || s.isUser)
    .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
}

/**
 * Why a conversation should never be distilled or merged, or null to keep it. Omi's discards are
 * dropped. So is "background" (Omi saw the owner not engaged: TV, ambient chatter, other people),
 * which would otherwise chain unrelated conversations together, unless the owner still said at
 * least [ownerWordsToKeep] words, in case Omi misjudged solo thinking out loud.
 */
export function exclusionReason(c: OmiConversation, ownerWordsToKeep: number): "discarded" | "background" | null {
  if (c.discarded) return "discarded";
  if (c.salience === "background" && wordCount(c, true) < ownerWordsToKeep) return "background";
  return null;
}

/** "Me" for the device owner, the name the user gave a voice in Omi, else Omi's "Speaker A". */
export function speakerLabel(s: OmiSegment): string {
  if (s.isUser) return "Me";
  if (s.name) return s.name;
  if (s.label) return s.label;
  const n = s.speaker.match(/(\d+)$/);
  return n ? `Speaker ${Number(n[1]) + 1}` : "Unknown speaker";
}

function clock(msValue: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(msValue));
}

/** One timestamped line per speaker turn (consecutive segments by one speaker are joined). */
export function renderTranscript(convs: OmiConversation[], tz: string): string {
  const out: string[] = [];
  convs.forEach((c, i) => {
    out.push(`## Conversation ${i + 1}: ${clock(c.startedAt, tz)}–${clock(c.finishedAt, tz)}`);
    let last: { label: string; line: string } | null = null;
    for (const s of c.segments) {
      const label = speakerLabel(s);
      if (last && last.label === label) {
        last.line += ` ${s.text}`;
        continue;
      }
      if (last) out.push(last.line);
      last = { label, line: `[${clock(c.startedAt + s.start * 1000, tz)}] ${label}: ${s.text}` };
    }
    if (last) out.push(last.line);
    out.push("");
  });
  return out.join("\n").trim();
}

/**
 * Splits ungrouped conversations into chains where each starts within [gapMs] of the previous
 * one's end, and returns the chains that are closed: nothing new has arrived for [gapMs] and the
 * last conversation ended at least [gapMs] ago, so a following conversation is unlikely to join.
 * Discarded conversations never join a chain.
 */
export function readyGroups(convs: OmiConversation[], nowMs: number, gapMs: number): OmiConversation[][] {
  const open = convs.filter((c) => !c.noteId && !c.discarded).sort((a, b) => a.startedAt - b.startedAt);
  const chains: OmiConversation[][] = [];
  for (const c of open) {
    const chain = chains.at(-1);
    const prevEnd = chain ? Math.max(...chain.map((x) => x.finishedAt)) : -Infinity;
    if (chain && c.startedAt - prevEnd <= gapMs) chain.push(c);
    else chains.push([c]);
  }
  return chains.filter((chain) => {
    const lastEnd = Math.max(...chain.map((x) => x.finishedAt));
    const lastReceived = Math.max(...chain.map((x) => x.receivedAt));
    return nowMs - lastEnd >= gapMs && nowMs - lastReceived >= gapMs;
  });
}

const KEEP_MS = 30 * 24 * 3600_000;

/** state/omi/conversations/<id>.json (the raw transcript, kept out of the vault) and notes/<id>.json. */
export class OmiStore {
  private convDir: string;
  private noteDir: string;

  constructor(stateDir: string) {
    this.convDir = join(stateDir, "omi", "conversations");
    this.noteDir = join(stateDir, "omi", "notes");
    mkdirSync(this.convDir, { recursive: true });
    mkdirSync(this.noteDir, { recursive: true });
  }

  private file(dir: string, id: string) {
    return join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  private write(p: string, value: unknown) {
    writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  private readAll<T>(dir: string): T[] {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8")) as T];
      } catch {
        return [];
      }
    });
  }

  hasConversation(id: string) {
    return existsSync(this.file(this.convDir, id));
  }
  saveConversation(c: OmiConversation) {
    this.write(this.file(this.convDir, c.id), c);
  }
  conversations(): OmiConversation[] {
    return this.readAll<OmiConversation>(this.convDir);
  }
  conversation(id: string): OmiConversation | null {
    try {
      return JSON.parse(readFileSync(this.file(this.convDir, id), "utf8"));
    } catch {
      return null;
    }
  }

  saveNote(n: NoteJob) {
    this.write(this.file(this.noteDir, n.id), n);
  }
  notes(): NoteJob[] {
    return this.readAll<NoteJob>(this.noteDir);
  }
  note(id: string): NoteJob | null {
    try {
      return JSON.parse(readFileSync(this.file(this.noteDir, id), "utf8"));
    } catch {
      return null;
    }
  }

  /** Drops transcripts and finished note jobs after 30 days. */
  prune(nowMs: number) {
    for (const dir of [this.convDir, this.noteDir]) {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          if (nowMs - statSync(p).mtimeMs <= KEEP_MS) continue;
          if (dir === this.noteDir && JSON.parse(readFileSync(p, "utf8")).status === "pending") continue;
          if (dir === this.convDir && !JSON.parse(readFileSync(p, "utf8")).noteId) continue;
          unlinkSync(p);
        } catch {
          // Ignore unreadable or concurrently replaced files.
        }
      }
    }
  }
}
