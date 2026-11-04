// The side effects a routed action can have. Each returns a short human-readable result.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnv, config } from "./config.ts";
import { fetchWithTimeout } from "./util.ts";

/** Local calendar parts for [ms] in [tz], e.g. date "2026-11-03", stamp "2026-11-03-00-34-12". */
export function localStamp(ms: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, stamp: `${date}-${parts.hour}-${parts.minute}-${parts.second}` };
}

/** Lowercase, filesystem- and Obsidian-safe title; "" when nothing usable remains. */
export function cleanTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[\s.]+$/, "");
}

/** Matches templates/quick capture.md, with the transcript verbatim as the body. */
export function noteContent(transcript: string, date: string): string {
  return `---\ntags:\npeople:\ncreated: '[[${date}]]'\n---\n\n${transcript.trim()}\n`;
}

/**
 * Writes inbox/<timestamp> <title>.md following the vault's naming guidelines. Never overwrites:
 * a clash gets " (2)", " (3)", ... appended.
 */
export function writeNote(transcript: string, title: string, recordedAt: number, opts = config): string {
  const { date, stamp } = localStamp(recordedAt, opts.localTz);
  const base = [stamp, cleanTitle(title)].filter(Boolean).join(" ");
  for (let n = 1; ; n++) {
    const rel = join(opts.inboxDir, `${base}${n > 1 ? ` (${n})` : ""}.md`);
    const abs = join(opts.vaultDir, rel);
    if (existsSync(abs)) continue;
    writeFileSync(abs, noteContent(transcript, date), { flag: "wx" });
    return rel;
  }
}

// --- Todoist (ported from reference/upstream/todoist-plugin@531b6c9/plugin.js) ---

const TODOIST_API = "https://api.todoist.com/api/v1";
let projectCache: { at: number; byName: Map<string, string> } | null = null;

async function todoist(method: string, path: string, body?: unknown, requestId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.todoistToken}`, "Content-Type": "application/json" };
  // Todoist ignores a repeated X-Request-Id, so a retry after a lost response can't duplicate.
  if (requestId) headers["X-Request-Id"] = requestId;
  const res = await fetchWithTimeout(TODOIST_API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? safeJson(text) : null, text };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function projectIdFor(list: string): Promise<string | undefined> {
  if (!projectCache || Date.now() - projectCache.at > 15 * 60_000) {
    const res = await todoist("GET", "/projects?limit=200");
    if (!res.ok) throw new Error(`Todoist projects HTTP ${res.status}`);
    const items: any[] = res.json?.results ?? res.json ?? [];
    projectCache = { at: Date.now(), byName: new Map(items.map((p) => [String(p.name).toLowerCase(), String(p.id)])) };
  }
  const key = list.toLowerCase().replace(/\s+list$/, "");
  return projectCache.byName.get(key) ?? projectCache.byName.get(`${key} list`);
}

export async function createTodoistTask(a: { title: string; due?: string; lead_hours?: number; list?: string }, requestId?: string): Promise<string> {
  if (!config.todoistToken) throw new Error("TODOIST_API_TOKEN is not set");
  const task: Record<string, unknown> = { content: a.title };
  const projectId = a.list ? await projectIdFor(a.list) : undefined;
  if (projectId) task.project_id = projectId;
  if (a.due) {
    task.due_string = a.due;
    task.due_lang = "en";
  }
  let res = await todoist("POST", "/tasks", task, requestId);
  let dueAccepted = Boolean(a.due) && res.ok;
  if (!res.ok && res.status === 400 && a.due) {
    // Todoist couldn't parse the date: keep the task and carry the spoken time in its description.
    delete task.due_string;
    delete task.due_lang;
    task.description = `Due (unparsed): ${a.due}`;
    res = await todoist("POST", "/tasks", task, requestId && `${requestId}:undated`);
  }
  if (!res.ok) throw new Error(`Todoist HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const id = res.json?.id;
  if (!id) throw new Error("Todoist created no identifiable task");
  if (dueAccepted) {
    // Best effort, as in the plugin: explicit reminders depend on the Todoist plan (and need a due
    // time, not just a date), and the task already exists, so a failure here must not trigger a
    // retry that duplicates it.
    await todoist("POST", "/reminders", {
      task_id: id, reminder_type: "relative", service: "push",
      minute_offset: Math.round((a.lead_hours ?? 0) * 60),
    }).catch(() => undefined);
  }
  const where = a.list && !projectId ? ` (no "${a.list}" project, put in Inbox)` : a.list ? ` in ${a.list}` : "";
  const due = res.json?.due?.string ? `, due ${res.json.due.string}` : "";
  return `${a.title}${due}${where} [todoist ${id}]`;
}

// --- bb threads ---

const recentSpawns: number[] = [];

/** Starts a bb thread with [prompt] on stdin, so it reaches the agent byte-for-byte. */
export async function spawnThread(prompt: string): Promise<string> {
  if (!config.bbProject || !config.bbEnvironment) throw new Error("BB_PROJECT / BB_ENVIRONMENT are not set");
  const hourAgo = Date.now() - 3600_000;
  while (recentSpawns.length && recentSpawns[0] < hourAgo) recentSpawns.shift();
  if (recentSpawns.length >= config.maxSpawnsPerHour) throw new Error("thread spawn rate limit reached");
  recentSpawns.push(Date.now());
  const proc = Bun.spawn(
    [config.bbBin, "thread", "spawn", "--project", config.bbProject, "--environment", config.bbEnvironment,
      "--permission-mode", config.bbPermissionMode, "--prompt-file", "-", "--json"],
    { env: childEnv(), stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`bb exited ${code}: ${(err || out).slice(0, 300)}`);
  const id = JSON.parse(out)?.id;
  if (!id) throw new Error(`bb returned no thread id: ${out.slice(0, 200)}`);
  return id;
}
