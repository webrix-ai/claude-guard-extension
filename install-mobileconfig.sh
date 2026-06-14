#!/bin/bash
# Install a Claude Guard .mobileconfig locally for testing by extracting the
# extension managed payload and writing it to:
#   /Library/Managed Preferences/com.google.Chrome.extensions.<extension-id>.plist
#
# Usage:
#   sudo ./install-mobileconfig.sh <path-to-file.mobileconfig>
#   sudo ./install-mobileconfig.sh --uninstall <extension-id>

set -e

MANAGED_PREFS_DIR="/Library/Managed Preferences"

if [ $# -lt 1 ]; then
    echo "Usage: sudo $0 <path-to-file.mobileconfig>"
    echo "       sudo $0 --uninstall <extension-id>"
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: this script requires root. Run with sudo."
    exit 1
fi

mkdir -p "$MANAGED_PREFS_DIR"

if [ "$1" = "--uninstall" ]; then
    EXT_ID="$2"
    if [ -z "$EXT_ID" ]; then
        echo "Error: --uninstall requires an extension ID"
        exit 1
    fi

    EXT_FILE="${MANAGED_PREFS_DIR}/com.google.Chrome.extensions.${EXT_ID}.plist"
    rm -f "$EXT_FILE"

    # Best-effort cleanup for older local test shape.
    CHROME_FILE="${MANAGED_PREFS_DIR}/com.google.Chrome.plist"
    if [ -f "$CHROME_FILE" ]; then
        EXT_ID="$EXT_ID" CHROME_FILE="$CHROME_FILE" python3 - <<'PY'
import os, plistlib
path = os.environ["CHROME_FILE"]
ext_id = os.environ["EXT_ID"]
try:
    with open(path, "rb") as f:
        root = plistlib.load(f)
except Exception:
    raise SystemExit(0)
if isinstance(root, dict):
    third = root.get("3rdparty")
    if isinstance(third, dict):
        exts = third.get("extensions")
        if isinstance(exts, dict) and ext_id in exts:
            del exts[ext_id]
            with open(path, "wb") as f:
                plistlib.dump(root, f)
PY
    fi

    echo "Removed managed policy for extension: $EXT_ID"
    echo "Fully quit and reopen Chrome (Cmd-Q)."
    exit 0
fi

MOBILECONFIG_PATH="$1"
if [ ! -f "$MOBILECONFIG_PATH" ]; then
    echo "Error: file not found: $MOBILECONFIG_PATH"
    exit 1
fi

SRC="$MOBILECONFIG_PATH" DST_DIR="$MANAGED_PREFS_DIR" python3 - <<'PY'
import os, plistlib, re, sys

src = os.environ["SRC"]
dst_dir = os.environ["DST_DIR"]
ext_prefix = "com.google.Chrome.extensions."

with open(src, "rb") as f:
    profile = plistlib.load(f)

ext_domain = None
settings = None

for payload in profile.get("PayloadContent", []):
    content = payload.get("PayloadContent", {})
    if not isinstance(content, dict):
        continue
    for key, value in content.items():
        if not key.startswith(ext_prefix):
            continue
        if not isinstance(value, dict):
            continue
        forced = value.get("Forced", [])
        if forced and isinstance(forced[0], dict) and "mcx_preference_settings" in forced[0]:
            ext_domain = key
            settings = forced[0]["mcx_preference_settings"]
            break
    if settings is not None:
        break

if settings is None or ext_domain is None:
    sys.stderr.write(f"Error: no extension managed payload found (expected {ext_prefix}<id>)\n")
    sys.exit(2)

ext_id = ext_domain.split(ext_prefix, 1)[1]
if not re.fullmatch(r"[a-z]{32}", ext_id):
    sys.stderr.write(f"Warning: unexpected extension id format: {ext_id}\n")

dst = os.path.join(dst_dir, f"{ext_domain}.plist")
with open(dst, "wb") as f:
    plistlib.dump(settings, f)

allow = len(settings.get("allowList", [])) if isinstance(settings, dict) else 0
block = len(settings.get("blockList", [])) if isinstance(settings, dict) else 0
print(f"Installed: {dst}")
print(f"  extensionId: {ext_id}")
print(f"  allow rules: {allow}")
print(f"  block rules: {block}")
PY

echo ""
echo "Next steps:"
echo "  1. Fully quit and reopen Chrome (Cmd-Q, not just the window)."
echo "  2. Open chrome://policy and click 'Reload policies'."
echo "  3. In service worker console: chrome.storage.managed.get(null).then(console.log)"
