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
  googleClientId: env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: env.GOOGLE_REDIRECT_URI ?? "https://your-host.your-tailnet.ts.net:10000/oauth/google/callback",
  googleCalendarId: env.GOOGLE_CALENDAR_ID ?? "primary",
  // Omi "Conversation created" webhook -> Margins-style distilled notes (src/omi*.ts, src/distill.ts).
  omiWebhookSecret: env.OMI_WEBHOOK_SECRET ?? "", // the URL path is /omi/<secret>; Omi doesn't sign
  marginsWorkspace: env.MARGINS_WORKSPACE ?? "obsidian",
  omiEffort: env.OMI_CLAUDE_EFFORT ?? "medium",
  omiMergeGapMs: Number(env.OMI_MERGE_GAP_MIN ?? 10) * 60_000,
  omiMinWords: Number(env.OMI_MIN_WORDS ?? 40),
  omiBackgroundKeepOwnerWords: Number(env.OMI_BACKGROUND_KEEP_OWNER_WORDS ?? 60),
  omiMaxNotesPerDay: Number(env.OMI_MAX_NOTES_PER_DAY ?? 30),
  // Local speech service (asr/): live transcription for the Omi app's Custom STT at /stt/<secret>,
  // stored audio, and diarized re-transcription of each conversation. Off with OMI_ASR=0.
  asrEnabled: (env.OMI_ASR ?? "1") !== "0",
  asrPort: Number(env.OMI_ASR_PORT ?? 8791),
  asrDir: env.OMI_ASR_DIR ?? new URL("../asr", import.meta.url).pathname,
  asrPython: env.OMI_ASR_PYTHON ?? new URL("../asr/.venv/bin/python", import.meta.url).pathname,
  omiAudioRetentionDays: Number(env.OMI_AUDIO_RETENTION_DAYS ?? 7),

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
