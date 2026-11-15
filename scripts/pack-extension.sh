#!/usr/bin/env bash
# Package the BUILT add-on (build/extension/, from extension/src/*.ts + the static files in
# extension/) into foxhand.zip for sideloading / AMO upload.
set -euo pipefail

cd "$(dirname "$0")/.."

# Always build first, so the zip can't contain stale scripts. Needs Node and `npm ci` (esbuild).
node scripts/build-extension.mjs

OUT="foxhand.zip"
rm -f "$OUT"

# Only what the add-on ships: never local files such as .amo-upload-uuid or README-INSTALL.md.
# Paths are RELATIVE to build/extension/ so AMO sees manifest.json at the root.
python3 - "$OUT" <<'EOF2'
import os, sys, zipfile
out = sys.argv[1]
SHIP = ["manifest.json", "background.js", "common.js", "ui.css", "popup.html", "popup.js",
        "regex-worker.js", "announcements.js", "announcement.html", "announcement.js", "announcement.css",
        "options.html", "options.js", "onboarding.html", "onboarding.js", "_locales",
        "content", "icons", "fonts", "cursors"]
files = []
for entry in SHIP:
    full = os.path.join("build", "extension", entry)
    if os.path.isfile(full):
        files.append(full)
    elif os.path.isdir(full):
        for dirpath, dirs, names in os.walk(full):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            files += [os.path.join(dirpath, n) for n in sorted(names) if not n.startswith(".")]
    elif entry in ("manifest.json", "background.js"):
        sys.exit(f"missing build/extension/{entry}")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, os.path.relpath(f, os.path.join("build", "extension")))
print(f"wrote {out} ({len(files)} files)")
EOF2

echo "[foxhand] contents:"
unzip -l "$OUT" 2>/dev/null || python3 -c "import zipfile,sys; print('\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))" "$OUT"

echo "[foxhand] packed $OUT"
echo "Next steps:"
echo "  - Temporary install: Firefox > about:debugging > Load Temporary Add-on > build/extension/manifest.json"
echo "  - AMO signing: submit $OUT at https://addons.mozilla.org/developers/ to get a signed .xpi"
echo "    (unlisted signing works for self-distribution; listed review is required for public listing)."
echo "  - The add-on needs the helper app: npm run build:host -> dist/host/, or npm run install-host on this machine."
