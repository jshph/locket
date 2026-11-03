// One JSON file per delivery under state/jobs. A job survives restarts and records which of its
// actions already ran, so retries never repeat a completed action.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouterAction } from "./router.ts";

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
  private dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "jobs");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string) {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  save(job: Job) {
    const p = this.path(job.id);
    writeFileSync(`${p}.tmp`, JSON.stringify(job, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  /** Pending jobs whose next attempt is due, oldest first. */
  due(nowMs: number): Job[] {
    return this.all().filter((j) => j.status === "pending" && j.nextAttemptAt <= nowMs)
      .sort((a, b) => a.receivedAt - b.receivedAt);
  }

  all(): Job[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Job];
      } catch {
        return [];
      }
    });
  }

  /** Drops finished jobs older than a week; they only exist for dedupe and debugging. */
  prune(nowMs: number) {
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      try {
        const job = JSON.parse(readFileSync(p, "utf8")) as Job;
        if (job.status === "done" && nowMs - statSync(p).mtimeMs > DONE_TTL_MS) unlinkSync(p);
      } catch {
        // Ignore unreadable or concurrently replaced files.
      }
    }
  }
}
