// One JSON file per delivery under state/jobs. A job survives restarts and records which of its
// actions already ran, so retries never repeat a completed action.

import { join } from "node:path";
import type { RouterAction } from "./router.ts";
import { JsonDirStore } from "./util.ts";

export type ActionState = RouterAction & {
  status: "pending" | "done" | "failed";
  attempts: number;
  result?: string;
  error?: string;
};

export type Job = {
  id: string;
  trigger: string;
  transcript: string;
  recordedAt: number;
  receivedAt: number;
  status: "pending" | "done";
  nextAttemptAt: number;
  routeAttempts: number;
  routedBy?: "claude" | "fallback";
  routeError?: string;
  plan?: ActionState[];
  fallbackNote?: string;
};

const DONE_TTL_MS = 7 * 24 * 3600_000;

export class JobStore {
  private files: JsonDirStore<Job>;

  constructor(stateDir: string) {
    this.files = new JsonDirStore<Job>(join(stateDir, "jobs"));
  }

  has(id: string): boolean {
    return this.files.has(id);
  }

  save(job: Job) {
    this.files.save(job.id, job);
  }

  /** Pending jobs whose next attempt is due, oldest first. */
  due(nowMs: number): Job[] {
    return this.all().filter((j) => j.status === "pending" && j.nextAttemptAt <= nowMs)
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  all(): Job[] {
    return this.files.all();
  }

  /** Drops finished jobs older than a week; they only exist for dedupe and debugging. */
  prune(nowMs: number) {
    this.files.prune(nowMs, DONE_TTL_MS, (job) => job.status === "done");
  }
}
