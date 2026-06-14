#!/bin/bash
# Generate (and optionally install) a Chrome configuration profile that pushes
# Claude Guard managed policy (allowList / blockList) via MDM.
#
# IMPORTANT:
# For macOS profile delivery, extension managed storage should be delivered under
# the extension-specific managed domain:
#   com.google.Chrome.extensions.<extension-id>
#
# Usage:
#   ./generate-mobileconfig.sh [--allow RULE]... [--block RULE]... [--output FILE]
#   sudo ./generate-mobileconfig.sh --allow RULE --install
#
# A RULE is "PATTERN" or "PATTERN|METHOD" (method defaults to "*"), e.g.:
#   --allow '*://api.github.com/*'
#   --block '*://evil.example.com/*|POST'

set -e

# Stable extension ID, pinned by the "key" field in manifest.json.
EXTENSION_ID="lpcmmkpokkgbnmjpidnmjihinnlibike"
OUTPUT_FILE=""
INSTALL=false
ALLOW_RULES=()
BLOCK_RULES=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --extension-id) EXTENSION_ID="$2"; shift 2 ;;
        --allow)        ALLOW_RULES+=("$2"); shift 2 ;;
        --block)        BLOCK_RULES+=("$2"); shift 2 ;;
        --output|-o)    OUTPUT_FILE="$2"; shift 2 ;;
        --install)      INSTALL=true; shift ;;
        -h|--help)
            echo "Usage: $0 [--allow RULE]... [--block RULE]... [--extension-id ID] [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --extension-id ID   Chrome extension ID (defaults to pinned ID in manifest.json)"
            echo "  --allow RULE        Add an allowList rule (repeatable). RULE = 'PATTERN' or 'PATTERN|METHOD'"
            echo "  --block RULE        Add a blockList rule (repeatable). RULE = 'PATTERN' or 'PATTERN|METHOD'"
            echo "  --output, -o FILE   Output .mobileconfig file path (default: claude-guard.mobileconfig)"
            echo "  --install           Install directly to /Library/Managed Preferences (requires sudo)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ ${#ALLOW_RULES[@]} -eq 0 ] && [ ${#BLOCK_RULES[@]} -eq 0 ]; then
    echo "Error: provide at least one --allow or --block rule"
    echo "Run $0 --help for usage"
    exit 1
fi

MANAGED_PREFS_DIR="/Library/Managed Preferences"
EXTENSION_DOMAIN="com.google.Chrome.extensions.${EXTENSION_ID}"
EXTENSION_PREFS_FILE="${MANAGED_PREFS_DIR}/${EXTENSION_DOMAIN}.plist"

build_rules_xml() {
    local indent="$1"; shift
    local rule pattern method
    printf '%s<array>\n' "$indent"
    for rule in "$@"; do
        pattern="${rule%%|*}"
        if [ "$rule" = "$pattern" ]; then
            method="*"
        else
            method="${rule#*|}"
        fi
        printf '%s  <dict>\n' "$indent"
        printf '%s    <key>pattern</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$pattern"
        printf '%s    <key>method</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$method"
        printf '%s  </dict>\n' "$indent"
    done
    printf '%s</array>\n' "$indent"
}

build_policy_xml() {
    local indent="$1"
    if [ ${#ALLOW_RULES[@]} -gt 0 ]; then
        printf '%s<key>allowList</key>\n' "$indent"
        build_rules_xml "$indent" "${ALLOW_RULES[@]}"
    fi
    if [ ${#BLOCK_RULES[@]} -gt 0 ]; then
        printf '%s<key>blockList</key>\n' "$indent"
        build_rules_xml "$indent" "${BLOCK_RULES[@]}"
    fi
}

print_summary() {
    echo "  Extension ID: $EXTENSION_ID"
    local r
    for r in "${ALLOW_RULES[@]}"; do echo "  allow:        $r"; done
    for r in "${BLOCK_RULES[@]}"; do echo "  block:        $r"; done
}

if [ "$INSTALL" = true ]; then
    if [ "$(id -u)" -ne 0 ]; then
        echo "Error: --install requires root. Run with sudo."
        exit 1
    fi

    mkdir -p "$MANAGED_PREFS_DIR"

    ALLOW_BLOB=$(printf '%s\n' "${ALLOW_RULES[@]}")
    BLOCK_BLOB=$(printf '%s\n' "${BLOCK_RULES[@]}")

    EXT_FILE="$EXTENSION_PREFS_FILE" ALLOW_BLOB="$ALLOW_BLOB" BLOCK_BLOB="$BLOCK_BLOB" python3 - <<'PY'
import os, plistlib

path = os.environ["EXT_FILE"]
allow_blob = os.environ.get("ALLOW_BLOB", "")
block_blob = os.environ.get("BLOCK_BLOB", "")

def parse_rules(blob: str):
    out = []
    for line in blob.splitlines():
        rule = line.strip()
        if not rule:
            continue
        if "|" in rule:
            pattern, method = rule.split("|", 1)
        else:
            pattern, method = rule, "*"
        out.append({"pattern": pattern, "method": method})
    return out

policy = {
    "allowList": parse_rules(allow_blob),
    "blockList": parse_rules(block_blob),
}

with open(path, "wb") as f:
    plistlib.dump(policy, f)
PY

    chmod 644 "$EXTENSION_PREFS_FILE"

    echo "Installed managed extension prefs to: $EXTENSION_PREFS_FILE"
    echo ""
    print_summary
    echo ""
    echo "Now fully quit and reopen Chrome (Cmd-Q), then verify:"
    echo "  chrome://policy"
    echo "  chrome.storage.managed.get(null).then(console.log)"
    exit 0
fi

if [ -z "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="claude-guard.mobileconfig"
fi

UUID1=$(uuidgen)
UUID2=$(uuidgen)
POLICY_XML=$(build_policy_xml "                ")

cat > "$OUTPUT_FILE" <<EOF2
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>PayloadIdentifier</key>
    <string>com.anthropic.claude-guard.config</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${UUID1}</string>
    <key>PayloadDisplayName</key>
    <string>Claude Guard Policy</string>
    <key>PayloadDescription</key>
    <string>Configures Claude Guard allow/block rules for managed Chrome browsers.</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadRemovalDisallowed</key>
    <true/>
    <key>PayloadScope</key>
    <string>System</string>
    <key>PayloadContent</key>
    <array>
      <dict>
        <key>PayloadType</key>
        <string>com.apple.ManagedClient.preferences</string>
        <key>PayloadIdentifier</key>
        <string>com.anthropic.claude-guard.extension-managed</string>
        <key>PayloadUUID</key>
        <string>${UUID2}</string>
        <key>PayloadDisplayName</key>
        <string>Claude Guard Managed Storage</string>
        <key>PayloadVersion</key>
        <integer>1</integer>
        <key>PayloadContent</key>
        <dict>
          <key>${EXTENSION_DOMAIN}</key>
          <dict>
            <key>Forced</key>
            <array>
              <dict>
                <key>mcx_preference_settings</key>
                <dict>
${POLICY_XML}
                </dict>
              </dict>
            </array>
          </dict>
        </dict>
      </dict>
    </array>
  </dict>
</plist>
EOF2

echo "Generated: $OUTPUT_FILE"
echo ""
print_summary
echo ""
echo "Upload this file to your MDM, or install locally with:"
echo "  sudo ./install-mobileconfig.sh $OUTPUT_FILE"
