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
   with 200 at once. Repeated conversation IDs and conversations Omi marked `discarded` are ignored,
   and so are ones Omi labeled `background` (TV, ambient chatter, other people talking) unless you
   said at least `OMI_BACKGROUND_KEEP_OWNER_WORDS` (60) words in them. Ignored conversations never
   merge, so background noise can't glue two real conversations into one note.
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

Guardrails for the distiller (the transcript is other people's speech, so it is treated as untrusted): Claude Code
permission rules allow reads only inside the vault, Bash only as `margins --workspace obsidian
recall`, and writes only directly in `inbox/` and `people/`; a PreToolUse hook
(`src/omi-guard.ts`) further allows only new files (the assigned note name, one per run; person
notes with plain names, no case-insensitive clash), edits only to files created in that run, and
nothing else. No web, MCP, or other tools.

**Omi app setup:**
- Settings → Developer Settings → Webhooks → **Conversation created** →
  `https://your-host.your-tailnet.ts.net:10000/omi/<OMI_WEBHOOK_SECRET>` → Save.
- Settings → Developer Settings → Transcription → **Custom** (the live/WebSocket one) →
  `wss://your-host.your-tailnet.ts.net:10000/stt/<OMI_WEBHOOK_SECRET>`. Live transcription then
  runs here instead of on Omi's metered cloud minutes (Omi exempts custom STT from its
  transcription limit). Without it, everything still works on Omi's transcript.

## Speech service (asr/)

`asr/service.py` (Python, sherpa-onnx on CPU; started and restarted by `server.ts`, localhost
:8791) does three things:

1. **Live transcription** for the Omi app's Custom STT: Silero VAD cuts utterances, Parakeet TDT
   0.6B transcribes them (~20x real time), and each line goes back with `is_user` from the owner's
   voiceprint so Omi's own processing still knows which lines are yours. The raw audio is stored
   in `state/omi/audio/` with wall-clock timing, kept `OMI_AUDIO_RETENTION_DAYS` (7).
2. **Re-transcription after each conversation:** when the webhook arrives, the worker asks the
   service to cut that window from stored audio, re-transcribe it per utterance, label **Me** by
   voiceprint and group the other voices, and hint at known voices ("resembles Dana Okafor"). That
   transcript replaces Omi's for the distiller. Recordings the pendant stored offline are
   transcribed by Omi in its cloud (not in our audio), so those keep Omi's transcript.
3. **Voiceprints** (`state/omi/voices.json`, biometric data about other people, local only):
   - **Enroll yourself once:** wear the pendant and talk alone for about a minute, wait for Omi to
     close the conversation, then `bun run scripts/omi-voice.ts enroll-me latest`. Until then,
     "Me" is guessed as the clearly loudest voice.
   - **People are learned** only when the distiller identified a speaker from strong evidence (a
     name you gave the voice in Omi, a self-introduction, or being addressed by name), the person
     has a `people/` note, and they spoke 10+ seconds. A voice that sounds like yours is never
     learned as someone else. ntfy says "Learned voices: …".
   - `bun run scripts/omi-voice.ts list`, `delete <name>`.

Voice thresholds (`OMI_OWNER_TURN` 0.72, `OMI_OWNER_LIVE` 0.70, `OMI_SAME_SPEAKER` 0.70, `OMI_PERSON_MATCH` 0.70,
`OMI_VOICE_MARGIN` 0.05, `OMI_DIARIZE_THRESHOLD` 0.45) started on synthetic voices; the owner ones were
recalibrated on the real enrollment (your 4–9 s utterances score 0.80–0.82). Revisit
them after real use. Models (~660 MB, `asr/models/`, not in git) come from the sherpa-onnx
releases; set up a new checkout with `cd asr && uv sync` and the download commands in AGENTS.md.

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
