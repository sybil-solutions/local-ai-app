#!/bin/bash
# Fetches the llama.cpp framework the app links against (one pinned build, checked against its hash) into Vendor/.
# LFM3 needs build b11960 or newer. The framework has a slice for iPhones and one for Macs; it has none for the
# Simulator, where the app runs without the on-device model.
set -euo pipefail
cd "$(dirname "$0")"
BUILD=b12262
SUM=704a9ede82cfa161dfcb4971394ffcf61e4c4d0f3ca7ad17355a93a0f9d7718b
if [ -f "Vendor/llama.xcframework/.build" ] && [ "$(cat Vendor/llama.xcframework/.build)" = "$BUILD" ]; then echo "llama.cpp $BUILD is already in Vendor/"; exit 0; fi
ZIP="$(mktemp)"
trap 'rm -f "$ZIP"' EXIT
curl -fL --retry 3 -o "$ZIP" "https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/llama-$BUILD-xcframework.zip"
echo "$SUM  $ZIP" | shasum -a 256 -c - >/dev/null || { echo "The download did not match its checksum, so it was not used."; exit 1; }
rm -rf Vendor/llama.xcframework Vendor/unpacked
mkdir -p Vendor/unpacked
unzip -q "$ZIP" -d Vendor/unpacked
mv Vendor/unpacked/build-apple/llama.xcframework Vendor/llama.xcframework
rm -rf Vendor/unpacked
echo "$BUILD" > Vendor/llama.xcframework/.build
echo "llama.cpp $BUILD is in Vendor/"
