#!/bin/bash
# Builds the Windows installer, dist/Local-AI-<version>-x64.exe: one file that installs Local AI for the person who
# runs it (no administrator needed), with a Start menu entry and an uninstaller. It is built on Linux, in the Docker
# image electron-builder publishes for this (it holds Wine, which writes the icon and the version into the program):
#   scripts/release-win.sh                       # on a Linux machine with Docker
#   BUILD_ON=<ssh host> scripts/release-win.sh   # from a Mac: this commit is built on that Linux machine and the installer brought back
# The installer is not signed, because there is no Windows certificate yet. Windows asks before it runs one.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)"
EXE="dist/Local-AI-$VERSION-x64.exe"
IMAGE="electronuserland/builder:wine@sha256:f3a8d451994c881d0972e7b1846ee4d4fdc15eb41fc6b1f350b38cbf99ca90fe"

if [ -n "${BUILD_ON:-}" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes. A release is built from a commit."; exit 1; }
  SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$BUILD_ON")
  THERE="$("${SSH[@]}" mktemp -d)"
  git archive --format=tar HEAD | "${SSH[@]}" "tar -xf - -C '$THERE' && '$THERE/scripts/release-win.sh'"
  mkdir -p dist
  scp -q -o BatchMode=yes -o ConnectTimeout=10 "$BUILD_ON:$THERE/$EXE" "$EXE"
  "${SSH[@]}" "rm -rf '$THERE'"
else
  # As this user, so the files it leaves are this user's. Its downloads and Wine's settings go to a home of its own.
  # Electron's own install script is skipped: it would fetch the Linux program, and the Windows one is fetched by the builder.
  docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp/home --volume "$PWD:/project" --workdir /project "$IMAGE" \
    bash -c 'npm ci --ignore-scripts --no-audit --no-fund && npx electron-builder --win --x64 --publish never'
fi
[ -f "$EXE" ] || { echo "The build did not leave $EXE"; exit 1; }
if command -v sha256sum >/dev/null; then sha256sum "$EXE"; else shasum -a 256 "$EXE"; fi
