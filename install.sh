#!/bin/bash
# Installs Local AI for this user: the files, a service that keeps the server running, and an app-menu entry on Omarchy.
# With Tailscale running, the app also answers on this machine's tailnet address, so your other machines can connect to it.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${LOCAL_AI_DIR:-$HOME/.local/share/local-ai}"
NODE="$(command -v node || true)"
# Omarchy manages Node with mise; use that when there is no Node yet.
if [ -z "$NODE" ] && command -v mise >/dev/null; then mise use -g node@lts && NODE="$(mise which node)"; fi
[ -n "$NODE" ] || { echo "Local AI needs Node.js 20 or newer. Install it, then run this again."; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Local AI needs Node.js 20 or newer; this is $("$NODE" --version)."; exit 1; }
mkdir -p "$DEST" "$HOME/.config/systemd/user"
if [ "$SRC" != "$DEST" ]; then cp -r "$SRC/server" "$SRC/web" "$SRC/package.json" "$SRC/install.sh" "$DEST/"; fi
UNIT="$HOME/.config/systemd/user/local-ai.service"
# Settings given now stay with the service; ones given at an earlier install are kept.
SETTINGS="$(for v in LOCAL_AI_HOST LOCAL_AI_SHARE LOCAL_AI_PORT LOCAL_AI_HOME LOCAL_AI_MODELS LOCAL_AI_REGISTRY HF_HOME; do
  if [ -n "${!v}" ]; then echo "Environment=\"$v=${!v}\""; else grep -s "^Environment=\"$v=" "$UNIT"; fi
done; true)"
cat > "$UNIT" <<UNIT
[Unit]
Description=Local AI
After=network-online.target

[Service]
ExecStart="$NODE" "$DEST/server/index.js"
Environment=SHELL=${SHELL:-/bin/bash}
Environment=PATH=$PATH
$SETTINGS
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now local-ai.service
systemctl --user restart local-ai.service
PORT="$(echo "$SETTINGS" | sed -n 's/.*LOCAL_AI_PORT=\([0-9]*\).*/\1/p')"
URL="http://127.0.0.1:${PORT:-18700}"
for i in $(seq 1 40); do curl -s -m 1 "$URL/api/health" >/dev/null && break; sleep 0.25; done
curl -s -m 2 "$URL/api/health" >/dev/null || { echo "The server did not start. See: journalctl --user -u local-ai -n 40"; exit 1; }
if command -v omarchy-webapp-install >/dev/null; then
  timeout 30 omarchy-webapp-install "Local AI" "$URL" "$URL/icon.png" </dev/null >/dev/null 2>&1 && echo "Added Local AI to the app menu." || echo "Could not add the app-menu entry. Add it from the Omarchy menu: Install > Web App, with $URL"
fi
echo "Local AI is running at $URL"
