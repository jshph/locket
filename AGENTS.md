# Agent operating guide

This service is live: every Hold & Talk recording from the user's Index 01 ring arrives here. A
broken deploy loses nothing (jobs are saved and retried), but a broken router or action quietly
degrades into fallback notes. Read `README.md` for what it does; this file is how to operate it.

## Layout

- `server.ts`: HTTP (`/index` webhook, `/healthz`, `/oauth/google/callback`), wiring, SIGTERM handling
- `src/webhook.ts`: signature check (protocol v1). `src/store.ts`: one job file per delivery
- `src/router.ts`: `claude -p` routing; prompt and schema ported from `reference/upstream/`
- `src/worker.ts`: route once, run actions, retries, fallback note, ntfy summary
- `src/actions.ts`: vault note, Todoist, bb thread. `src/google.ts`: Calendar OAuth and events
- `deploy/`: system unit + install script. `scripts/`: restart, dry-run routing, signed send, Google sign-in

## Operate

```bash
systemctl status index-agent --no-pager        # system unit, runs as dev
journalctl -u index-agent -f                   # JSON lines; never contains transcripts
ls state/jobs/                                 # one record per recording (has transcripts)
./scripts/restart.sh                           # load new code: no sudo needed
```

- Restart with `scripts/restart.sh`, never `sudo`. It sends SIGTERM to the service's own process
  (owned by `dev`); the server finishes the job in progress and systemd's `Restart=always` starts
  it on the current code. Only changes to `deploy/index-agent.service` itself need the user to run
  `sudo ./deploy/install.sh`; ask them, don't try.
- Check `state/jobs/*.json` for `"status": "pending"` before risky work; pending jobs resume after
  a restart, but an action cut off mid-call may run twice.
- The Google connection is read per recording; adding or removing `state/google-token.json`
  takes effect without a restart. A failed refresh means re-running `bun run scripts/google-auth.ts`
  (the user opens the printed link).

## Change and verify

1. `bun test` must pass. Add a test for new logic; the worker, store and webhook are tested
   with fakes in `server.test.ts`.
2. Router or prompt changes: dry-run real cases with `bun run scripts/route.ts "<words>" [--at <ISO>]`
   (calls `claude -p` only, no side effects). Check at least a note, a reminder, a thread, a
   calendar event, and the case your change targets.
3. `./scripts/restart.sh`, then a live check if actions changed: `bun run scripts/send.ts "<words>"`
   sends a signed delivery like the ring. It creates real things. Clean up every one of them:
   delete the vault note, delete the Todoist task (`[todoist <id>]` in the log), delete the Calendar
   event (`[gcal <id>]`), `bb thread archive <id>`, and remove `state/jobs/manual-*.json`. Live
   sends also push an ntfy notification to the user's phone; say so when you run them.
4. Commit with a message saying why; keep `README.md` accurate for the user.

## Secrets

`.env` holds `INDEX_WEBHOOK_SECRET`, `TODOIST_API_TOKEN`, `NTFY_TOPIC`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`; `state/google-token.json` holds the Calendar refresh token. Never print,
`cat`, or log them; check presence with `grep -oE '^[A-Z_]+=' .env`. To change one, run
`bb secret request <NAME> --write-env /path/to/index-agent/.env` so the user enters it.
Child processes (`claude`, `bb`) get a minimal env (`childEnv()`), never `.env`. 

## Gotchas

- `claude -p` runs on the user's Claude subscription. `--bare` can't be used (API keys only).
  Isolation comes from `--tools ''`, `--strict-mcp-config`, `--setting-sources ''`,
  `--disable-slash-commands`, and the empty `state/claude-cwd`. Usage limits or an expired login
  show up as route retries, then fallback notes and an urgent ntfy.
- The model never writes the user's words: note bodies and thread prompts are the raw transcript
  (the model once trimmed "Note to self:"). It only picks actions, titles and times.
- Calendar events need the words "calendar" or "event" in the transcript (`applyCalendarGuard`,
  ported from the app); otherwise they become timed reminders.
- Times: `LOCAL_TZ` (America/Bogota, inferred from vault file times). Before 5am local
  (`LATE_NIGHT_END_HOUR`), "tomorrow" means today's date. Recurring phrases go to Todoist as said.
- Notes match `templates/quick capture.md` in the vault: empty `tags:` and `people:`. Don't add tags.
- Phone side (Pebble app, not fixable here): webhooks are sent once and never retried; webhook-only
  gestures show no notification; transcription gives up for good after 45s on slow networks; payload
  mode "Both" can drop the transcript, so keep "Transcription only". Typed text in the app goes to
  Core's agent and to this webhook.
- Public URL is Tailscale Funnel on :10000 (the only free Funnel port; 443/8443 are tailnet-only
  serves). bb Connect port shares can't be used for webhooks (owner session only).
- `deploy/index-agent.service` re-applies the Funnel on start; `tailscale funnel status` to check.
