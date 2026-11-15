#!/bin/bash
# The one-line installer for Linux that the website gives:
#   curl -fsSL https://local.sybilsolutions.ai/install.sh | bash
# It downloads the newest release of Local AI, checks it against the checksum published beside it, and runs the
# installer inside it (install.sh): a user service that keeps the server running and, on Omarchy, an app-menu entry.
# Run again later, it updates the copy it installed. A copy that was cloned from its repo updates itself, and is
# left alone. Settings such as LOCAL_AI_PORT are passed on: curl ... | LOCAL_AI_PORT=18800 bash
set -euo pipefail
# Everything is inside one function that is called on the last line, so a download that was cut short runs nothing.
main() {
  [ "$(uname -s)" = Linux ] || { echo "This installs Local AI on Linux. On a Mac, download the app: https://local.sybilsolutions.ai/download/"; exit 1; }
  local from="${LOCAL_AI_RELEASE:-https://github.com/sybil-solutions/local-ai-releases/releases/latest/download}"
  TMP="$(mktemp -d)" # not local: it is removed when the script ends, after this function has returned
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading Local AI"
  { curl -fsSL "$from/local-ai-linux.tar.gz" -o "$TMP/local-ai-linux.tar.gz" && curl -fsSL "$from/local-ai-linux.tar.gz.sha256" -o "$TMP/sum"; } || { echo "Local AI could not be downloaded. Nothing was changed."; exit 1; }
  echo "$(cut -d' ' -f1 "$TMP/sum")  $TMP/local-ai-linux.tar.gz" | sha256sum -c - >/dev/null 2>&1 || { echo "The download did not match its checksum, so it was not used. Nothing was changed."; exit 1; }
  mkdir "$TMP/app"
  tar -xzf "$TMP/local-ai-linux.tar.gz" -C "$TMP/app" || { echo "The download could not be unpacked (is the disk full?). Nothing was changed."; exit 1; }
  LOCAL_AI_SHIPPED=update bash "$TMP/app/install.sh"
}
main "$@"
