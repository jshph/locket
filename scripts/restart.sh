#!/usr/bin/env bash
# Restarts the service onto the current code without sudo: it runs as this user, so it can be sent
# SIGTERM directly, and the unit's Restart=always starts it again. The unit is "locket" unless
# UNIT says otherwise (installs from before the rename use "index-agent", which is detected).
set -euo pipefail
unit="${UNIT:-locket}"
if [ "$(systemctl show -p MainPID --value "$unit")" = "0" ] && [ -z "${UNIT:-}" ] \
  && [ "$(systemctl show -p MainPID --value index-agent 2>/dev/null)" != "0" ]; then
  unit=index-agent
fi
pid="$(systemctl show -p MainPID --value "$unit")"
[ "$pid" != "0" ] || { echo "$unit is not running" >&2; exit 1; }
kill -TERM "$pid"
for _ in $(seq 1 60); do
  sleep 1
  new="$(systemctl show -p MainPID --value "$unit")"
  if [ "$new" != "0" ] && [ "$new" != "$pid" ] && curl -sf "http://127.0.0.1:${PORT:-8790}/healthz" >/dev/null; then
    echo "$unit restarted (pid $pid -> $new)"
    exit 0
  fi
done
echo "$unit did not come back within 60s; see: journalctl -u $unit -n 50" >&2
exit 1
