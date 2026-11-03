#!/usr/bin/env bash
# Installs index-agent as a system service next to bb-app.service and retires the user-level unit.
# Usage: sudo ./deploy/install.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
uid="$(id -u dev)"

install -m 644 "$here/index-agent.service" /etc/systemd/system/index-agent.service

# The user-level unit ran this service before; stop it first so the port is free.
sudo -u dev XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user disable --now index-bb-webhook.service 2>/dev/null || true
rm -f /home/you/.config/systemd/user/index-bb-webhook.service
sudo -u dev XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user daemon-reload 2>/dev/null || true

systemctl daemon-reload
systemctl enable --now index-agent.service
sleep 2
systemctl --no-pager --lines=5 status index-agent.service
