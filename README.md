# index-agent

A self-hosted replacement for the Pebble Index 01 ring's Index agent. The ring app POSTs a signed
webhook with the transcript; this service saves it, answers immediately, then routes it with
`claude -p` (your Claude subscription, Opus at low effort) into:

| Action | What happens |
|---|---|
| `create_note` | `inbox/YYYY-MM-DD-HH-mm-ss <title>.md` in `/path/to/vault`, quick-capture frontmatter (`tags: [index]`, `people:`, `created: '[[date]]'`), transcript verbatim. Obsidian Sync carries it to the phone. |
| `create_reminder` | Todoist task (Todoist parses the due phrase; named lists map to projects, else Inbox). Ported from the app's Todoist plugin. |
| `start_thread` | New bb thread in the `obsidian` project with the transcript verbatim as the prompt (permission mode from `BB_PERMISSION_MODE`). |

Routing rules are ported from the Index agent (`reference/upstream/`). Calendar events are not
connected yet; calendar requests become reminders.

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
- Secrets in `.env` (never commit or print): `INDEX_WEBHOOK_SECRET`, `TODOIST_API_TOKEN`, `NTFY_TOPIC`
- Service: system unit `index-agent` next to `bb-app.service` (`deploy/index-agent.service`);
  install with `sudo ./deploy/install.sh`. Logs: `journalctl -u index-agent -f`
- Public URL (Tailscale Funnel :10000, re-applied by the unit): `https://your-host.your-tailnet.ts.net:10000/index`
- Settings via env: `LOCAL_TZ` (default America/Bogota), `CLAUDE_MODEL`, `CLAUDE_EFFORT`,
  `BB_PROJECT`, `BB_ENVIRONMENT`, `BB_PERMISSION_MODE`, `MAX_SPAWNS_PER_HOUR`, `VAULT_DIR`, `INBOX_DIR`

## Pebble app setup

Index 01 settings → Webhook → gesture → URL above → payload **Transcription only** → **Sign
requests** with `INDEX_WEBHOOK_SECRET` → Send test event → Save. Route that gesture to
**Webhook only**.
