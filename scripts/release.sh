#!/usr/bin/env bash
# Build every helper binary + the extension zip and publish them as a GitHub release.
# Users then install with the one-liners in README / the add-on popup:
#   https://github.com/$REPO/releases/latest/download/<asset>
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-hamb1y/foxhand}"
TAG="v$(node -p 'require("./package.json").version')"
ALL_TARGETS="windows-x64 windows-arm64 darwin-arm64 darwin-x64 linux-x64 linux-arm64"

node scripts/set-version.mjs --check

# What's new: this version's section of CHANGELOG.md, without its heading.
CHANGES="$(awk -v h="## ${TAG#v}" '$0 == h { on = 1; next } on && /^## / { exit } on' CHANGELOG.md)"
if [[ -z "${CHANGES//[[:space:]]/}" ]]; then
  echo "[foxhand] CHANGELOG.md has no '## ${TAG#v}' section" >&2
  exit 1
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# A release always carries every platform, built now, and nothing else: assemble an
# explicit list in a fresh staging directory and upload exactly that.
TARGETS="$ALL_TARGETS" bash scripts/build-host.sh
bash scripts/pack-extension.sh >/dev/null
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ASSETS=()
for t in $ALL_TARGETS; do
  ext=""; [[ $t == windows-* ]] && ext=".exe"
  ASSETS+=("foxhand-host-$t$ext")
  cp "dist/host/foxhand-host-$t$ext" "$OUT/"
  # Same file under its pre-rename name, for download links in WebMCP Controller <= 0.4.
  ASSETS+=("webmcp-host-$t$ext")
  cp "dist/host/foxhand-host-$t$ext" "$OUT/webmcp-host-$t$ext"
done
cp scripts/install.sh scripts/install.ps1 foxhand.zip "$OUT/"
ASSETS+=(install.sh install.ps1 foxhand.zip)
(cd "$OUT" && sha256 "${ASSETS[@]}" > SHA256SUMS)
ASSETS+=(SHA256SUMS)
FILES=()
for a in "${ASSETS[@]}"; do FILES+=("$OUT/$a"); done

NOTES="$(cat <<MD
$CHANGES

## Install

Helper app for the **Foxhand** add-on (formerly WebMCP Controller).

**Windows**: open PowerShell and paste:
\`\`\`powershell
irm https://hamb1y.github.io/foxhand/ps | iex
\`\`\`

**macOS / Linux**: open Terminal and paste:
\`\`\`sh
curl -fsSL https://hamb1y.github.io/foxhand/sh | sh
\`\`\`

Already installed? Run the same command again to update: Firefox switches to the
new helper by itself within a few seconds.

Then click **Retry** in the add-on popup. Manual: download the file for your
system below and run it with \`install\` (Windows: double-click the .exe; macOS: run
\`xattr -c\` on it first). The \`webmcp-host-*\` files are the same programs under their old names.
MD
)"

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" --repo "$REPO" --clobber "${FILES[@]}"
else
  # TARGET: the commit to tag when the tag doesn't exist yet (the release workflow passes it).
  gh release create "$TAG" --repo "$REPO" ${TARGET:+--target "$TARGET"} --title "Foxhand helper $TAG" --notes "$NOTES" "${FILES[@]}"
fi
echo "[foxhand] released $TAG → https://github.com/$REPO/releases/tag/$TAG"
