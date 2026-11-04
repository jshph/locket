# Agent operating guide

This is a live service: recordings from the owner's devices arrive here and become notes, tasks
and threads. A broken deploy loses nothing (deliveries are saved and retried), but a broken router,
distiller or action quietly degrades results. `README.md` says what it does; this file is how to
operate and change it. **If `AGENTS.local.md` exists, read it too**: it holds this machine's
deployment facts and is never committed.

## Layout

- `server.ts`: HTTP routes (`/index`, `/omi/<secret>`, `/stt/<secret>`, `/healthz`,
  `/oauth/google/callback`), wiring, startup checks, SIGTERM handling
- Ring: `src/webhook.ts` (signature, protocol v1), `src/store.ts` (one job file per delivery),
  `src/router.ts` (`claude -p` routing, adapted from `reference/upstream/`), `src/worker.ts`
  (route once, run actions, retries, fallback note), `src/actions.ts` (note, Todoist, bb thread),
  `src/google.ts` (Calendar)
- Omi: `src/omi.ts` (payload, store, merging), `src/omi-worker.ts` (enrich, group, distill,
  learn voices), `src/distill.ts` (distiller prompt and run), `src/omi-guard.ts` (write guardrail
  hook, entry `scripts/omi-guard.ts`), pinned Margins rules in `reference/margins-skill/`
- Speech: `src/asr.ts` (client, supervisor, `/stt` proxy) and `asr/` (Python: `service.py` live
  STT + `/process` + `/voices`, `engine.py` models, `store.py` audio and voiceprints)
- Shared: `src/util.ts` (log, poller, JSON-file store, `claude -p` runner, fetch with timeout),
  `src/config.ts` (all settings, startup validation)
- `deploy/` (unit template + installer), `scripts/` (restart, dry runs, sends, voiceprints, models)

## Operate

```bash
systemctl status locket --no-pager             # the unit runs as the installing user
journalctl -u locket -f                        # JSON lines; never contains transcripts
ls state/jobs/                                 # one record per ring recording (has transcripts)
ls state/omi/notes/                            # one record per Omi note; runs/<id>/ has claude output
curl -s 127.0.0.1:8791/healthz                 # speech service (child of the unit; restarts itself)
bun run scripts/omi-voice.ts list              # enrolled voiceprints
./scripts/restart.sh                           # load new code: no sudo needed
```

- Restart with `scripts/restart.sh`, never `sudo`: it sends SIGTERM to the service's own process,
  the server finishes the work in progress, and `Restart=always` starts it on the current code.
  Only unit-template changes need the owner to run `sudo ./deploy/install.sh`; ask, don't try.
- Check `state/jobs/*.json` for `"status": "pending"` before risky work; pending jobs resume after
  a restart, but an action cut off mid-call may run twice.
- Startup logs `config problem` lines (and sends one urgent ntfy) for unusable settings.
- Google: the token is read per use; a failed refresh means re-running
  `bun run scripts/google-auth.ts` (the owner opens the printed link).

## Change and verify

1. `bun run check` must pass (strict type check, `bun test`, pytest). Add tests for new logic.
2. Router or prompt changes: dry-run real cases with `bun run scripts/route.ts "<words>" [--at <ISO>]`
   (calls `claude -p` only). Check a note, a reminder, a thread, a calendar event, and your case.
3. `./scripts/restart.sh`, then a live check if actions changed: `bun run scripts/send.ts "<words>"`
   sends a signed delivery like the ring and creates real things. Clean up every one: the vault
   note, the Todoist task (`[todoist <id>]` in the log), the Calendar event (`[gcal <id>]`),
   `bb thread archive <id>`, and `state/jobs/manual-*.json`. Live sends also push ntfy
   notifications to the owner's phone; say so when you run them.
4. Commit with a message saying why; keep `README.md` accurate.

## Speech service

- Live checks write real state: enrolling, streaming to `/stt`, and `/process` leave voiceprints,
  `state/omi/audio/<session>/` and `state/omi/asr-runs/` behind. Delete test voiceprints with
  `scripts/omi-voice.ts delete`, and the test sessions and runs by hand.
- Use synthetic voices for diarization checks (e.g. piper TTS), never real audio of other people.
- Never weaken the learning guard (`learn_cluster` in `asr/service.py`: refuses owner-like voices
  and voices that already match someone else) or `learnVoices` in `src/omi-worker.ts` (strong
  evidence only).
- New checkout: `cd asr && uv sync && ../scripts/download-models.sh`.
- sherpa's Silero VAD must get exactly one 512-sample window per `accept_waveform` call; bigger
  calls silently merge everything into one segment.
- Voices are grouped per pause-delimited utterance, not by pyannote's clusters: pyannote split
  one real speaker into three, and diarized turns can span two people.

## Omi distiller

- It writes into the real vault. Test with `STATE_DIR=/tmp/... bun run scripts/omi-distill.ts
  <payload.json>` (or `--conversation <stored id>`), then delete the note and any person notes.
- Guard changes need tests in `omi.test.ts`; never widen the permission rules in `src/distill.ts`
  without matching guard rules. Never let it edit existing notes.
- Prompt changes: rerun a sample with a known person (should link the existing `people/` note), a
  self-introduced newcomer (should create one person note), and a spoken instruction (ignored).
- Retry a failed note: set its `status` to `pending` and `nextAttemptAt` to 0 in
  `state/omi/notes/<id>.json`, then wait for the next poll or restart.
- Updating the pinned Margins rules: copy `skills/margins/` from the margins repo at the commit
  the installed CLI reports (`margins --version`) and update `reference/margins-skill/PINNED.md`.

## Secrets

`.env` holds the webhook secrets, API tokens and ntfy topic (see `.env.example`);
`state/google-token.json` holds the Calendar refresh token and `state/omi/voices.json` the
voiceprints. Never print, `cat`, or log them; check presence with `grep -oE '^[A-Z_]+=' .env`.
Child processes (`claude`, `bb`, the speech service) get a minimal env (`childEnv()`), never
`.env`. `OMI_WEBHOOK_SECRET` is the path pasted into the Omi app, so rotating it means giving the
owner both new URLs.

## Gotchas

- `claude -p` runs on the owner's Claude subscription; `--bare` can't be used (API keys only).
  Isolation comes from `--tools ''` (router) or the distiller's allow-list, `--strict-mcp-config`,
  `--setting-sources ''`, `--disable-slash-commands`, and an empty working directory.
- The router never writes the owner's words: ring note bodies and thread prompts are the raw
  transcript. It only picks actions, titles and times.
- Calendar events need the words "calendar" or "event" in the transcript (`applyCalendarGuard`,
  as in the upstream app); otherwise they become timed reminders.
- Before 5am local (`LATE_NIGHT_END_HOUR`), "tomorrow" means today's date.
- Pebble app (not fixable here): webhooks are sent once and never retried; webhook-only gestures
  show no notification; keep payload mode "Transcription only" ("Both" can drop the transcript).
- Omi app: in Custom STT mode it logs "Unsupported message type: String" for status messages it
  meant only for Omi's backend; harmless. Pendant recordings synced from offline storage are
  transcribed by Omi, not here.
