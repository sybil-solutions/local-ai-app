#!/bin/bash
# Publishes this version where anyone can download it: a public repository that holds no source, only releases.
# The website's Download button and its one-line installer point at that repository's newest release, whose files
# carry no version in their names, so the same address always gives the newest:
#   Local-AI-mac-arm64.dmg         the signed, notarized Mac app (built first: npm run release:mac)
#   Local-AI-mac-arm64.zip         the same app, which the Mac app downloads to update itself
#   Local-AI-windows-x64.exe       the Windows installer (built first: BUILD_ON=<a Linux machine> npm run release:win)
#   local-ai-linux.tar.gz          what install.sh installs on Linux, from this commit: server/, web/, install.sh, README.md, package.json
#   local-ai-linux.tar.gz.sha256   its checksum, which the one-line installer checks
#   install.sh                     the one-line installer (scripts/get.sh)
#   SHA256SUMS                     the checksum of each file above
#   local-ai-update.json (+ .sig)  what every copy checks before it updates: the version, what changed, and each
#                                  file's size and SHA-256, signed with the release key (scripts/sign-release.mjs)
# Run on the commit the two apps were built from, with nothing uncommitted:
#   scripts/publish.sh            # or LOCAL_AI_RELEASES=<owner>/<repo> scripts/publish.sh
# A new version goes up as a pre-release, which none of those addresses lead to. The public repository then downloads
# its files and runs them on Windows, macOS and Linux (its "Check a release" workflow), and only when all three work
# does the version become the newest release. Run again for a version that is already out, it replaces that
# release's files and checks them the same way.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${LOCAL_AI_RELEASES:-sybil-solutions/local-ai-releases}"
VERSION="$(node -p 'require("./package.json").version')"
DMG="dist/Local-AI-$VERSION-arm64.dmg"
EXE="dist/Local-AI-$VERSION-x64.exe"
ZIP="dist/Local AI-$VERSION-arm64-mac.zip"
OUT="dist/public"

[ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes. A release is made from a commit."; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"
FILES=(Local-AI-mac-arm64.dmg Local-AI-mac-arm64.zip Local-AI-windows-x64.exe local-ai-linux.tar.gz install.sh)
# Every release holds all three, so each of the website's downloads always leads somewhere.
[ -f "$DMG" ] || { echo "There is no $DMG. Build the Mac app first: npm run release:mac"; exit 1; }
[ -f "$EXE" ] || { echo "There is no $EXE. Build the Windows installer first: BUILD_ON=<a Linux machine> npm run release:win"; exit 1; }
[ -f "$ZIP" ] || { echo "There is no $ZIP. Build the Mac app first: npm run release:mac"; exit 1; }
# Without the release key nothing is published: a release copies can't check would never reach them.
node scripts/release-key.mjs >/dev/null
# Only a DMG that Apple notarized and Gatekeeper would open goes out.
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
cp "$DMG" "$OUT/Local-AI-mac-arm64.dmg"
# The app in the zip is what a Mac app updates itself to, so it is checked as the app would check it.
ZAPP="$(mktemp -d)"
ditto -x -k "$ZIP" "$ZAPP"
codesign --verify --deep --strict "$ZAPP/Local AI.app"
spctl --assess --type execute --verbose "$ZAPP/Local AI.app"
[ "$(defaults read "$ZAPP/Local AI.app/Contents/Info" CFBundleShortVersionString)" = "$VERSION" ] || { echo "The app in $ZIP is not $VERSION"; exit 1; }
rm -rf "$ZAPP"
cp "$ZIP" "$OUT/Local-AI-mac-arm64.zip"
cp "$EXE" "$OUT/Local-AI-windows-x64.exe"
# From the commit, not from the folder: nothing untracked gets in, and no Mac-only file attributes.
git archive --format=tar.gz -o "$OUT/local-ai-linux.tar.gz" HEAD server web package.json install.sh README.md
cp scripts/get.sh "$OUT/install.sh"
(
  cd "$OUT"
  shasum -a 256 local-ai-linux.tar.gz > local-ai-linux.tar.gz.sha256
  shasum -a 256 "${FILES[@]}" > SHA256SUMS
)
# What changed since the version before this one: the commits since package.json last named another version.
SINCE="$(git log -G'"version":' --format=%H -n 2 -- package.json | tail -1)"
git log --format=%s "$SINCE..HEAD" | sed -E 's/ \(#[0-9]+\)$//' | node scripts/sign-release.mjs "$OUT" "$VERSION" Local-AI-mac-arm64.dmg Local-AI-mac-arm64.zip Local-AI-windows-x64.exe local-ai-linux.tar.gz
cat > "$OUT/notes.md" <<NOTES
**Mac (Apple silicon):** download \`Local-AI-mac-arm64.dmg\`, open it and drag Local AI to Applications. The app is signed with a Developer ID and notarized by Apple.

**Windows (64-bit):** download \`Local-AI-windows-x64.exe\` and run it. It is not signed yet, so Windows asks first: choose More info, then Run anyway.

**Linux and Omarchy:**

\`\`\`
curl -fsSL https://local.sybilsolutions.ai/install.sh | bash
\`\`\`

Checksums (SHA-256):

\`\`\`
$(cat "$OUT/SHA256SUMS")
\`\`\`
NOTES
FILES+=(local-ai-linux.tar.gz.sha256 SHA256SUMS local-ai-update.json local-ai-update.json.sig)
cd "$OUT"
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" --repo "$REPO" --clobber "${FILES[@]}"
  gh release edit "v$VERSION" --repo "$REPO" --notes-file notes.md
else
  gh release create "v$VERSION" --repo "$REPO" --title "Local AI $VERSION" --notes-file notes.md --prerelease "${FILES[@]}"
fi
cat SHA256SUMS
echo "Checking the published files on Windows, macOS and Linux"
gh workflow run check.yml --repo "$REPO" -f tag="v$VERSION"
sleep 8 # until the run it started is listed
CHECK="$(gh run list --repo "$REPO" --workflow check.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$CHECK" --repo "$REPO" --exit-status --interval 15 >/dev/null || { echo "The check failed, so v$VERSION was not made the newest release: gh run view $CHECK --repo $REPO --log-failed"; exit 1; }
gh release edit "v$VERSION" --repo "$REPO" --prerelease=false --latest
echo "Local AI $VERSION is the newest release"
