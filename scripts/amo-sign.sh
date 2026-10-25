#!/usr/bin/env bash
# Submit the add-on to AMO (addons.mozilla.org) with web-ext sign.
# Uploads exactly what foxhand.zip ships (scripts/pack-extension.sh).
#
# Required env vars (get them from https://addons.mozilla.org/developers/addon/api/key/):
#   AMO_JWT_ISSUER  - API key (JWT issuer)
#   AMO_JWT_SECRET  - API secret
#
# Optional:
#   AMO_CHANNEL     - "unlisted" (default: signed .xpi for self-distribution) or
#                     "listed" (a new public version on the AMO listing, with this
#                     version's CHANGELOG.md section as its release notes)
#
# Usage:
#   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... bash scripts/amo-sign.sh
#   AMO_CHANNEL=listed ... bash scripts/amo-sign.sh   (what the release workflow runs)
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${AMO_JWT_ISSUER:-}" ] || [ -z "${AMO_JWT_SECRET:-}" ]; then
  echo "[foxhand] ERROR: set AMO_JWT_ISSUER and AMO_JWT_SECRET first." >&2
  echo "  Get them at: https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

CHANNEL="${AMO_CHANNEL:-unlisted}"
if [ "$CHANNEL" != "unlisted" ] && [ "$CHANNEL" != "listed" ]; then
  echo "[foxhand] ERROR: AMO_CHANNEL must be 'unlisted' or 'listed'." >&2
  exit 1
fi

VERSION="$(node -p "require('./extension/manifest.json').version")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bash scripts/pack-extension.sh >/dev/null
mkdir "$WORK/src"
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" foxhand.zip "$WORK/src"

META=()
if [ "$CHANNEL" = "listed" ]; then
  node -e '
    const notes = require("fs").readFileSync(0, "utf8").trim();
    console.log(JSON.stringify({ version: { release_notes: { "en-US": notes } } }));
  ' < <(node scripts/amo-notes.mjs "$VERSION") > "$WORK/meta.json"
  # Listed versions go through AMO review. Don't wait for it: AMO publishes
  # the version once it's approved.
  META=(--amo-metadata="$WORK/meta.json" --approval-timeout=0)
fi

echo "[foxhand] linting extension..."
npx -y web-ext@8 lint -s "$WORK/src"

echo "[foxhand] submitting $VERSION (channel=$CHANNEL)..."
npx -y web-ext@8 sign \
  -s "$WORK/src" \
  -a "$WORK/artifacts" \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel="$CHANNEL" \
  "${META[@]}" \
  --timeout 300000

if [ "$CHANNEL" = "unlisted" ]; then
  mkdir -p web-ext-artifacts
  cp "$WORK"/artifacts/*.xpi web-ext-artifacts/ 2>/dev/null || true
  echo "[foxhand] done. Signed .xpi is under web-ext-artifacts/."
  echo "Install it via Firefox > Add-ons Manager > gear icon > Install Add-on From File."
else
  echo "[foxhand] done. $VERSION is submitted; AMO publishes it once review passes."
fi
