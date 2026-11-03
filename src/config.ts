// All settings come from the environment; Bun loads ./.env (secrets) on its own.
const env = process.env;

export const config = {
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 8790),
  webhookSecret: env.INDEX_WEBHOOK_SECRET ?? "",
  stateDir: env.STATE_DIR ?? "./state",
  /** The user's local zone, used for note filenames/frontmatter and the router's sense of "now". */
  localTz: env.LOCAL_TZ ?? "America/Bogota",

  vaultDir: env.VAULT_DIR ?? "/path/to/vault",
  inboxDir: env.INBOX_DIR ?? "inbox",

  bbBin: env.BB_BIN ?? "bb",
  bbProject: env.BB_PROJECT ?? "proj_xxxxxxxxxx", // obsidian
  bbEnvironment: env.BB_ENVIRONMENT ?? "env_xxxxxxxxxx", // /path/to/vault
  bbPermissionMode: env.BB_PERMISSION_MODE ?? "auto",
  maxSpawnsPerHour: Number(env.MAX_SPAWNS_PER_HOUR ?? 30),

  claudeBin: env.CLAUDE_BIN ?? "claude",
  claudeModel: env.CLAUDE_MODEL ?? "opus",
  claudeEffort: env.CLAUDE_EFFORT ?? "low",

  todoistToken: env.TODOIST_API_TOKEN ?? "",
  ntfyServer: env.NTFY_SERVER ?? "https://ntfy.sh",
  ntfyTopic: env.NTFY_TOPIC ?? "",
};

/** Minimal environment for child processes, so .env secrets never reach claude or bb. */
export function childEnv(): Record<string, string> {
  return {
    HOME: env.HOME ?? "/home/you",
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: env.LANG ?? "C.UTF-8",
  };
}
