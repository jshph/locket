// Drives each saved job to completion: route once, run every action until it succeeds, and make
// sure the user's words always land somewhere (a vault note) even when routing or an action
// fails for good. The phone app never retries a webhook, so this is the only retry there is.

import type { Notifier } from "./notify.ts";
import type { Router, RouterAction } from "./router.ts";
import type { ActionState, Job, JobStore } from "./store.ts";

export type Effects = {
  writeNote: (transcript: string, title: string, recordedAt: number) => string;
  createTask: (a: Extract<RouterAction, { tool: "create_reminder" }>) => Promise<string>;
  spawnThread: (prompt: string) => Promise<string>;
};

export type Deps = { store: JobStore; route: Router; effects: Effects; notify: Notifier; now?: () => number };

// Router retries cover a brief outage or usage-limit blip before falling back to a plain note.
export const ROUTE_BACKOFF_MS = [30_000, 120_000, 600_000];
// Action retries span a few hours (bb restarting, Todoist down, network).
export const ACTION_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000];

const LABEL: Record<RouterAction["tool"], string> = {
  create_note: "Note",
  create_reminder: "Todoist",
  start_thread: "Thread",
};

function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

async function runAction(a: ActionState, job: Job, effects: Effects): Promise<string> {
  switch (a.tool) {
    case "create_note":
      return effects.writeNote(job.transcript, a.title, job.recordedAt);
    case "create_reminder":
      return effects.createTask(a);
    case "start_thread":
      return effects.spawnThread(job.transcript);
  }
}

export async function processJob(job: Job, deps: Deps): Promise<void> {
  const now = deps.now ?? Date.now;
  const { store } = deps;

  if (!job.plan) {
    try {
      const actions = await deps.route(job.transcript, job.recordedAt);
      // Same rule as the app: if the agent chose nothing, capture the words as a note.
      const plan = actions.length ? actions : [{ tool: "create_note", title: "" } as RouterAction];
      job.plan = plan.map((a) => ({ ...a, status: "pending", attempts: 0 }));
      job.routedBy = "claude";
    } catch (e) {
      job.routeAttempts++;
      job.routeError = String(e).slice(0, 500);
      if (job.routeAttempts <= ROUTE_BACKOFF_MS.length) {
        job.nextAttemptAt = now() + ROUTE_BACKOFF_MS[job.routeAttempts - 1];
        store.save(job);
        log("route failed, will retry", { id: job.id, attempt: job.routeAttempts, error: job.routeError });
        return;
      }
      job.plan = [{ tool: "create_note", title: "", status: "pending", attempts: 0 }];
      job.routedBy = "fallback";
      log("route failed for good, falling back to a note", { id: job.id, error: job.routeError });
    }
    store.save(job);
  }

  let retryAfter: number | null = null;
  for (const a of job.plan) {
    if (a.status !== "pending") continue;
    try {
      a.result = await runAction(a, job, deps.effects);
      a.status = "done";
      log("action done", { id: job.id, tool: a.tool, result: a.result });
    } catch (e) {
      a.attempts++;
      a.error = String(e).slice(0, 500);
      if (a.attempts <= ACTION_BACKOFF_MS.length) {
        const wait = ACTION_BACKOFF_MS[a.attempts - 1];
        retryAfter = retryAfter === null ? wait : Math.min(retryAfter, wait);
        log("action failed, will retry", { id: job.id, tool: a.tool, attempt: a.attempts, error: a.error });
      } else {
        a.status = "failed";
        log("action failed for good", { id: job.id, tool: a.tool, error: a.error });
      }
    }
    store.save(job);
  }

  if (retryAfter !== null) {
    job.nextAttemptAt = now() + retryAfter;
    store.save(job);
    return;
  }

  // Something failed for good and no note captured the words: save them so nothing is lost.
  const failed = job.plan.filter((a) => a.status === "failed");
  const noted = job.plan.some((a) => a.tool === "create_note" && a.status === "done");
  if (failed.length && !noted && !job.fallbackNote) {
    try {
      job.fallbackNote = deps.effects.writeNote(job.transcript, "", job.recordedAt);
    } catch (e) {
      log("fallback note failed", { id: job.id, error: String(e) });
    }
  }

  job.status = "done";
  store.save(job);
  await deps.notify(...summarize(job, now()));
}

export function summarize(job: Job, nowMs: number): [string, string, { urgent?: boolean }] {
  const lines = (job.plan ?? []).map((a) =>
    a.status === "done" ? `${LABEL[a.tool]}: ${a.tool === "create_note" ? a.title || a.result : a.title}`
      : `Couldn't ${a.tool === "create_reminder" ? "create Todoist task" : a.tool === "start_thread" ? "start thread" : "save note"}: ${a.title}`);
  if (job.routedBy === "fallback") lines.unshift("Router unavailable, saved your words as a note.");
  if (job.fallbackNote) lines.push(`Saved your words as a note: ${job.fallbackNote}`);
  const lagMin = Math.round((nowMs - job.recordedAt) / 60_000);
  if (lagMin >= 3) lines.push(`(recorded ${lagMin} min ago)`);
  const problem = job.routedBy === "fallback" || job.plan?.some((a) => a.status === "failed");
  return [problem ? "Index: needs attention" : "Index", lines.join("\n"), { urgent: Boolean(problem) }];
}

/** Polls for due jobs and processes them one at a time; [kick] skips the wait. */
export function startWorker(deps: Deps, pollMs = 5_000) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (running) return;
    running = true;
    clearTimeout(timer);
    try {
      for (const job of deps.store.due((deps.now ?? Date.now)())) {
        try {
          await processJob(job, deps);
        } catch (e) {
          log("job crashed", { id: job.id, error: String(e) });
        }
      }
    } finally {
      running = false;
      timer = setTimeout(tick, pollMs);
    }
  };
  timer = setTimeout(tick, 0);
  return { kick: () => void tick() };
}
