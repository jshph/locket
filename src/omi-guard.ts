// The distiller's write guardrail, run as a Claude Code PreToolUse hook (scripts/omi-guard.ts).
// Claude Code's own permission rules already limit reads to the vault, writes to inbox/ and
// people/, and Bash to `margins recall`. This hook adds what those rules can't express:
//   - the conversation note is a NEW file named with the prefix the service assigned, one per run
//   - person notes are NEW files in people/ (no case-insensitive clash), at most MAX_PEOPLE per run
//   - Edit only touches files this run created; nothing existing is ever modified
//   - Bash is exactly `margins --workspace <id> recall "<query>"`, no shell metacharacters
// The transcript is untrusted (other people's speech), so these rules hold whatever it says.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const MAX_PEOPLE = 3;
// "Dana Okafor.md", "Édouard Urcades.md", "D'Angelo Russell Jr..md"; never "[[Sam Rivera.md" or "[].md".
const PERSON_FILE = /^\p{L}[\p{L}\p{M} .'’-]{0,60}\.md$/u;

export type GuardContext = {
  vaultDir: string;
  inboxDir: string; // absolute
  peopleDir: string; // absolute
  notePrefix: string; // e.g. "2026-11-04-14-03-22 "
  workspaceId: string;
  /** Files created so far in this run (absolute paths), persisted between hook calls. */
  created: string[];
};

export type Decision = { allow: true; created?: string } | { allow: false; reason: string };

const deny = (reason: string): Decision => ({ allow: false, reason });

function inside(dir: string, p: string) {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

export function decide(toolName: string, input: Record<string, any>, ctx: GuardContext): Decision {
  switch (toolName) {
    case "StructuredOutput": // the final --json-schema result
      return { allow: true };
    case "Read":
    case "Glob":
    case "Grep": {
      const raw = input.file_path ?? input.path;
      if (raw !== undefined && !inside(ctx.vaultDir, resolve(String(raw)))) {
        return deny(`Reading outside the vault is not allowed: ${resolve(String(raw))}`);
      }
      // Search patterns can carry their own location: an absolute or ~ pattern must stay in the
      // vault, and no pattern may climb out with "..".
      for (const pat of [input.pattern, input.glob].filter((x) => typeof x === "string") as string[]) {
        if (toolName === "Grep" && pat === input.pattern) continue; // Grep's pattern is a regex, not a path
        if (/(^|[\\/])\.\.([\\/]|$)/.test(pat)) return deny("Patterns may not contain '..'.");
        if (pat.startsWith("~")) return deny("Patterns must be inside the vault.");
        if (pat.startsWith("/") && !inside(ctx.vaultDir, resolve(pat.split(/[*?[{]/)[0] || "/"))) {
          return deny(`Patterns must be inside the vault: ${pat}`);
        }
      }
      return { allow: true }; // a relative pattern with no path searches the empty working directory
    }
    case "Bash": {
      const cmd = String(input.command ?? "").trim();
      const prefix = `margins --workspace ${ctx.workspaceId} recall `;
      if (!cmd.startsWith(prefix)) return deny(`Only \`${prefix}"<query>"\` is allowed.`);
      const query = cmd.slice(prefix.length);
      if (!/^"[^"`$\\;&|<>\n\r]*"$/.test(query) && !/^'[^'\n\r;&|<>`$\\]*'$/.test(query)) {
        return deny("Pass the recall query as one quoted string without shell metacharacters.");
      }
      return { allow: true };
    }
    case "Write": {
      const p = resolve(String(input.file_path ?? ""));
      const name = basename(p);
      if (ctx.created.includes(p)) return { allow: true }; // rewriting its own new file
      if (existsSync(p)) return deny(`${p} already exists. Never overwrite existing notes.`);
      if (!name.endsWith(".md")) return deny("Only Markdown notes can be written.");
      if (dirname(p) === ctx.inboxDir) {
        if (!name.startsWith(ctx.notePrefix)) {
          return deny(`The conversation note must be named "${ctx.notePrefix}<title>.md".`);
        }
        if (ctx.created.some((c) => dirname(c) === ctx.inboxDir)) {
          return deny("Only one conversation note per run; edit the one you already wrote.");
        }
        return { allow: true, created: p };
      }
      if (dirname(p) === ctx.peopleDir) {
        const made = ctx.created.filter((c) => dirname(c) === ctx.peopleDir).length;
        if (made >= MAX_PEOPLE) return deny(`At most ${MAX_PEOPLE} new person notes per run.`);
        if (!PERSON_FILE.test(name)) return deny(`"${name}" is not a plain person name (letters, spaces, - ' . only).`);
        const lower = name.toLowerCase();
        const clash = existsSync(ctx.peopleDir) && readdirSync(ctx.peopleDir).find((f) => f.toLowerCase() === lower);
        if (clash) return deny(`people/${clash} already exists; link to [[${clash.replace(/\.md$/, "")}]] instead.`);
        return { allow: true, created: p };
      }
      return deny("Notes can only be created directly in inbox/ (the conversation note) or people/ (new person notes).");
    }
    case "Edit":
    case "MultiEdit": {
      const p = resolve(String(input.file_path ?? ""));
      return ctx.created.includes(p) ? { allow: true } : deny("Only files created in this run can be edited.");
    }
    default:
      return deny(`${toolName} is not available to the distiller.`);
  }
}

/** Hook entrypoint: reads the PreToolUse event on stdin; exit 2 blocks with the reason. */
export async function runHook(stdinText: string, env: Record<string, string | undefined>): Promise<number> {
  const statePath = env.OMI_GUARD_STATE;
  if (!statePath) {
    console.error("guard misconfigured: OMI_GUARD_STATE unset");
    return 2;
  }
  const ctx = JSON.parse(readFileSync(statePath, "utf8")) as GuardContext;
  let event: any;
  try {
    event = JSON.parse(stdinText);
  } catch {
    console.error("guard could not parse the tool call");
    return 2;
  }
  const d = decide(String(event.tool_name ?? ""), event.tool_input ?? {}, ctx);
  if (!d.allow) {
    console.error(d.reason);
    return 2;
  }
  if (d.created && !ctx.created.includes(d.created)) {
    ctx.created.push(d.created);
    writeFileSync(statePath, JSON.stringify(ctx));
  }
  return 0;
}
