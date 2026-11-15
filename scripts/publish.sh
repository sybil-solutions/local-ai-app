#!/bin/bash
# Publishes this version where anyone can download it: a public repository that holds no source, only releases.
# The website's Download button and its one-line installer point at that repository's newest release, whose files
# carry no version in their names, so the same address always gives the newest:
#   Local-AI-mac-arm64.dmg         the signed, notarized Mac app (built first: npm run release:mac)
#   local-ai-linux.tar.gz          what install.sh installs on Linux, from this commit: server/, web/, install.sh, README.md, package.json
#   local-ai-linux.tar.gz.sha256   its checksum, which the one-line installer checks
#   install.sh                     the one-line installer (scripts/get.sh)
#   SHA256SUMS                     the checksum of each file above
# Run on the commit the Mac app was built from, with nothing uncommitted:
#   scripts/publish.sh            # or LOCAL_AI_RELEASES=<owner>/<repo> scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${LOCAL_AI_RELEASES:-sybil-solutions/local-ai-releases}"
VERSION="$(node -p 'require("./package.json").version')"
DMG="dist/Local-AI-$VERSION-arm64.dmg"
OUT="dist/public"

[ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes. A release is made from a commit."; exit 1; }
[ -f "$DMG" ] || { echo "There is no $DMG. Build the Mac app first: npm run release:mac"; exit 1; }
# Only a DMG that Apple notarized and Gatekeeper would open goes out.
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$DMG" "$OUT/Local-AI-mac-arm64.dmg"
# From the commit, not from the folder: nothing untracked gets in, and no Mac-only file attributes.
git archive --format=tar.gz -o "$OUT/local-ai-linux.tar.gz" HEAD server web package.json install.sh README.md
cp scripts/get.sh "$OUT/install.sh"
(
  cd "$OUT"
  shasum -a 256 local-ai-linux.tar.gz > local-ai-linux.tar.gz.sha256
  shasum -a 256 Local-AI-mac-arm64.dmg local-ai-linux.tar.gz install.sh > SHA256SUMS
)
cat > "$OUT/notes.md" <<NOTES
**Mac (Apple silicon):** download \`Local-AI-mac-arm64.dmg\`, open it and drag Local AI to Applications. The app is signed with a Developer ID and notarized by Apple.

**Linux and Omarchy:**

\`\`\`
curl -fsSL https://local.sybilsolutions.ai/install.sh | bash
\`\`\`

Checksums (SHA-256):

\`\`\`
$(cat "$OUT/SHA256SUMS")
\`\`\`
NOTES
gh release create "v$VERSION" --repo "$REPO" --title "Local AI $VERSION" --notes-file "$OUT/notes.md" --latest \
  "$OUT/Local-AI-mac-arm64.dmg" "$OUT/local-ai-linux.tar.gz" "$OUT/local-ai-linux.tar.gz.sha256" "$OUT/install.sh" "$OUT/SHA256SUMS"
cat "$OUT/SHA256SUMS"
