// Turns saved Omi conversations into notes: merge conversations that follow each other closely,
// drop fragments too short to distill, then run the distiller one note at a time with retries.
// A failure never falls back to dumping the raw transcript into the vault; the transcript stays in
// state/omi/ and the user gets an urgent ntfy.

import type { Notifier } from "./notify.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { LEARNABLE_EVIDENCE, type Distiller, type SpeakerIdentity } from "./distill.ts";
import { applyAsr, type Asr } from "./asr.ts";
import { exclusionReason, readyGroups, wordCount, type NoteJob, type OmiConversation, type OmiStore } from "./omi.ts";

export type OmiDeps = {
  store: OmiStore;
  distill: Distiller;
  notify: Notifier;
  now?: () => number;
  mergeGapMs: number;
  minWords: number;
  maxNotesPerDay: number;
  /** The local speech service; when set, conversations are re-transcribed before grouping. */
  asr?: Asr;
  backgroundKeepOwnerWords?: number;
};

export const ENRICH_BACKOFF_MS = [30_000, 120_000, 600_000];
// Omi's conversation times and our audio clock can differ by a few seconds.
const WINDOW_PAD_MS = 3_000;

export const DISTILL_BACKOFF_MS = [120_000, 600_000, 3_600_000, 3 * 3_600_000];
const DAY_MS = 24 * 3600_000;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

/** Excluded conversations get a noteId of "discarded"/"background" so they never merge. */
function settle(c: OmiConversation, deps: OmiDeps): OmiConversation {
  const excluded = exclusionReason(c, deps.backgroundKeepOwnerWords ?? 60);
  if (excluded) log("omi excluded", { id: c.id, excluded, transcript: c.transcriptSource });
  return excluded ? { ...c, noteId: excluded } : c;
}

/**
 * Re-transcribes each new conversation from our stored audio: diarized, with "Me" found by the
 * owner's voiceprint and hints for known voices. Runs before exclusion, because Omi's
 * owner-engagement label depends on who spoke. If the service keeps failing, Omi's transcript stands.
 */
export async function enrichConversations(deps: OmiDeps): Promise<void> {
  if (!deps.asr) return;
  const now = (deps.now ?? Date.now)();
  const due = deps.store.conversations().filter((c) => c.enrich === "pending" && (c.enrichNextAt ?? 0) <= now)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const c of due) {
    try {
      const r = await deps.asr.process(c.startedAt - WINDOW_PAD_MS, c.finishedAt + WINDOW_PAD_MS);
      const enriched = applyAsr(c, r);
      deps.store.saveConversation(settle({ ...enriched, enrich: "done" }, deps));
      log("omi enriched", {
        id: c.id, transcript: enriched.transcriptSource, covered: r.covered_seconds,
        speakers: enriched.asr?.speakers.map((s) => s.label + (s.voiceMatch ? `~${s.voiceMatch.name}` : "")),
        owner: enriched.asr?.ownerSource,
      });
    } catch (e) {
      const attempts = (c.enrichAttempts ?? 0) + 1;
      if (attempts <= ENRICH_BACKOFF_MS.length) {
        deps.store.saveConversation({ ...c, enrichAttempts: attempts, enrichNextAt: (deps.now ?? Date.now)() + ENRICH_BACKOFF_MS[attempts - 1] });
        log("omi enrich failed, will retry", { id: c.id, attempt: attempts, error: String(e).slice(0, 300) });
      } else {
        deps.store.saveConversation(settle({ ...c, enrich: "failed", enrichAttempts: attempts, transcriptSource: "omi" }, deps));
        log("omi enrich failed for good, using Omi's transcript", { id: c.id, error: String(e).slice(0, 300) });
      }
    }
  }
}

/** Assigns every closed chain of conversations to a new note job. */
export function groupConversations(deps: OmiDeps): NoteJob[] {
  const now = (deps.now ?? Date.now)();
  const made: NoteJob[] = [];
  const settled = deps.store.conversations().filter((c) => c.enrich !== "pending");
  for (const group of readyGroups(settled, now, deps.mergeGapMs)) {
    const words = group.reduce((n, c) => n + wordCount(c), 0);
    const note: NoteJob = {
      id: `omi-${group[0].id}`,
      conversationIds: group.map((c) => c.id),
      status: words < deps.minWords ? "skipped" : "pending",
      createdAt: now,
      nextAttemptAt: now,
      attempts: 0,
      ...(words < deps.minWords ? { reason: `too short (${words} words)`, finishedAt: now } : {}),
    };
    deps.store.saveNote(note);
    for (const c of group) deps.store.saveConversation({ ...c, noteId: note.id });
    log(note.status === "skipped" ? "omi group skipped" : "omi group queued", { note: note.id, conversations: group.length, words });
    made.push(note);
  }
  return made;
}

/** Distillation runs (written or skipped by the model) in the last 24 hours. */
function runsToday(deps: OmiDeps, now: number) {
  return deps.store.notes().filter((n) => n.finishedAt && now - n.finishedAt < DAY_MS && (n.status === "done" || (n.status === "skipped" && n.attempts > 0))).length;
}

/**
 * Teaches the speech service voices the distiller identified from strong evidence (a name Sam
 * gave the voice in Omi, a self-introduction, or direct address; never a voice match alone). The
 * person must have a people/ note, the speaker at least 10 s of speech, and the label must map to
 * one person only. The service separately refuses anything that sounds like the owner.
 */
export async function learnVoices(convs: OmiConversation[], ids: SpeakerIdentity[], deps: OmiDeps, peopleDir = join(config.vaultDir, "people")): Promise<string[]> {
  if (!deps.asr) return [];
  const learned: string[] = [];
  for (const id of ids) {
    if (!LEARNABLE_EVIDENCE.has(id.evidence)) continue;
    const conv = convs[id.conversation - 1];
    const sp = conv?.asr?.speakers.find((x) => x.label === id.label && !x.isUser);
    if (!conv?.asr?.runId || !sp || sp.seconds < 10) continue;
    if (ids.some((o) => o !== id && o.conversation === id.conversation && o.label === id.label && o.person !== id.person)) continue;
    if (!existsSync(join(peopleDir, `${id.person}.md`))) continue;
    try {
      learned.push(await deps.asr.learn(id.person, conv.asr.runId, sp.cluster));
      log("omi voice learned", { person: id.person, evidence: id.evidence, conversation: conv.id });
    } catch (e) {
      log("omi voice not learned", { person: id.person, error: String(e).slice(0, 200) });
    }
  }
  return learned;
}

let capNotifiedAt = 0;

export async function processNote(note: NoteJob, deps: OmiDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (runsToday(deps, now) >= deps.maxNotesPerDay) {
    note.nextAttemptAt = now + 3_600_000;
    deps.store.saveNote(note);
    if (now - capNotifiedAt > DAY_MS) {
      capNotifiedAt = now;
      await deps.notify("Omi: daily limit reached", `${deps.maxNotesPerDay} notes in 24 hours; the rest wait and continue automatically.`, { urgent: true });
    }
    return;
  }
  const convs = note.conversationIds.map((id) => deps.store.conversation(id)).filter((c) => c !== null);
  if (!convs.length) {
    Object.assign(note, { status: "failed", error: "conversations missing from state", finishedAt: now });
    deps.store.saveNote(note);
    return;
  }
  convs.sort((a, b) => a.startedAt - b.startedAt);
  note.attempts++;
  try {
    const r = await deps.distill(convs, note.id);
    note.finishedAt = (deps.now ?? Date.now)();
    if (r.status === "written") {
      Object.assign(note, { status: "done", notePath: r.notePath, title: r.title });
      deps.store.saveNote(note);
      log("omi note written", { note: note.id, path: r.notePath, people: r.peopleCreated });
      const voices = await learnVoices(convs, r.identities ?? [], deps);
      const people = r.peopleCreated.length ? `\nNew people: ${r.peopleCreated.join(", ")}` : "";
      const learned = voices.length ? `\nLearned voices: ${voices.join(", ")}` : "";
      await deps.notify("Omi note", `${r.title}\n${r.notePath}${people}${learned}`);
    } else {
      Object.assign(note, { status: "skipped", reason: r.reason });
      deps.store.saveNote(note);
      log("omi note skipped by distiller", { note: note.id, reason: r.reason });
      await deps.notify("Omi: nothing to keep", r.reason, { quiet: true });
    }
  } catch (e) {
    note.error = String(e).slice(0, 500);
    if (note.attempts <= DISTILL_BACKOFF_MS.length) {
      note.nextAttemptAt = (deps.now ?? Date.now)() + DISTILL_BACKOFF_MS[note.attempts - 1];
      deps.store.saveNote(note);
      log("omi distill failed, will retry", { note: note.id, attempt: note.attempts, error: note.error });
      return;
    }
    Object.assign(note, { status: "failed", finishedAt: (deps.now ?? Date.now)() });
    deps.store.saveNote(note);
    log("omi distill failed for good", { note: note.id, error: note.error });
    await deps.notify("Omi: needs attention",
      `Couldn't distill ${convs.length} conversation(s) after ${note.attempts} tries; the transcript is kept on the server (${note.id}). Last error: ${note.error.slice(0, 160)}`,
      { urgent: true });
  }
}

/** Polls every [pollMs]: groups closed conversations, then distills due notes one at a time. */
export function startOmiWorker(deps: OmiDeps, pollMs = 30_000) {
  let current: Promise<void> | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    await enrichConversations(deps);
    groupConversations(deps);
    const now = (deps.now ?? Date.now)();
    const due = deps.store.notes().filter((n) => n.status === "pending" && n.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt);
    for (const note of due) {
      if (stopping) return;
      try {
        await processNote(note, deps);
      } catch (e) {
        log("omi note crashed", { note: note.id, error: String(e) });
      }
    }
  };
  const tick = () => {
    if (current || stopping) return;
    clearTimeout(timer);
    current = run().finally(() => {
      current = null;
      if (!stopping) timer = setTimeout(tick, pollMs);
    });
  };
  timer = setTimeout(tick, 0);
  return {
    kick: tick,
    stop: async () => {
      stopping = true;
      clearTimeout(timer);
      await current;
    },
  };
}
