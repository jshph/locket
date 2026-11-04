# index-agent

A self-hosted replacement for the Pebble Index 01 ring's Index agent. The ring app POSTs a signed
webhook with the transcript; this service saves it, answers immediately, then routes it with
`claude -p` (your Claude subscription, Opus at low effort) into:

| Action | What happens |
|---|---|
| `create_note` | `inbox/YYYY-MM-DD-HH-mm-ss <title>.md` in `/path/to/vault`, quick-capture frontmatter (empty `tags:` and `people:`, `created: '[[date]]'`), transcript verbatim. Obsidian Sync carries it to the phone. |
| `create_reminder` | Todoist task (Todoist parses the due phrase; named lists map to projects, else Inbox). Ported from the app's Todoist plugin. |
| `start_thread` | New bb thread in the `obsidian` project with the transcript verbatim as the prompt (permission mode from `BB_PERMISSION_MODE`). |
| `create_calendar_event` | Google Calendar event (default 1 hour), only when the words "calendar" or "event" were said — the app's hard guard; otherwise it becomes a timed reminder. Offered only once Google is connected. |

Routing rules are ported from the Index agent (`reference/upstream/`). Recordings made before 5am
local time are "late night": "tomorrow" means the day you wake up into (today's date).

## Omi conversations → distilled notes

The Omi app's **Conversation created** webhook POSTs each finished conversation (full diarized
transcript) to `/omi/<OMI_WEBHOOK_SECRET>`. Instead of saving the raw transcript, the service
distills it into one connected note the way the Margins skill does, using your vault as context:

1. The JSON is saved to `state/omi/conversations/` (kept 30 days, never in the vault) and answered
   with 200 at once. Repeated conversation IDs and conversations Omi marked `discarded` are ignored.
2. Conversations less than `OMI_MERGE_GAP_MIN` (10) minutes apart are merged into one note; a group
   is distilled once nothing new has arrived for that long. Groups under `OMI_MIN_WORDS` (40) are
   dropped silently.
3. `claude -p` (Opus, effort `OMI_CLAUDE_EFFORT`, default medium) follows the pinned Margins
   distillation rules (`reference/margins-skill/`), searches with `margins recall`, reads vault
   notes, resolves speakers against `people/`, and writes `inbox/<start time> <title>.md`. It may
   also create up to 3 person notes in `people/` for confirmed participants with no note yet. It
   can decide a capture has nothing worth keeping (background TV, logistics) and write nothing.
4. ntfy reports the note title and any new people; "nothing to keep" arrives as low priority.
   Failures retry after 2m, 10m, 1h, 3h, then send an urgent ntfy; the transcript stays in state.
   At most `OMI_MAX_NOTES_PER_DAY` (30) distillations per 24 hours; extra ones wait.

Guardrails (the transcript is other people's speech, so it is treated as untrusted): Claude Code
permission rules allow reads only inside the vault, Bash only as `margins --workspace obsidian
recall`, and writes only directly in `inbox/` and `people/`; a PreToolUse hook
(`src/omi-guard.ts`) further allows only new files (the assigned note name, one per run; person
notes with plain names, no case-insensitive clash), edits only to files created in that run, and
nothing else. No web, MCP, or other tools.

**Omi app setup:** Settings → Developer Settings → Webhooks → **Conversation created** → URL
`https://your-host.your-tailnet.ts.net:10000/omi/<OMI_WEBHOOK_SECRET>` → Save. Capture and
transcription stay the app's defaults (Omi's cloud transcribes and diarizes). Naming a voice in
the Omi app makes that name come through as the speaker.

Try the distiller without the server: `bun run scripts/omi-distill.ts <payload.json>` (writes a
real note; delete it afterwards). Send a payload through the live endpoint:
`bun run scripts/omi-send.ts <payload.json>`.

## Google Calendar

One-time setup: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` (a "Web application" OAuth
client whose redirect URI is `https://your-host.your-tailnet.ts.net:10000/oauth/google/callback`,
consent screen **In production**), restart the service, then `bun run scripts/google-auth.ts` and
open the printed link. The refresh token is kept in `state/google-token.json` (scope
`calendar.events`). `GOOGLE_CALENDAR_ID` defaults to `primary`.

## Reliability

The phone app sends each webhook once and never retries, so this service owns delivery:

- Every verified delivery is written to `state/jobs/<deliveryId>.json` before the 200 response;
  repeated delivery IDs are ignored.
- Router failures (usage limit, logged out) retry after 30s, 2m, 10m, then fall back to a note.
- Each action retries after 1m, 5m, 15m, 1h, 3h; finished actions never re-run.
- If an action fails for good and no note was written, the transcript is saved as a note.
- ntfy confirms what happened (titles only, never the transcript); problems are sent as high priority.

## Running

- Code: `server.ts`, `src/`; tests: `bun test`
- Secrets in `.env` (never commit or print): `INDEX_WEBHOOK_SECRET`, `TODOIST_API_TOKEN`, `NTFY_TOPIC`,
  `OMI_WEBHOOK_SECRET` (the Omi route is off when it's unset)
- Service: system unit `index-agent` next to `bb-app.service` (`deploy/index-agent.service`);
  install once with `sudo ./deploy/install.sh`. Load new code with `./scripts/restart.sh` (no sudo).
  Logs: `journalctl -u index-agent -f`
- Try the router without side effects: `bun run scripts/route.ts "remind me tomorrow at 9am to call the bank"`
- Public URL (Tailscale Funnel :10000, re-applied by the unit): `https://your-host.your-tailnet.ts.net:10000/index`
- Settings via env: `LOCAL_TZ` (default America/Bogota), `CLAUDE_MODEL`, `CLAUDE_EFFORT`,
  `BB_PROJECT`, `BB_ENVIRONMENT`, `BB_PERMISSION_MODE`, `MAX_SPAWNS_PER_HOUR`, `VAULT_DIR`, `INBOX_DIR`

## Pebble app setup

Index 01 settings → Webhook → gesture → URL above → payload **Transcription only** → **Sign
requests** with `INDEX_WEBHOOK_SECRET` → Send test event → Save. Route that gesture to
**Webhook only**.
