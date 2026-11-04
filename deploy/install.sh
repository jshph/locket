#!/usr/bin/env bash
# Installs index-agent as a system service running as the invoking user.
# Usage: sudo ./deploy/install.sh   (env: PORT=8790 FUNNEL_PORT=10000)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
user="${SUDO_USER:?run via sudo from the account that should own the service}"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(cd "$here/.." && pwd)"
home="$(getent passwd "$user" | cut -d: -f6)"
bun="$(sudo -u "$user" -H bash -lc 'command -v bun')" || { echo "bun not found for $user" >&2; exit 1; }
vault="$(sudo -u "$user" bash -c "cd '$dir' && grep -E '^VAULT_DIR=' .env | cut -d= -f2-")"
path="$(dirname "$bun"):$home/.local/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s#@USER@#$user#g" -e "s#@DIR@#$dir#g" -e "s#@HOME@#$home#g" -e "s#@BUN@#$bun#g" \
    -e "s#@PATH@#$path#g" -e "s#@VAULT_DIR@#${vault:-$dir}#g" \
    -e "s#@PORT@#${PORT:-8790}#g" -e "s#@FUNNEL_PORT@#${FUNNEL_PORT:-10000}#g" \
    "$here/index-agent.service.in" > /etc/systemd/system/index-agent.service
chmod 644 /etc/systemd/system/index-agent.service
systemctl daemon-reload
systemctl enable --now index-agent.service
sleep 2
systemctl --no-pager --lines=5 status index-agent.service
