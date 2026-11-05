# locket

A self-hosted agent for wearable capture devices. Recordings from a **Pebble Index 01** ring and
an **Omi** pendant arrive at your own server and become notes in your Markdown vault (Obsidian or
any folder), Todoist tasks, Google Calendar events, or [bb](https://getbb.app) agent threads. It
runs on your Claude subscription through `claude -p`, and Omi audio can be transcribed and
speaker-identified locally on CPU, so it never uses Omi's metered cloud transcription.

- **Ring:** each Hold & Talk recording is routed by Claude into a note, reminder, calendar event or
  thread, following the Index app's own rules (adapted from its source).
- **Omi:** each finished conversation is distilled into one connected note, using
  [Margins](https://github.com/byenzyme/margins) rules and recall over your vault. Speakers are
  matched to your `people/` notes. Raw transcripts stay out of the vault.
- **Speech service:** Parakeet transcription, voice activity detection, and voiceprint
  speaker identification, all local ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)).

It is built for one person on one machine, and assumes a fair amount of tooling (below).

## Requirements

- Linux with systemd, [Bun](https://bun.sh) ≥ 1.2, [uv](https://docs.astral.sh/uv/), Python 3.12
- [Claude Code](https://claude.com/claude-code) logged in to a Claude subscription (`claude -p`)
- [Tailscale](https://tailscale.com) on this machine and your phone. Omi's webhook comes from
  Omi's cloud, so it needs a public HTTPS URL ([Funnel](https://tailscale.com/kb/1223/funnel));
  the ring webhook stays tailnet-only. The unit re-applies both on start.
- For Omi distillation: the [Margins](https://github.com/byenzyme/margins) CLI with a Workspace
  over your vault (`margins init <vault>`), so the distiller can run `margins recall`.
- Optional: Todoist API token, a Google OAuth client, bb, an [ntfy](https://ntfy.sh) topic for
  phone notifications.
- About 2 GB RAM for the speech service and 660 MB for its models. A recent 8-core CPU
  transcribes ~20x faster than real time.

## Setup

```bash
git clone https://github.com/jshph/locket && cd locket
bun install
cp .env.example .env            # fill it in (see comments)
(cd asr && uv sync) && ./scripts/download-models.sh
bun run check                   # type check + tests
sudo ./deploy/install.sh        # systemd unit as your user; PORT=8790 FUNNEL_PORT=10000 by default
```

Load new code later with `./scripts/restart.sh` (no sudo). Logs: `journalctl -u locket -f`.
Startup checks report unusable settings in the log (and one ntfy).

### Pebble Index 01

The ring webhook can start agent threads, so it is never on the public internet: it's served
only on the private listener, which the unit exposes on your tailnet at
`https://<host>.<tailnet>.ts.net:9443`. The Pebble app posts from your phone, so the phone must be
on the tailnet (Tailscale running).

Index settings → Webhook → choose a gesture → URL `https://<host>.<tailnet>.ts.net:9443/index` → payload
**Transcription only** → **Sign requests** with `INDEX_WEBHOOK_SECRET` → Send test event →
Save. Route that gesture to **Webhook only**. Try the router without side effects:
`bun run scripts/route.ts "remind me tomorrow at 9am to call the bank"`.

### Omi

In the Omi app, Settings → Developer Settings:

- **Webhooks → Conversation created:** `<PUBLIC_URL>/omi/<OMI_WEBHOOK_SECRET>`
- **Transcription → Custom** (the live/WebSocket one): `wss://<host>/stt/<OMI_WEBHOOK_SECRET>`.
  This is optional. Without it, Omi's cloud transcribes and diarizes, and that counts against
  your Omi plan.

Then enroll your voice once: wear the pendant and talk alone for about a minute. When Omi has
closed the conversation, run `bun run scripts/omi-voice.ts enroll-me latest`. It needs 15 s of a
single voice; aim for 45–60 s.

### Google Calendar (optional)

Create a "Web application" OAuth client with redirect URI `<PUBLIC_URL>/oauth/google/callback`
and the consent screen **In production**. Put the ID and secret in `.env`, restart, run
`bun run scripts/google-auth.ts` and open the printed link. The scope is `calendar.events` only.

## How it works

### Ring recordings

| Action | Result |
|---|---|
| `create_note` | `<INBOX_DIR>/YYYY-MM-DD-HH-mm-ss <title>.md` with the transcript verbatim, empty `tags:`/`people:` frontmatter and `created: '[[date]]'` |
| `create_reminder` | Todoist task; Todoist parses the due phrase, and named lists map to projects |
| `start_thread` | bb thread with the transcript verbatim as the prompt |
| `create_calendar_event` | Google Calendar event (default 1 hour). Only when "calendar" or "event" was said, as in the app; otherwise it becomes a timed reminder |

Before 5am local time, "tomorrow" means the day you wake up into.

The ring app sends each webhook once and never retries, so this service owns delivery:
- Every verified delivery is saved before the 200 response, and duplicates are ignored.
- Routing retries after 30 s, 2 m and 10 m, then falls back to a note.
- Actions retry after 1 m, 5 m, 15 m, 1 h and 3 h, and finished actions never re-run.
- If an action fails for good and no note was written, the transcript is saved as a note.

### Omi conversations

1. **Received:** the webhook JSON is saved under `state/omi/` (30 days) and acknowledged at once.
   Conversations Omi discarded are ignored, and so are ones it labeled `background` (TV, ambient
   chatter) unless you said 60+ words in them.
2. **Re-transcribed:** with the speech service on, that conversation's window is cut from the
   stored audio. Each utterance is transcribed, **Me** is found by your voiceprint, other voices
   are grouped, and known voices are hinted ("resembles Dana Okafor"). Recordings the pendant
   stored offline are transcribed by Omi and keep Omi's transcript.
3. **Merged:** conversations less than 10 minutes apart form one note.
4. **Distilled:** `claude -p` follows the Margins rules, searches the vault with `margins recall`,
   resolves speakers against `people/`, and writes one note. It may create up to 3 person notes
   for confirmed participants. It can also decide there's nothing worth keeping.
5. **Learned:** a speaker identified from strong evidence becomes that person's voiceprint.
   Strong evidence means a name you gave the voice in Omi, a self-introduction, or being
   addressed by name; the person also needs an existing note and 10+ s of speech. A voice that
   sounds like yours is never learned as someone else.

ntfy reports note titles, new people and learned voices. Failures retry, then alert; a
transcript is never dumped into the vault as a fallback.

**Distiller guardrails.** The transcript is other people's speech, so it is treated as
untrusted. Claude Code permission rules allow:
- reads only inside the vault;
- Bash only as `margins --workspace <id> recall "<query>"`;
- writes only directly in the inbox and `people/` folders.

A PreToolUse hook (`src/omi-guard.ts`) adds stricter rules:
- only new files;
- the assigned note name, one note per run;
- plainly named person notes, with no case-insensitive clash with an existing one;
- edits only to files created in that run;
- no path or search pattern outside the vault.

No web or MCP tools are available.

**Privacy.**
- Raw audio is kept `OMI_AUDIO_RETENTION_DAYS` (default 7) in `state/omi/audio/`.
- Voiceprints are biometric data about you and the people you talk with, and some places
  regulate collecting them. They stay in `state/omi/voices.json`; list or delete them with
  `scripts/omi-voice.ts list|delete <name>`.

## Monitoring and recovery

- **Watchdog:** ntfy alerts when live audio stops for 3 h while you're up, or when audio older than
  an hour never became an Omi conversation; one more when it recovers.
- **Pendant tool:** `uv run scripts/pendant/omi_pendant.py status|clear --yes` on a Mac reads or
  clears the pendant's stored audio over Bluetooth (close the phone app first; see AGENTS.md).

## Configuration

Everything is set in `.env` (see `.env.example`). The commonly tuned settings:

| Variable | Default | Meaning |
|---|---|---|
| `OMI_MERGE_GAP_MIN` | 10 | Conversations closer than this become one note |
| `OMI_MIN_WORDS` | 40 | Shorter groups are dropped without a model call |
| `OMI_MAX_NOTES_PER_DAY` | 30 | Distillations per 24 h; extra ones wait |
| `OMI_CLAUDE_EFFORT`, `CLAUDE_MODEL`, `CLAUDE_EFFORT` | medium, opus, low | Distiller and router settings |
| `OMI_OWNER_TURN`, `OMI_OWNER_LIVE` | 0.72, 0.70 | Voiceprint similarity for "Me" (post-conversation, live) |
| `OMI_SAME_SPEAKER`, `OMI_PERSON_MATCH`, `OMI_VOICE_MARGIN` | 0.70, 0.70, 0.05 | Grouping voices, naming known voices |

The voice thresholds come from one real enrollment on the pendant, where the owner's own 4–9 s
utterances scored 0.80–0.82. Check them against your own audio.

## Development

`bun run check` runs the strict type check, `bun test` and the Python tests. `AGENTS.md` is the
operating guide for coding agents (and humans) working on a live install: dry runs, live checks
and their cleanup, and invariants not to break.

## License

GPL-3.0. Parts are adapted from the Pebble mobile app (GPL-3.0) and the Margins skill
(Apache-2.0). Model licenses and other attributions are in [NOTICE.md](NOTICE.md).
