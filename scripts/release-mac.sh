#!/bin/bash
# Builds the Mac app as a DMG that opens without a warning on any Mac: the app signed with the Developer ID in the
# keychain under the hardened runtime, notarized by Apple and stapled; then the DMG itself signed, notarized and
# stapled. Ends by asking Gatekeeper whether it would open both.
#   APPLE_KEYCHAIN_PROFILE=<profile> scripts/release-mac.sh
# The profile is one saved with: xcrun notarytool store-credentials <profile>
set -euo pipefail
cd "$(dirname "$0")/.."
: "${APPLE_KEYCHAIN_PROFILE:?Set APPLE_KEYCHAIN_PROFILE to a profile saved with: xcrun notarytool store-credentials}"
VERSION="$(node -p 'require("./package.json").version')"
APP="dist/mac-arm64/Local AI.app"
DMG="dist/Local-AI-$VERSION-arm64.dmg"

rm -rf dist
npx electron-builder --mac --publish never    # signs the app, has Apple notarize it, staples it, builds and signs the DMG

xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG"

codesign --verify --deep --strict "$APP"
spctl --assess --type execute --verbose "$APP"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
xcrun stapler validate "$DMG"
shasum -a 256 "$DMG"
