// Google Calendar: one-time OAuth sign-in through this server's public callback, then events are
// created with a refresh token kept in state/google-token.json (never in logs or .env).
// Scope is calendar.events only: create/edit events, no access to calendar settings or sharing.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { fetchWithTimeout } from "./util.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const PENDING_TTL_MS = 15 * 60_000;

const tokenPath = () => join(config.stateDir, "google-token.json");
const pendingPath = () => join(config.stateDir, "google-oauth-pending.json");

function writePrivate(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  chmodSync(path, 0o600);
}

export function calendarConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && existsSync(tokenPath()));
}

/** Starts a sign-in: remembers a one-time state + PKCE verifier and returns the URL to open. */
export function beginGoogleAuth(nowMs = Date.now()): string {
  if (!config.googleClientId || !config.googleClientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  writePrivate(pendingPath(), { state, verifier, expiresAt: nowMs + PENDING_TTL_MS });
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // always return a refresh token, even on re-consent
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/** Handles Google's redirect. Only the pending, unexpired state is accepted, and only once. */
export async function finishGoogleAuth(url: URL, nowMs = Date.now()): Promise<Response> {
  const page = (msg: string, status = 200) =>
    new Response(`<!doctype html><meta name=viewport content="width=device-width"><p>${msg}</p>`, {
      status, headers: { "content-type": "text/html; charset=utf-8" },
    });
  if (!existsSync(pendingPath())) return page("No sign-in in progress.", 400);
  const pending = JSON.parse(readFileSync(pendingPath(), "utf8"));
  if (url.searchParams.get("state") !== pending.state || nowMs > pending.expiresAt) {
    return page("This sign-in link is invalid or expired. Start again.", 400);
  }
  unlinkSync(pendingPath());
  const error = url.searchParams.get("error");
  if (error) return page(`Google sign-in failed: ${error.replace(/[<>&"]/g, "")}`, 400);
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code") ?? "",
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) return page(`Token exchange failed (HTTP ${res.status}).`, 502);
  writePrivate(tokenPath(), { refresh_token: json.refresh_token, scope: json.scope, savedAt: nowMs });
  accessCache = null;
  return page("Google Calendar connected. You can close this page.");
}

let accessCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (accessCache && Date.now() < accessCache.expiresAt - 60_000) return accessCache.token;
  const { refresh_token } = JSON.parse(readFileSync(tokenPath(), "utf8"));
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token refresh failed (HTTP ${res.status} ${json.error ?? ""}); re-run the sign-in`);
  }
  accessCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return accessCache.token;
}

/** Adds [minutes] to a local wall-clock "YYYY-MM-DDTHH:MM" without involving time zones. */
export function addMinutesLocal(local: string, minutes: number): string {
  const d = new Date(`${local}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

export async function createCalendarEvent(a: {
  title: string; start: string; end?: string; location?: string; description?: string;
}): Promise<string> {
  if (!calendarConfigured()) throw new Error("Google Calendar is not connected");
  // Default length matches the app: 1 hour; an end at or before the start is ignored.
  const end = a.end && a.end > a.start ? a.end : addMinutesLocal(a.start, 60);
  const tz = config.localTz;
  const body: Record<string, unknown> = {
    summary: a.title,
    start: { dateTime: `${a.start}:00`, timeZone: tz },
    end: { dateTime: `${end}:00`, timeZone: tz },
  };
  if (a.location) body.location = a.location;
  if (a.description) body.description = a.description;
  const res = await fetchWithTimeout(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.googleCalendarId)}/events`,
    { method: "POST", headers: { Authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new Error(`Google Calendar HTTP ${res.status}: ${JSON.stringify(json.error ?? {}).slice(0, 200)}`);
  return `${a.title}, ${a.start.replace("T", " ")}–${end.slice(11)} [gcal ${json.id}]`;
}
