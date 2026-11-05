// All settings come from the environment; Bun loads ./.env on its own. See .env.example.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;

function num(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const publicUrl = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");

export const config = {
  host: env.HOST ?? "127.0.0.1",
  port: num("PORT", 8790),
  /**
   * Second listener for routes that must not be on the public internet (the ring webhook can
   * start agent threads). Put it behind a tailnet-only `tailscale serve`. 0 turns it off.
   */
  privatePort: num("PRIVATE_PORT", 8792),
  /** Also serve /index on the public listener. Only for migrating a ring app's webhook URL. */
  indexPublic: (env.INDEX_PUBLIC ?? "0") === "1",
  /** The HTTPS origin phones reach this server at, e.g. https://box.tailnet.ts.net:10000. */
  publicUrl,
  webhookSecret: env.INDEX_WEBHOOK_SECRET ?? "",
  stateDir: env.STATE_DIR ?? "./state",
  /** Your local zone, used for note filenames/frontmatter and the router's sense of "now". */
  localTz: env.LOCAL_TZ ?? "UTC",

  /** How the distiller refers to the person wearing the Omi ("Me" in transcripts). */
  ownerName: env.OWNER_NAME ?? "the vault owner",
  vaultDir: env.VAULT_DIR ?? "",
  inboxDir: env.INBOX_DIR ?? "inbox",

  bbBin: env.BB_BIN ?? "bb",
  bbProject: env.BB_PROJECT ?? "",
  bbEnvironment: env.BB_ENVIRONMENT ?? "",
  bbPermissionMode: env.BB_PERMISSION_MODE ?? "auto",
  maxSpawnsPerHour: num("MAX_SPAWNS_PER_HOUR", 30),

  claudeBin: env.CLAUDE_BIN ?? "claude",
  claudeModel: env.CLAUDE_MODEL ?? "opus",
  claudeEffort: env.CLAUDE_EFFORT ?? "low",

  todoistToken: env.TODOIST_API_TOKEN ?? "",
  googleClientId: env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: env.GOOGLE_REDIRECT_URI ?? (publicUrl ? `${publicUrl}/oauth/google/callback` : ""),
  googleCalendarId: env.GOOGLE_CALENDAR_ID ?? "primary",

  // Omi "Conversation created" webhook -> Margins-style distilled notes (src/omi*.ts, src/distill.ts).
  omiWebhookSecret: env.OMI_WEBHOOK_SECRET ?? "", // the URL path is /omi/<secret>; Omi doesn't sign
  marginsWorkspace: env.MARGINS_WORKSPACE ?? "obsidian",
  omiEffort: env.OMI_CLAUDE_EFFORT ?? "medium",
  omiMergeGapMs: num("OMI_MERGE_GAP_MIN", 10) * 60_000,
  omiMinWords: num("OMI_MIN_WORDS", 40),
  omiBackgroundKeepOwnerWords: num("OMI_BACKGROUND_KEEP_OWNER_WORDS", 60),
  omiMaxNotesPerDay: num("OMI_MAX_NOTES_PER_DAY", 30),
  // Local speech service (asr/): live transcription for the Omi app's Custom STT at /stt/<secret>,
  // stored audio, and diarized re-transcription of each conversation. Off with OMI_ASR=0.
  asrEnabled: (env.OMI_ASR ?? "1") !== "0",
  asrPort: num("OMI_ASR_PORT", 8791),
  asrDir: env.OMI_ASR_DIR ?? new URL("../asr", import.meta.url).pathname,
  asrPython: env.OMI_ASR_PYTHON ?? new URL("../asr/.venv/bin/python", import.meta.url).pathname,
  omiAudioRetentionDays: num("OMI_AUDIO_RETENTION_DAYS", 7),
  // Watchdog (src/watchdog.ts): ntfy when live audio stops for hours while you're up, or when
  // audio older than the gap window never became an Omi conversation.
  omiSilenceAlertHours: num("OMI_SILENCE_ALERT_HOURS", 3),
  omiAwakeHours: env.OMI_AWAKE_HOURS ?? "8-22",
  omiGapAlertMinutes: num("OMI_GAP_ALERT_MINUTES", 60),
  omiGapMinAudioSeconds: num("OMI_GAP_MIN_AUDIO_SECONDS", 120),

  ntfyServer: env.NTFY_SERVER ?? "https://ntfy.sh",
  ntfyTopic: env.NTFY_TOPIC ?? "",
};

export const MIN_OMI_SECRET_LENGTH = 24;

/** Problems that make a feature unusable, reported once at startup instead of failing later. */
export function configProblems(c = config): string[] {
  const out: string[] = [];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: c.localTz });
  } catch {
    out.push(`LOCAL_TZ "${c.localTz}" is not a valid time zone`);
  }
  if (!c.vaultDir) out.push("VAULT_DIR is not set: notes can't be written");
  else if (!existsSync(join(c.vaultDir, c.inboxDir))) out.push(`${join(c.vaultDir, c.inboxDir)} does not exist`);
  if (c.omiWebhookSecret && c.omiWebhookSecret.length < MIN_OMI_SECRET_LENGTH) {
    out.push(`OMI_WEBHOOK_SECRET must be at least ${MIN_OMI_SECRET_LENGTH} characters (it is the URL's only protection); the Omi routes are off`);
  }
  if ((c.googleClientId || c.googleClientSecret) && !c.googleRedirectUri) out.push("Google is configured but neither PUBLIC_URL nor GOOGLE_REDIRECT_URI is set");
  return out;
}

/** Minimal environment for child processes, so .env secrets never reach claude, bb or Python. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: env.HOME ?? homedir(),
    PATH: env.PATH ?? "/usr/bin:/bin",
    LANG: env.LANG ?? "C.UTF-8",
    ...extra,
  };
}
