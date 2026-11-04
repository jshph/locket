// Turns saved Omi conversations into notes: merge conversations that follow each other closely,
// drop fragments too short to distill, then run the distiller one note at a time with retries.
// A failure never falls back to dumping the raw transcript into the vault; the transcript stays in
// state/omi/ and the user gets an urgent ntfy.

import type { Notifier } from "./notify.ts";
import type { Distiller } from "./distill.ts";
import { readyGroups, wordCount, type NoteJob, type OmiStore } from "./omi.ts";

export type OmiDeps = {
  store: OmiStore;
  distill: Distiller;
  notify: Notifier;
  now?: () => number;
  mergeGapMs: number;
  minWords: number;
  maxNotesPerDay: number;
};

export const DISTILL_BACKOFF_MS = [120_000, 600_000, 3_600_000, 3 * 3_600_000];
const DAY_MS = 24 * 3600_000;

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

/** Assigns every closed chain of conversations to a new note job. */
export function groupConversations(deps: OmiDeps): NoteJob[] {
  const now = (deps.now ?? Date.now)();
  const made: NoteJob[] = [];
  for (const group of readyGroups(deps.store.conversations(), now, deps.mergeGapMs)) {
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
      const people = r.peopleCreated.length ? `\nNew people: ${r.peopleCreated.join(", ")}` : "";
      await deps.notify("Omi note", `${r.title}\n${r.notePath}${people}`);
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
