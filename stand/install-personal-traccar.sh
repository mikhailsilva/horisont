#!/usr/bin/env bash
# Install the isolated connector-test API without touching the gateway or its data.
set -euo pipefail

ROOT=/opt/itles
SERVICE=itles-personal-traccar
ENV_DIR=/etc/itles
ENV_FILE=$ENV_DIR/personal-traccar.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo stand/install-personal-traccar.sh)" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null || ! systemctl show-environment >/dev/null 2>&1; then
  echo "systemd is required; no existing gateway or services were changed" >&2
  exit 1
fi
if [ ! -f "$ROOT/stand/personal_traccar.py" ] || [ ! -f "$ROOT/stand/personal-traccar.service" ]; then
  echo "Expected demo files under $ROOT/stand" >&2
  exit 1
fi
if [ ! -e "$ENV_FILE" ]; then
  install -d -m 700 "$ENV_DIR"
  password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  umask 077
  printf 'TRACCAR_DEMO_USER=itles-demo\nTRACCAR_DEMO_PASSWORD=%s\n' "$password" > "$ENV_FILE"
  unset password
  chmod 600 "$ENV_FILE"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
python3 - "$ENV_FILE" <<'PY'
import sys

values = {}
with open(sys.argv[1], encoding="utf-8") as stream:
    for line in stream:
        key, separator, value = line.rstrip("\n").partition("=")
        if separator:
            values[key] = value
if not values.get("TRACCAR_DEMO_USER") or not values.get("TRACCAR_DEMO_PASSWORD"):
    raise SystemExit("Private demo credentials are missing; refusing service install")
PY
install -m 644 "$ROOT/stand/personal-traccar.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE.service"
systemctl --quiet is-active "$SERVICE.service"
printf 'Service: %s (loopback 127.0.0.1:8765)\n' "$SERVICE"
printf 'Login: itles-demo\n'
printf 'Private credentials: %s (root-only; do not paste into chat)\n' "$ENV_FILE"
printf 'The reverse proxy still needs an HTTPS path to this loopback service.\n'
