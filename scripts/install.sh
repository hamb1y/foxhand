#!/bin/sh
# Foxhand — helper installer for macOS and Linux.
#   curl -fsSL https://hamb1y.github.io/foxhand/sh | sh
# Downloads the right foxhand-host binary, checks it, and registers it with Firefox.
set -eu
BASE="${FOXHAND_BASE:-${WEBMCP_BASE:-https://github.com/hamb1y/foxhand/releases/latest/download}}"
PS_CMD="irm https://hamb1y.github.io/foxhand/ps | iex"

# Inside WSL, Firefox is the Windows one: install the Windows helper from here.
if [ -z "${FOXHAND_FORCE:-${WEBMCP_FORCE:-}}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  ps=$(command -v powershell.exe 2>/dev/null || echo /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe)
  if [ -x "$ps" ]; then
    echo "WSL detected: installing the helper for Windows Firefox."
    # cd to a Windows path so PowerShell doesn't start in an unsupported \\wsl$ directory.
    (cd /mnt/c 2>/dev/null || true; "$ps" -NoProfile -ExecutionPolicy Bypass -Command "irm $BASE/install.ps1 | iex")
    echo
    echo "For a harness inside WSL: add-on Settings > tick \"Allow harnesses inside WSL to connect\","
    echo "then Format > \"Claude Code inside WSL\". (Firefox inside WSL itself? Re-run with FOXHAND_FORCE=1.)"
    exit 0
  fi
  echo "This is WSL, but Windows PowerShell isn't reachable. In Windows, open PowerShell and paste:" >&2
  echo "  $PS_CMD" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported system: $(uname -s). On Windows, run this in PowerShell: $PS_CMD" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
# x64 shell under Rosetta on Apple silicon: still use the native build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

name="foxhand-host-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else echo "Need curl or wget." >&2; exit 1; fi
}

echo "Downloading $name ..."
fetch "$BASE/$name" "$tmp/$name"

# Refuse to run anything we can't verify.
if ! fetch "$BASE/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  echo "Couldn't download SHA256SUMS to verify $name. Not installing." >&2; exit 1
fi
want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print tolower($1); exit }' "$tmp/SHA256SUMS")"
if [ -z "$want" ]; then
  echo "SHA256SUMS has no entry for $name. Not installing." >&2; exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$name" | cut -d' ' -f1)"
else got="$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)"; fi
if [ "$want" != "$got" ]; then
  echo "Checksum mismatch for $name — download corrupted or tampered with. Not installing." >&2; exit 1
fi

chmod +x "$tmp/$name"
if [ "$os" = darwin ]; then
  # No Gatekeeper prompts: curl doesn't mark downloads as quarantined, and this clears it anyway.
  xattr -c "$tmp/$name" 2>/dev/null || true
  # Apple silicon runs only signed code; the release binary is signed ad hoc. If that signature
  # doesn't verify here, sign it again ad hoc (codesign comes with macOS).
  codesign --verify "$tmp/$name" 2>/dev/null || codesign --force --sign - "$tmp/$name" 2>/dev/null || true
fi
"$tmp/$name" install

if [ "$os" = linux ]; then
  if [ -d "$HOME/.var/app/org.mozilla.firefox" ] || [ -d "$HOME/snap/firefox" ]; then
    echo
    echo "Note: a Flatpak or Snap Firefox was found. Sandboxed Firefox builds may not be allowed to start"
    echo "helper apps. If Foxhand stays on \"Helper app not installed\", use Firefox from mozilla.org"
    echo "or your distro's regular (non-sandboxed) package."
  fi
fi
