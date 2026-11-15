#!/bin/bash
# Installs Local AI for this user: the files, a service that keeps the server running, and an app-menu entry (on
# Omarchy an app window of its own, on any other desktop the page in your browser).
# With Tailscale running, the app also answers on this machine's tailnet address, so your other machines can connect to it.
set -e
[ "$(uname -s)" = Linux ] || { echo "This installer sets up a Linux user service. On a Mac, use the Local AI app."; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${LOCAL_AI_DIR:-$HOME/.local/share/local-ai}"
UNIT="$HOME/.config/systemd/user/local-ai.service"
# Sent here by another machine (LOCAL_AI_SHIPPED says whether to install or to update). That machine may only think
# there is no Local AI here because it can't reach it, so before anything is touched: a copy that updates itself from
# its repo is left alone, and one that is already running is replaced only by an update.
if [ -n "${LOCAL_AI_SHIPPED:-}" ]; then
  if [ -e "$DEST/.git" ]; then echo "Local AI on this machine updates itself, so nothing was changed"; exit 3; fi
  WAS="$(sed -n 's/.*LOCAL_AI_PORT=\([0-9]*\).*/\1/p' "$UNIT" 2>/dev/null | head -1)"
  if [ "$LOCAL_AI_SHIPPED" != update ] && curl -s -m 2 "http://127.0.0.1:${WAS:-18700}/api/health" 2>/dev/null | grep -q '"app":"local-ai"'; then echo "Local AI is already running on this machine, so nothing was changed"; exit 4; fi
fi
mkdir -p "$DEST" "$HOME/.config/systemd/user"
node_ok() { [ -n "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
NODE="$(command -v node || true)"
# The Node this installer fetched at an earlier install is used again: an update downloads nothing and replaces nothing.
if ! node_ok "$NODE" && node_ok "$DEST/node/bin/node"; then NODE="$DEST/node/bin/node"; fi
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
  NODE_NEW="$DEST/node.new"
  trap 'rm -rf "$NODE_F" "$NODE_NEW"' EXIT
  curl -fsSL "https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-linux-$NODE_A.tar.xz" -o "$NODE_F" || { echo "Local AI needs Node.js 20 or newer, and could not download it. Install it, then run this again."; exit 1; }
  echo "$NODE_SUM  $NODE_F" | sha256sum -c - >/dev/null 2>&1 || { echo "The Node.js download did not match its checksum, so it was not used."; exit 1; }
  # Unpacked beside whatever is there and put in its place only once it runs. A full disk or a cut download leaves
  # the machine as it was: nothing that works is removed for something that is not here yet.
  { rm -rf "$NODE_NEW" && mkdir -p "$NODE_NEW" && tar -xJf "$NODE_F" -C "$NODE_NEW" --strip-components=1 && node_ok "$NODE_NEW/bin/node"; } || { echo "Node.js could not be unpacked here (is the disk full?). Nothing was changed."; exit 1; }
  rm -rf "$DEST/node.old"
  if [ -e "$DEST/node" ]; then mv "$DEST/node" "$DEST/node.old"; fi
  mv "$NODE_NEW" "$DEST/node"
  rm -rf "$DEST/node.old" "$NODE_F"
  trap - EXIT
  NODE="$DEST/node/bin/node"
fi
# server/ and web/ are replaced whole, so a file a newer version removed does not linger and get loaded. The new
# files are copied in beside the old ones and then swapped, so a copy that fails (a full disk) changes nothing.
if [ "$SRC" != "$DEST" ]; then
  NEW="$DEST/.new"
  { rm -rf "$NEW" && mkdir -p "$NEW" && cp -r "$SRC/server" "$SRC/web" "$SRC/package.json" "$SRC/install.sh" "$NEW/"; } || { rm -rf "$NEW"; echo "The new version could not be copied here (is the disk full?). Nothing was changed."; exit 1; }
  rm -rf "$DEST/server" "$DEST/web"
  mv "$NEW/server" "$NEW/web" "$NEW/package.json" "$NEW/install.sh" "$DEST/"
  rm -rf "$NEW"
fi
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
# The page needs this machine's key. It is not handed to whoever asks from this machine; it goes in the address the
# app-menu entry opens, read from the config file only this user can read.
STATE="$(echo "$SETTINGS" | sed -n 's/.*LOCAL_AI_HOME=\([^"]*\).*/\1/p')"
KEY="$("$NODE" -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).key || "") } catch {}' "${STATE:-$HOME/.local-ai}/config.json")"
if command -v omarchy-webapp-install >/dev/null; then
  timeout 30 omarchy-webapp-install "Local AI" "$URL/#key=$KEY" "$URL/icon.png" </dev/null >/dev/null 2>&1 && echo "Added Local AI to the app menu." || echo "Could not add the app-menu entry. Add it from the Omarchy menu: Install > Web App, with the address below"
  grep -ls "$URL/#key=" "$HOME/.local/share/applications/"*.desktop 2>/dev/null | while read -r entry; do chmod 600 "$entry"; done
elif [ -n "$KEY" ] && command -v xdg-open >/dev/null; then
  # Any other desktop: an app-menu entry that opens the page in your browser. It holds the key, so only you can read it.
  ENTRY="${XDG_DATA_HOME:-$HOME/.local/share}/applications/local-ai.desktop"
  mkdir -p "$(dirname "$ENTRY")"
  rm -f "$ENTRY"
  (umask 077; printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Local AI' 'Comment=Start a local model with one click' "Exec=xdg-open \"$URL/#key=$KEY\"" "Icon=$DEST/web/icon.png" 'Terminal=false' 'Categories=Development;' > "$ENTRY") && echo "Added Local AI to the app menu."
fi
echo "Local AI is running at $URL"
# Starting a model takes Docker, and Docker only answers to its group. Said here, where the fix can be pasted.
if command -v docker >/dev/null && ! docker ps >/dev/null 2>&1 && docker ps 2>&1 | grep -qi 'permission denied'; then
  echo "To start models, let this user use Docker: sudo usermod -aG docker $(id -un), then restart the computer."
fi
# Shown only to a person at a terminal, never into a log: the address that opens the page with its key.
if [ -t 1 ] && [ -n "$KEY" ]; then echo "Open it with: $URL/#key=$KEY"; fi
