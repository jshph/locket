// Decides what a transcript should become by running `claude -p` on the user's Claude
// subscription. The model only picks actions and short fields; the transcript itself is carried
// by our code so notes and thread prompts stay verbatim (as the app's create_note does).
//
// Rules are ported from the Index agent (reference/upstream/agent@dbc937e: IndexAgentNenya.kt
// and the reminder/list/calendar tool descriptions).

import { childEnv, config } from "./config.ts";
import { mkdirSync } from "node:fs";
import { calendarConfigured } from "./google.ts";
import { join } from "node:path";

export type RouterAction =
  | { tool: "create_note"; title: string }
  | { tool: "create_reminder"; title: string; due?: string; lead_hours?: number; list?: string }
  | { tool: "start_thread"; title: string }
  | { tool: "create_calendar_event"; title: string; start: string; end?: string; location?: string; description?: string };

const PROMPT_HEAD = `You route one voice note from the user's Index 01 ring into actions. You never talk to the user; you only return JSON.

Actions:
- create_note: save a note, idea, thought, or fact to remember. title = a 3-7 word, lowercase, natural-language name that captures the note's essence (e.g. "first dates as communal discovery", "chat with rui about pricing"). The user's words are saved verbatim by the system; do not restate them.
- create_reminder: a to-do. Use for "remind me to...", "remember to <do something>", a task paired with a future date or time (e.g. "Thursday at 2pm try the agent SDK", "tomorrow: call the bank", "in 20 minutes take the bread out"), and items for a named list (shopping, groceries, to-do). title = the task in short imperative form, e.g. "Call the bank". due = only a date/time the user actually said, in English; rewrite relative dates as absolute ones using the recording time (e.g. "Nov 4 2026 at 3pm", "in 20 minutes" -> "Nov 3 2026 at 12:54am"), but keep recurring phrases as said (e.g. "every monday at 9am"). Omit due when no time was given. lead_hours = only if the user asked to be reminded a certain time before. list = the list name if the user named one (e.g. "Shopping"); one action per item when several items go on a list.
{{CALENDAR_ACTION}}- start_thread: hand open-ended work to an AI agent that has full access to the user's Obsidian vault and the web. Use for research, drafting, writing, analysis, planning, answering questions, summarizing or reorganizing their notes, or anything else the other actions can't do. title = a short description of the work. The system passes the user's full words to the agent.

Interpretation rules:
- Unless the user asks for something else, create a note. Do not assume an action that wasn't requested. When a request is ambiguous, lean towards a note.
- "Remember to <do something>" means "remind me to": a reminder, with no due if no time was said. "Remember that <fact>" is a note.
- A bare duration with no task (e.g. "20 minutes") is a note.
- Late at night (a "Late night" line follows the recording time), the user hasn't slept yet: "tomorrow" means the day they wake up into, which is the date given on that line, and "tomorrow morning" is that date's morning. Resolve other relative days ("Friday", "in 2 days") from that same date.
- Never invent or guess times. If the user started to give a time but it was cut off (e.g. "remind me at"), do not create a reminder; create a note instead.
{{CALENDAR_RULE}}
- Prioritise the first action the user requests. Do not also create a note when you already took another requested action.
- Always return at least one action.`;

// Ported from CreateCalendarEventTool.kt (description + extraContext).
const CALENDAR_ACTION = `- create_calendar_event: ONLY when the user literally says "calendar" or "event" while asking to create one, e.g. "add an event to my calendar", "put an event on my calendar for Friday at 3pm". Requires a clear, specific date and time spoken by the user. start = local wall-clock time "YYYY-MM-DDTHH:MM" resolved from the recording time. end = same format, only if the user gave an end time or a duration (compute it from the start); omit for the default 1-hour event. location / description only if the user said them.
`;
const CALENDAR_RULE_ON = `- The words "schedule", "create", "book", "meeting", "appointment" or "time" on their own NEVER mean a calendar event; "schedule time with X" or "book an appointment" are reminders or notes. "Remind me" or a to-do is a reminder, never an event. On the edge between a reminder and an event, prefer the reminder. If an event's time is vague, ambiguous or missing, create a note instead.`;
const CALENDAR_RULE_OFF = `- Calendar events are not available. If the user asks to add an event to their calendar with a clear spoken time, create a reminder with that time instead. "Schedule time with X", "book", "meeting" or "appointment" without a time are reminders or notes, never invent a time.`;

export function systemPrompt(calendar: boolean): string {
  return PROMPT_HEAD
    .replace("{{CALENDAR_ACTION}}", calendar ? CALENDAR_ACTION : "")
    .replace("{{CALENDAR_RULE}}", calendar ? CALENDAR_RULE_ON : CALENDAR_RULE_OFF);
}

const titleField = { type: "string", minLength: 1 };
const localTime = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" };
const CALENDAR_SCHEMA = {
  type: "object", additionalProperties: false, required: ["tool", "title", "start"],
  properties: {
    tool: { const: "create_calendar_event" }, title: titleField, start: localTime, end: localTime,
    location: { type: "string" }, description: { type: "string" },
  },
};

export function actionsSchema(calendar: boolean) {
  const schema = structuredClone(BASE_SCHEMA);
  if (calendar) schema.properties.actions.items.anyOf.push(CALENDAR_SCHEMA as any);
  return schema;
}

const BASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object", additionalProperties: false, required: ["tool", "title"],
            properties: { tool: { const: "create_note" }, title: titleField },
          },
          {
            type: "object", additionalProperties: false, required: ["tool", "title"],
            properties: {
              tool: { const: "create_reminder" }, title: titleField,
              due: { type: "string" }, lead_hours: { type: "number" }, list: { type: "string" },
            },
          },
          {
            type: "object", additionalProperties: false, required: ["tool", "title"],
            properties: { tool: { const: "start_thread" }, title: titleField },
          },
        ],
      },
    },
  },
};

/** Before this local hour a recording counts as "late night": the user's day hasn't ended yet. */
export const LATE_NIGHT_END_HOUR = 5;

export function routerUserMessage(transcript: string, recordedAt: number, tz: string): string {
  const at = new Date(recordedAt);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(at);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(at));
  const lateNight = hour < LATE_NIGHT_END_HOUR
    ? `\nLate night: "tomorrow" means ${new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", month: "long", day: "numeric",
    }).format(at)} (today's date), not the day after.`
    : "";
  return `Recorded: ${when} (${tz})${lateNight}\nTranscript:\n${transcript}`;
}

/** Validates the model's structured output; anything malformed is an error, never a guess. */
export function parseActions(structured: unknown): RouterAction[] {
  const actions = (structured as { actions?: unknown })?.actions;
  if (!Array.isArray(actions)) throw new Error("router output has no actions array");
  return actions.map((a: any) => {
    const title = typeof a?.title === "string" ? a.title.trim() : "";
    if (!title) throw new Error("router action without title");
    switch (a.tool) {
      case "create_note":
      case "start_thread":
        return { tool: a.tool, title };
      case "create_calendar_event": {
        const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
        if (typeof a.start !== "string" || !local.test(a.start)) throw new Error("calendar event without a valid start");
        const e: RouterAction = { tool: "create_calendar_event", title, start: a.start };
        if (typeof a.end === "string" && local.test(a.end)) e.end = a.end;
        if (typeof a.location === "string" && a.location.trim()) e.location = a.location.trim();
        if (typeof a.description === "string" && a.description.trim()) e.description = a.description.trim();
        return e;
      }
      case "create_reminder": {
        const r: RouterAction = { tool: "create_reminder", title };
        if (typeof a.due === "string" && a.due.trim()) r.due = a.due.trim();
        if (typeof a.lead_hours === "number" && a.lead_hours > 0) r.lead_hours = a.lead_hours;
        if (typeof a.list === "string" && a.list.trim()) r.list = a.list.trim();
        return r;
      }
      default:
        throw new Error(`router returned unknown tool ${JSON.stringify(a?.tool)}`);
    }
  });
}

/**
 * The app's deterministic trigger guard (CreateCalendarEventTool.mentionsCalendarOrEvent): an
 * event is only created when the user's words contain "calendar" or "event(s)". Anything else
 * the model proposed as an event becomes a reminder at the same time, so the time isn't lost.
 */
const TRIGGER_WORDS = /\b(calendar|events?)\b/i;
export function applyCalendarGuard(actions: RouterAction[], transcript: string): RouterAction[] {
  if (TRIGGER_WORDS.test(transcript)) return actions;
  return actions.map((a) =>
    a.tool === "create_calendar_event"
      ? { tool: "create_reminder", title: a.title, due: a.start.replace("T", " ") }
      : a);
}

export type Router = (transcript: string, recordedAt: number) => Promise<RouterAction[]>;

const ROUTER_TIMEOUT_MS = 90_000;

export const claudeRouter: Router = async (transcript, recordedAt) => {
  // Empty working directory so no project CLAUDE.md, memory or settings are picked up.
  const calendar = calendarConfigured();
  const cwd = join(config.stateDir, "claude-cwd");
  mkdirSync(cwd, { recursive: true });
  const proc = Bun.spawn([
    config.claudeBin, "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(actionsSchema(calendar)),
    "--system-prompt", systemPrompt(calendar),
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--model", config.claudeModel,
    "--effort", config.claudeEffort,
  ], {
    cwd,
    env: childEnv(),
    stdin: new TextEncoder().encode(routerUserMessage(transcript, recordedAt, config.localTz)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), ROUTER_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`);
    const result = JSON.parse(out);
    if (result.is_error) {
      throw new Error(`claude error ${result.api_error_status ?? ""}: ${String(result.result ?? "").slice(0, 300)}`);
    }
    return applyCalendarGuard(parseActions(result.structured_output), transcript);
  } finally {
    clearTimeout(timer);
  }
};
