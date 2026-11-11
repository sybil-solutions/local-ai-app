#!/bin/bash
# Builds and runs the engine check on this Mac. Usage: ios/Tools/check-engine.sh [model.gguf]
set -euo pipefail
cd "$(dirname "$0")/.."
./fetch-llama.sh >/dev/null
F="Vendor/llama.xcframework/macos-arm64_x86_64"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
/bin/cp -f Tools/check-engine.swift "$OUT/main.swift"
xcrun swiftc -O -F "$F" -framework llama -Xlinker -rpath -Xlinker "$PWD/$F" \
  LocalAI/Engine/ChatFormat.swift LocalAI/Engine/LlamaEngine.swift "$OUT/main.swift" -o "$OUT/check-engine" 2>&1 | grep -v "^$" || true
"$OUT/check-engine" "$@"
