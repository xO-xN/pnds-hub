#!/usr/bin/env bash
# PNDS telematic hub — update the live installation at /opt/pnds-hub.
#
#   sudo /opt/pnds-hub/update.sh            # latest release tag
#   sudo /opt/pnds-hub/update.sh v0.2.0     # a specific tag
#
# Fetches the tag, reinstalls dependencies, syncs the systemd unit,
# and restarts the service. The hub restart drops every connected
# site; clients reconnect automatically. Run between performances
# only — see README "Operations".

set -euo pipefail

LIVE_DIR=/opt/pnds-hub
SERVICE_NAME=pnds-hub

if [[ $EUID -ne 0 ]]; then
  echo "error: run as root (sudo $0)" >&2
  exit 1
fi

cd "$LIVE_DIR" 2>/dev/null || { echo "error: $LIVE_DIR not found — run install.sh first" >&2; exit 1; }
git remote get-url origin >/dev/null 2>&1 \
  || { echo "error: no git origin — the live dir must be a git clone (not a zip download)" >&2; exit 1; }

git fetch --tags origin

if [[ $# -ge 1 ]]; then
  TAG=$1
else
  TAG=$(git tag --list 'v*' --sort=-v:refname | head -n 1)
fi
[[ -n "$TAG" ]] || { echo "error: no release tags found" >&2; exit 1; }

OLD=$(git describe --tags 2>/dev/null || echo "untagged")
if [[ "$OLD" == "$TAG" ]]; then
  echo "already at $TAG — nothing to do"
  exit 0
fi

git checkout --detach "$TAG"
npm ci --omit=dev

cp deploy/pnds-hub.service "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl restart "$SERVICE_NAME"

echo "updated: $OLD → $TAG"
echo "verify:  curl http://127.0.0.1:4000/   (health text includes the version)"
