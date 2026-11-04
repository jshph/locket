// Small shared pieces: JSON-line logging, a single-flight poller, a directory of JSON records,
// a `claude -p` runner, and fetch with a deadline.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One JSON object per line on stdout (journald). Never pass transcripts or secrets. */
export function log(msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

export function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Runs [run] every [pollMs], never two at once; kick() runs it now. stop() starts no new run and
 * resolves when the current one finishes, so a restart never cuts work in half. [run] receives a
 * function telling it whether to stop between items.
 */
export function startPoller(run: (stopping: () => boolean) => Promise<void>, pollMs: number) {
  let current: Promise<void> | null = null;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (current || stopping) return;
    clearTimeout(timer);
    current = run(() => stopping)
      .catch((e) => log("poller run crashed", { error: String(e) }))
      .finally(() => {
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

/** A directory with one JSON file per record, written atomically (tmp + rename). */
export class JsonDirStore<T> {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string) {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }

  has(id: string): boolean {
    return existsSync(this.path(id));
  }

  get(id: string): T | null {
    try {
      return JSON.parse(readFileSync(this.path(id), "utf8")) as T;
    } catch {
      return null;
    }
  }

  save(id: string, value: T) {
    const p = this.path(id);
    writeFileSync(`${p}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${p}.tmp`, p);
  }

  all(): T[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(this.dir, f), "utf8")) as T];
      } catch {
        return [];
      }
    });
  }

  /** Deletes records older than [maxAgeMs] (by file time) for which [deletable] is true. */
  prune(nowMs: number, maxAgeMs: number, deletable: (value: T) => boolean) {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(this.dir, f);
      try {
        if (nowMs - statSync(p).mtimeMs <= maxAgeMs) continue;
        if (deletable(JSON.parse(readFileSync(p, "utf8")) as T)) unlinkSync(p);
      } catch {
        // Ignore unreadable or concurrently replaced files.
      }
    }
  }
}

/** fetch that gives up after [timeoutMs], so one stuck connection can't stall a worker. */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Runs `claude -p` with [args] and [stdin], killing it after [timeoutMs]. Returns the parsed JSON
 * result and the raw stdout; throws on a non-zero exit or an error result.
 */
export async function runClaude(opts: {
  bin: string; args: string[]; stdin: string; cwd: string; env: Record<string, string>; timeoutMs: number;
}): Promise<{ result: any; stdout: string }> {
  const proc = Bun.spawn([opts.bin, "-p", "--output-format", "json", ...opts.args], {
    cwd: opts.cwd, env: opts.env, stdin: new TextEncoder().encode(opts.stdin), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw Object.assign(new Error(`claude exited ${code}: ${(stderr || stdout).slice(0, 300)}`), { stdout });
    const result = JSON.parse(stdout);
    if (result.is_error) {
      throw Object.assign(new Error(`claude error ${result.api_error_status ?? ""}: ${String(result.result ?? "").slice(0, 300)}`), { stdout });
    }
    return { result, stdout };
  } finally {
    clearTimeout(timer);
  }
}
