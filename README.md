# Index 01 → new bb thread (Obsidian)

Each ring recording sent to this webhook starts a new top-level bb thread in the `obsidian`
project (`proj_xxxxxxxxxx`, environment `env_xxxxxxxxxx` = `/path/to/vault`), with the
transcript passed verbatim as the prompt (via stdin, no wrapper text).

- Code: `server.ts` (Bun, no deps); tests: `bun test`
- Secret: `.env` with `INDEX_WEBHOOK_SECRET` (never commit / print)
- Service: systemd user unit `index-bb-webhook` (linger enabled), 127.0.0.1:8790
  - `systemctl --user status index-bb-webhook`, logs: `journalctl --user -u index-bb-webhook -f`
- Public URL (Tailscale Funnel :10000): `https://your-host.your-tailnet.ts.net:10000/index`
- Safety: HMAC v1 signature required, 5-min timestamp window, delivery-ID dedupe (7 days),
  max 30 spawns/hour, threads run with permission mode `full` (set by `BB_PERMISSION_MODE` in the systemd unit; code default `auto`)

Env overrides (in the unit or `.env`): `BB_PROJECT`, `BB_ENVIRONMENT`, `BB_PERMISSION_MODE`,
`MAX_SPAWNS_PER_HOUR`.

## Pebble app setup

Index 01 settings → Webhook → pick a gesture → URL above → payload **Transcription only** →
**Sign requests** with the same secret → Send test event → Save. Route that gesture to
**Webhook only** so the Index agent doesn't also act on it.

## Stop / remove

`systemctl --user disable --now index-bb-webhook`, `tailscale funnel --https=10000 off`.
