import { expect, test } from "bun:test";
import { evaluate, parseAwakeHours, type WatchdogConfig, type WatchdogInputs, type WatchdogState } from "./src/watchdog.ts";

const H = 3_600_000;
const cfg: WatchdogConfig = { silenceHours: 3, awakeFrom: 8, awakeTo: 22, gapMinutes: 60, gapMinAudioSeconds: 120 };
const T = Date.parse("2026-11-04T15:09:00Z"); // last audio before the outage

function at(hoursLater: number, localHour: number, over: Partial<WatchdogInputs> = {}): WatchdogInputs {
  return { now: T + hoursLater * H, localHour, lastAudioMs: T, lastWebhookMs: T - 8 * H, audioSecondsSinceWebhook: 0, ...over };
}

test("yesterday's outage: one alert three hours into the silence, one when audio returns", () => {
  let s: WatchdogState = { id: "watchdog" };
  let r = evaluate(s, at(2.9, 12), cfg);
  expect(r.alerts).toEqual([]);
  r = evaluate(r.state, at(3.1, 13), cfg);
  expect(r.alerts.map((a) => a.title)).toEqual(["Omi: no audio"]);
  expect(r.alerts[0].urgent).toBe(true);
  r = evaluate(r.state, at(5, 15), cfg);
  expect(r.alerts).toEqual([]); // not repeated
  r = evaluate(r.state, at(12, 22, { lastAudioMs: T + 11.9 * H }), cfg);
  expect(r.alerts.map((a) => a.title)).toEqual(["Omi: audio is back"]);
  expect(r.state.silenceAlertedAt).toBeUndefined();
});

test("silence while asleep, or before any audio ever arrived, stays quiet", () => {
  expect(evaluate({ id: "watchdog" }, at(9, 2), cfg).alerts).toEqual([]);
  expect(evaluate({ id: "watchdog" }, at(9, 12, { lastAudioMs: null }), cfg).alerts).toEqual([]);
});

test("old audio with no conversation since alerts once and clears when Omi delivers again", () => {
  const webhook = T - 8 * H;
  let r = evaluate({ id: "watchdog" }, at(0, 12, { audioSecondsSinceWebhook: 119 }), cfg);
  expect(r.alerts).toEqual([]);
  r = evaluate(r.state, at(0.2, 12, { audioSecondsSinceWebhook: 600 }), cfg);
  expect(r.alerts.map((a) => a.title)).toEqual(["Omi: audio but no conversations"]);
  expect(r.alerts[0].message).toContain("10 min of audio");
  r = evaluate(r.state, at(0.4, 12, { audioSecondsSinceWebhook: 900 }), cfg);
  expect(r.alerts).toEqual([]);
  r = evaluate(r.state, at(1, 13, { lastWebhookMs: T + 0.9 * H, audioSecondsSinceWebhook: 0 }), cfg);
  expect(r.alerts.map((a) => a.title)).toEqual(["Omi: conversations are back"]);
  expect(webhook).toBeLessThan(T);
});

test("awake hours parse with a safe default", () => {
  expect(parseAwakeHours("7-23")).toEqual([7, 23]);
  expect(parseAwakeHours("nonsense")).toEqual([8, 22]);
});
