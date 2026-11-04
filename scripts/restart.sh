#!/usr/bin/env bash
# Restarts the index-agent service onto the current code without sudo: the service runs as this
# user, so it can be sent SIGTERM directly, and the unit's Restart=always starts it again.
set -euo pipefail
pid="$(systemctl show -p MainPID --value index-agent)"
[ "$pid" != "0" ] || { echo "index-agent is not running" >&2; exit 1; }
kill -TERM "$pid"
for _ in $(seq 1 60); do
  sleep 1
  new="$(systemctl show -p MainPID --value index-agent)"
  if [ "$new" != "0" ] && [ "$new" != "$pid" ] && curl -sf "http://127.0.0.1:${PORT:-8790}/healthz" >/dev/null; then
    echo "index-agent restarted (pid $pid -> $new)"
    exit 0
  fi
done
echo "index-agent did not come back within 60s; see: journalctl -u index-agent -n 50" >&2
exit 1
