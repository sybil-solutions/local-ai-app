#!/bin/bash
# Installs Local AI for this user: the files, a service that keeps the server running, and an app-menu entry on Omarchy.
#   LOCAL_AI_HOST=<this machine's Tailscale address> ./install.sh    shares models and the app with your other machines
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
cat > "$HOME/.config/systemd/user/local-ai.service" <<UNIT
[Unit]
Description=Local AI
After=network-online.target

[Service]
ExecStart=$NODE $DEST/server/index.js
Environment=LOCAL_AI_HOST=${LOCAL_AI_HOST:-127.0.0.1}
Environment=SHELL=${SHELL:-/bin/bash}
Environment=PATH=$PATH
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now local-ai.service
systemctl --user restart local-ai.service
for i in $(seq 1 40); do curl -s -m 1 http://127.0.0.1:18700/api/health >/dev/null && break; sleep 0.25; done
curl -s -m 2 http://127.0.0.1:18700/api/health >/dev/null || { echo "The server did not start. See: journalctl --user -u local-ai -n 40"; exit 1; }
if command -v omarchy-webapp-install >/dev/null; then
  timeout 30 omarchy-webapp-install "Local AI" "http://127.0.0.1:18700" "http://127.0.0.1:18700/icon.png" </dev/null >/dev/null 2>&1 && echo "Added Local AI to the app menu." || echo "Could not add the app-menu entry. Add it from the Omarchy menu: Install > Web App, with http://127.0.0.1:18700"
fi
echo "Local AI is running at http://127.0.0.1:18700"
