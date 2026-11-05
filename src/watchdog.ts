// Notices the two failures that went unseen on 2026-11-04: the phone stopping live audio for hours
// (a capture loop in the Omi app), and audio arriving while Omi produces no conversations (so no
// webhooks, so no notes). One ntfy per episode; another when it recovers. State survives restarts.

import { join } from "node:path";
import { config } from "./config.ts";
import type { Notifier } from "./notify.ts";
import type { OmiStore } from "./omi.ts";
import { JsonDirStore, fetchWithTimeout, log } from "./util.ts";

export type WatchdogState = { id: "watchdog"; silenceAlertedAt?: number; gapAlertedAt?: number };

export type WatchdogInputs = {
  now: number;
  /** Local hour 0-23 in the owner's time zone. */
  localHour: number;
  /** When live audio last reached the speech service; null if it never has. */
  lastAudioMs: number | null;
  /** When Omi last delivered a "Conversation created" webhook; null if never. */
  lastWebhookMs: number | null;
  /**
   * Seconds of live audio received after lastWebhookMs (or ever, if null) and more than
   * gapMinutes ago: audio Omi has had time to close into a conversation and deliver.
   */
  audioSecondsSinceWebhook: number;
};

export type WatchdogConfig = {
  silenceHours: number;
  awakeFrom: number; // local hour, inclusive
  awakeTo: number; // local hour, exclusive
  gapMinutes: number;
  gapMinAudioSeconds: number;
};

export type Alert = { title: string; message: string; urgent?: boolean; quiet?: boolean };

function hoursAgo(ms: number, now: number) {
  return Math.round(((now - ms) / 3_600_000) * 10) / 10;
}

export function evaluate(state: WatchdogState, i: WatchdogInputs, c: WatchdogConfig): { state: WatchdogState; alerts: Alert[] } {
  const next: WatchdogState = { ...state };
  const alerts: Alert[] = [];
  const awake = i.localHour >= c.awakeFrom && i.localHour < c.awakeTo;

  // 1. No live audio for hours while you're up: capture has probably stopped (or you're muted).
  if (i.lastAudioMs !== null) {
    const silent = i.now - i.lastAudioMs >= c.silenceHours * 3_600_000;
    if (silent && awake && !next.silenceAlertedAt) {
      next.silenceAlertedAt = i.now;
      alerts.push({
        title: "Omi: no audio",
        message: `Nothing from the pendant for ${hoursAgo(i.lastAudioMs, i.now)} h. If you're not muted, check the Omi app's Home card; if there's none, the capture loop may be back (see the outage report).`,
        urgent: true,
      });
    } else if (!silent && next.silenceAlertedAt && i.lastAudioMs > next.silenceAlertedAt) {
      delete next.silenceAlertedAt;
      alerts.push({ title: "Omi: audio is back", message: "Live audio is reaching the server again.", quiet: true });
    }
  }

  // 2. Audio keeps arriving but Omi sends no conversations: no webhooks means no notes.
  const gap = i.audioSecondsSinceWebhook >= c.gapMinAudioSeconds;
  if (gap && !next.gapAlertedAt) {
    next.gapAlertedAt = i.now;
    alerts.push({
      title: "Omi: audio but no conversations",
      message: `${Math.round(i.audioSecondsSinceWebhook / 60)} min of audio arrived over an hour ago with no conversation from Omi since${i.lastWebhookMs ? ` (last one ${hoursAgo(i.lastWebhookMs, i.now)} h ago)` : ""}. Its processing may be stalled; notes won't be written for this audio.`,
      urgent: true,
    });
  } else if (next.gapAlertedAt && i.lastWebhookMs !== null && i.lastWebhookMs > next.gapAlertedAt) {
    delete next.gapAlertedAt;
    alerts.push({ title: "Omi: conversations are back", message: "Omi is delivering conversations again.", quiet: true });
  }
  return { state: next, alerts };
}

export function parseAwakeHours(spec: string): [number, number] {
  const m = spec.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return [8, 22];
  return [Math.min(23, Number(m[1])), Math.min(24, Number(m[2]))];
}

function localHour(ms: number, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
}

/** The latest real (not manual test) conversation webhook received. */
export function lastWebhookMs(store: OmiStore): number | null {
  let last: number | null = null;
  for (const c of store.conversations()) {
    if (c.id.startsWith("manual-")) continue;
    last = last === null ? c.receivedAt : Math.max(last, c.receivedAt);
  }
  return last;
}

/** Checks every [everyMs]; requires the speech service (it knows when audio arrived). */
export function startWatchdog(omi: OmiStore, notify: Notifier, everyMs = 10 * 60_000) {
  const files = new JsonDirStore<WatchdogState>(join(config.stateDir, "omi", "watchdog"));
  const [awakeFrom, awakeTo] = parseAwakeHours(config.omiAwakeHours);
  const cfg: WatchdogConfig = {
    silenceHours: config.omiSilenceAlertHours, awakeFrom, awakeTo,
    gapMinutes: config.omiGapAlertMinutes, gapMinAudioSeconds: config.omiGapMinAudioSeconds,
  };
  const check = async () => {
    try {
      const now = Date.now();
      const webhook = lastWebhookMs(omi);
      // Only audio older than the gap window counts: Omi closes a conversation after minutes of
      // silence, so a long conversation still in progress must not look like a stall.
      const until = now - cfg.gapMinutes * 60_000;
      const res = await fetchWithTimeout(`http://127.0.0.1:${config.asrPort}/stats?since_ms=${webhook ?? 0}&until_ms=${until}`, {}, 30_000);
      if (!res.ok) return;
      const s = (await res.json()) as { last_audio_ms: number | null; seconds_since: number };
      const state = files.get("watchdog") ?? { id: "watchdog" };
      const r = evaluate(state, {
        now, localHour: localHour(now, config.localTz), lastAudioMs: s.last_audio_ms,
        lastWebhookMs: webhook, audioSecondsSinceWebhook: s.seconds_since,
      }, cfg);
      files.save("watchdog", r.state);
      for (const a of r.alerts) {
        log("watchdog alert", { title: a.title });
        await notify(a.title, a.message, { urgent: a.urgent, quiet: a.quiet });
      }
    } catch (e) {
      log("watchdog check failed", { error: String(e).slice(0, 200) });
    }
  };
  setTimeout(check, 60_000);
  return setInterval(check, everyMs);
}
