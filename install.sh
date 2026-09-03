#!/usr/bin/env bash
# PNDS telematic hub — one-shot installer for a Linux VPS.
#
# From a clone of this repository:
#   sudo ./install.sh
#
# What it does:
#   1. Copies the repository to /opt/pnds-hub (skipped when already
#      cloned there; .git is preserved so update.sh keeps working)
#   2. Installs dependencies (npm ci)
#   3. Generates HUB_TOKEN into /opt/pnds-hub/hub.env
#      (chmod 600; an existing hub.env is never overwritten, so
#      reinstalls keep the token)
#   4. Installs and starts the pnds-hub systemd service
#
# Requires: root, git, Node.js >= 18, npm.

set -euo pipefail

LIVE_DIR=/opt/pnds-hub
SERVICE_NAME=pnds-hub

if [[ $EUID -ne 0 ]]; then
  echo "error: run as root (sudo ./install.sh)" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "error: node not found — install Node.js >= 18 first" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "error: npm not found" >&2; exit 1; }
node -e 'const [major] = process.versions.node.split("."); if (Number(major) < 18) process.exit(1)' \
  || { echo "error: Node.js >= 18 required (found $(node --version))" >&2; exit 1; }

SRC_DIR=$(cd "$(dirname "$0")" && pwd)

# 1. Source tree → live directory
if [[ "$SRC_DIR" != "$LIVE_DIR" ]]; then
  mkdir -p "$LIVE_DIR"
  cp -a "$SRC_DIR/." "$LIVE_DIR/"
fi
cd "$LIVE_DIR"

# 2. Dependencies
npm ci --omit=dev

# 3. Secrets — never overwrite an existing token (idempotent reinstall)
ENV_FILE="$LIVE_DIR/hub.env"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN=$(openssl rand -hex 24)
  cat > "$ENV_FILE" <<EOF
# PNDS telematic hub configuration — chmod 600, root only.
HUB_TOKEN=$TOKEN
# Loopback by default: expose the hub through a TLS reverse proxy
# (see README "TLS"). For a plain-WS quick test without a proxy,
# set HUB_HOST=0.0.0.0 and restart the service.
HUB_HOST=127.0.0.1
HUB_PORT=4000
EOF
  chmod 600 "$ENV_FILE"
  GENERATED=yes
else
  GENERATED=no
fi

# 4. systemd
cp deploy/pnds-hub.service "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

LISTEN_HOST=$(sed -n 's/^HUB_HOST=//p' "$ENV_FILE")
LISTEN_PORT=$(sed -n 's/^HUB_PORT=//p' "$ENV_FILE")

echo
echo "installed: pnds-hub v$(node -p "require('./package.json').version")"
if [[ "$GENERATED" == yes ]]; then
  echo "HUB_TOKEN (new — record it, every site needs it): $TOKEN"
else
  echo "HUB_TOKEN: kept existing $ENV_FILE"
fi
echo "listening: ${LISTEN_HOST}:${LISTEN_PORT} (loopback until a reverse proxy fronts it)"
echo "logs:      journalctl -u $SERVICE_NAME -f"
