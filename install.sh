#!/bin/bash
# Installs Local AI for this user: the files, a service that keeps the server running, and an app-menu entry on Omarchy.
# With Tailscale running, the app also answers on this machine's tailnet address, so your other machines can connect to it.
set -e
[ "$(uname -s)" = Linux ] || { echo "This installer sets up a Linux user service. On a Mac, use the Local AI app."; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${LOCAL_AI_DIR:-$HOME/.local/share/local-ai}"
node_ok() { [ -n "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
NODE="$(command -v node || true)"
# Omarchy manages Node with mise; use that when there is no Node 20 yet.
if ! node_ok "$NODE" && command -v mise >/dev/null; then mise use -g node@lts >/dev/null 2>&1 && NODE="$(mise which node)"; fi
# Still none: fetch the official build for this machine, check it against the hash pinned here, and keep it beside the app.
if ! node_ok "$NODE"; then
  NODE_V=22.23.4
  case "$(uname -m)" in
    x86_64) NODE_A=x64; NODE_SUM=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
    aarch64 | arm64) NODE_A=arm64; NODE_SUM=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;;
    *) echo "Local AI needs Node.js 20 or newer. Install it, then run this again."; exit 1 ;;
  esac
  NODE_F="$(mktemp)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-linux-$NODE_A.tar.xz" -o "$NODE_F" || { echo "Local AI needs Node.js 20 or newer, and could not download it. Install it, then run this again."; exit 1; }
  echo "$NODE_SUM  $NODE_F" | sha256sum -c - >/dev/null 2>&1 || { rm -f "$NODE_F"; echo "The Node.js download did not match its checksum, so it was not used."; exit 1; }
  rm -rf "$DEST/node" && mkdir -p "$DEST/node" && tar -xJf "$NODE_F" -C "$DEST/node" --strip-components=1
  rm -f "$NODE_F"
  NODE="$DEST/node/bin/node"
  node_ok "$NODE" || { echo "The downloaded Node.js does not run on this machine."; exit 1; }
fi
mkdir -p "$DEST" "$HOME/.config/systemd/user"
# server/ and web/ are replaced whole, so a file a newer version removed does not linger and get loaded.
if [ "$SRC" != "$DEST" ]; then rm -rf "$DEST/server" "$DEST/web" && cp -r "$SRC/server" "$SRC/web" "$SRC/package.json" "$SRC/install.sh" "$DEST/"; fi
UNIT="$HOME/.config/systemd/user/local-ai.service"
# A value as systemd reads it inside double quotes.
quoted() { printf '%s' "$1" | sed 's/[\\"]/\\&/g; s/%/%%/g'; }
# Settings given now stay with the service; ones given at an earlier install are kept.
SETTINGS="$(for v in LOCAL_AI_HOST LOCAL_AI_SHARE LOCAL_AI_PORT LOCAL_AI_HOME LOCAL_AI_MODELS LOCAL_AI_REGISTRY HF_HOME; do
  if [ -n "${!v}" ]; then echo "Environment=\"$v=$(quoted "${!v}")\""; else grep -s "^Environment=\"\\?$v=" "$UNIT"; fi
done; true)"
cat > "$UNIT" <<UNIT
[Unit]
Description=Local AI
After=network-online.target

[Service]
ExecStart="$(quoted "$NODE")" "$(quoted "$DEST/server/index.js")"
Environment="SHELL=$(quoted "${SHELL:-/bin/bash}")"
Environment="PATH=$(quoted "$PATH")"
$SETTINGS
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
# Keeps the service running when nobody is signed in, and starts it at boot. Where this is not allowed the install still works.
loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now local-ai.service
systemctl --user restart local-ai.service
PORT="$(echo "$SETTINGS" | sed -n 's/.*LOCAL_AI_PORT=\([0-9]*\).*/\1/p')"
URL="http://127.0.0.1:${PORT:-18700}"
for _ in $(seq 1 40); do curl -s -m 1 "$URL/api/health" >/dev/null && break; sleep 0.25; done
curl -s -m 2 "$URL/api/health" >/dev/null || { echo "The server did not start. See: journalctl --user -u local-ai -n 40"; exit 1; }
if command -v omarchy-webapp-install >/dev/null; then
  timeout 30 omarchy-webapp-install "Local AI" "$URL" "$URL/icon.png" </dev/null >/dev/null 2>&1 && echo "Added Local AI to the app menu." || echo "Could not add the app-menu entry. Add it from the Omarchy menu: Install > Web App, with $URL"
fi
echo "Local AI is running at $URL"
