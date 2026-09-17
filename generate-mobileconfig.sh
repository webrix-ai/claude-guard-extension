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
#   ./generate-mobileconfig.sh [--allow RULE]... [--block RULE]... [--redact RULE]... [--output FILE]
#   sudo ./generate-mobileconfig.sh --allow RULE --install
#
# An allow/block RULE is "PATTERN" or "PATTERN|METHOD" (method defaults to "*"), e.g.:
#   --allow '*://api.github.com/*'
#   --block '*://evil.example.com/*|POST'
#
# A redact RULE is "KIND:VALUE" or "KIND:VALUE|SCOPE" where KIND is one of
# text, regex, selector and SCOPE is an optional URL glob, e.g.:
#   --redact 'selector:.account-balance|*://bank.example.com/*'
#   --redact 'regex:ACME-\d{6}'
#
# Built-in guards (secrets, email, phone, ssn, credit-card, ip-address,
# financial, dob, government-id, address) can be forced on/off, individual
# checks disabled, and the minimum certainty pinned:
#   --guard email:on --guard phone:off
#   --disable-check phone:regex-us-phone-number
#   --min-certainty 7

set -e

# Default extension ID. Pass --extension-id to override with the ID shown in
# chrome://extensions for your installation (Web Store or unpacked).
EXTENSION_ID="lpcmmkpokkgbnmjpidnmjihinnlibike"
OUTPUT_FILE=""
INSTALL=false
ALLOW_RULES=()
BLOCK_RULES=()
REDACT_RULES=()
GUARD_RULES=()
DISABLED_CHECKS=()
MIN_CERTAINTY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --extension-id)  EXTENSION_ID="$2"; shift 2 ;;
        --allow)         ALLOW_RULES+=("$2"); shift 2 ;;
        --block)         BLOCK_RULES+=("$2"); shift 2 ;;
        --redact)        REDACT_RULES+=("$2"); shift 2 ;;
        --guard)         GUARD_RULES+=("$2"); shift 2 ;;
        --disable-check) DISABLED_CHECKS+=("$2"); shift 2 ;;
        --min-certainty) MIN_CERTAINTY="$2"; shift 2 ;;
        --output|-o)     OUTPUT_FILE="$2"; shift 2 ;;
        --install)       INSTALL=true; shift ;;
        -h|--help)
            echo "Usage: $0 [--allow RULE]... [--block RULE]... [--redact RULE]... [--guard ID:on|off]... [--extension-id ID] [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --extension-id ID        Chrome extension ID (see chrome://extensions)"
            echo "  --allow RULE             Add an allowList rule (repeatable). RULE = 'PATTERN' or 'PATTERN|METHOD'"
            echo "  --block RULE             Add a blockList rule (repeatable). RULE = 'PATTERN' or 'PATTERN|METHOD'"
            echo "  --redact RULE            Add a redactList rule (repeatable). RULE = 'KIND:VALUE' or 'KIND:VALUE|SCOPE'"
            echo "                           KIND = text | regex | selector"
            echo "  --guard ID:on|off        Force a built-in guard on or off (repeatable)"
            echo "  --disable-check ID:CHECK Disable one check of a built-in guard (repeatable)"
            echo "  --min-certainty N        Pin the minimum check certainty (1-10)"
            echo "  --output, -o FILE        Output .mobileconfig file path (default: claude-guard.mobileconfig)"
            echo "  --install                Install directly to /Library/Managed Preferences (requires sudo)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ ${#ALLOW_RULES[@]} -eq 0 ] && [ ${#BLOCK_RULES[@]} -eq 0 ] && [ ${#REDACT_RULES[@]} -eq 0 ] \
   && [ ${#GUARD_RULES[@]} -eq 0 ] && [ ${#DISABLED_CHECKS[@]} -eq 0 ] && [ -z "$MIN_CERTAINTY" ]; then
    echo "Error: provide at least one --allow, --block, --redact, --guard, --disable-check or --min-certainty"
    echo "Run $0 --help for usage"
    exit 1
fi

for rule in "${REDACT_RULES[@]}"; do
    kind="${rule%%:*}"
    case "$kind" in
        text|regex|selector) ;;
        *) echo "Error: invalid --redact rule '$rule' (expected KIND:VALUE with KIND = text|regex|selector)"; exit 1 ;;
    esac
    if [ "$kind" = "$rule" ] || [ -z "${rule#*:}" ]; then
        echo "Error: --redact rule '$rule' has no value"; exit 1
    fi
done

for rule in "${GUARD_RULES[@]}"; do
    case "${rule#*:}" in
        on|off) ;;
        *) echo "Error: invalid --guard '$rule' (expected ID:on or ID:off)"; exit 1 ;;
    esac
    [ "${rule%%:*}" = "$rule" ] && { echo "Error: invalid --guard '$rule'"; exit 1; }
done

for rule in "${DISABLED_CHECKS[@]}"; do
    if [ "${rule%%:*}" = "$rule" ] || [ -z "${rule#*:}" ]; then
        echo "Error: invalid --disable-check '$rule' (expected GUARD_ID:CHECK_ID)"; exit 1
    fi
done

if [ -n "$MIN_CERTAINTY" ]; then
    case "$MIN_CERTAINTY" in
        [1-9]|10) ;;
        *) echo "Error: --min-certainty must be an integer from 1 to 10"; exit 1 ;;
    esac
fi

xml_escape() {
    local s="$1"
    s="${s//&/&amp;}"
    s="${s//</&lt;}"
    s="${s//>/&gt;}"
    printf '%s' "$s"
}

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
        printf '%s    <key>pattern</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$(xml_escape "$pattern")"
        printf '%s    <key>method</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$(xml_escape "$method")"
        printf '%s  </dict>\n' "$indent"
    done
    printf '%s</array>\n' "$indent"
}

# Redact rules: KIND:VALUE or KIND:VALUE|SCOPE
build_redact_xml() {
    local indent="$1"; shift
    local rule kind rest value scope
    printf '%s<array>\n' "$indent"
    for rule in "$@"; do
        kind="${rule%%:*}"
        rest="${rule#*:}"
        value="${rest%%|*}"
        if [ "$rest" = "$value" ]; then
            scope=""
        else
            scope="${rest#*|}"
        fi
        printf '%s  <dict>\n' "$indent"
        printf '%s    <key>kind</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$(xml_escape "$kind")"
        printf '%s    <key>value</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$(xml_escape "$value")"
        if [ -n "$scope" ]; then
            printf '%s    <key>scope</key>\n%s    <string>%s</string>\n' "$indent" "$indent" "$(xml_escape "$scope")"
        fi
        printf '%s  </dict>\n' "$indent"
    done
    printf '%s</array>\n' "$indent"
}

# Guard overrides: --guard ID:on|off and --disable-check ID:CHECK → <dict> keyed by guard id.
guard_ids() {
    local r
    { for r in "${GUARD_RULES[@]}"; do printf '%s\n' "${r%%:*}"; done
      for r in "${DISABLED_CHECKS[@]}"; do printf '%s\n' "${r%%:*}"; done; } | awk 'NF && !seen[$0]++'
}

build_guards_xml() {
    local indent="$1"
    local id r state
    printf '%s<dict>\n' "$indent"
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        printf '%s  <key>%s</key>\n%s  <dict>\n' "$indent" "$(xml_escape "$id")" "$indent"
        state=""
        for r in "${GUARD_RULES[@]}"; do
            [ "${r%%:*}" = "$id" ] && state="${r#*:}"
        done
        if [ -n "$state" ]; then
            printf '%s    <key>enabled</key>\n' "$indent"
            if [ "$state" = "on" ]; then printf '%s    <true/>\n' "$indent"; else printf '%s    <false/>\n' "$indent"; fi
        fi
        local has_checks=false
        for r in "${DISABLED_CHECKS[@]}"; do
            [ "${r%%:*}" = "$id" ] && has_checks=true
        done
        if [ "$has_checks" = true ]; then
            printf '%s    <key>disabledChecks</key>\n%s    <array>\n' "$indent" "$indent"
            for r in "${DISABLED_CHECKS[@]}"; do
                [ "${r%%:*}" = "$id" ] && printf '%s      <string>%s</string>\n' "$indent" "$(xml_escape "${r#*:}")"
            done
            printf '%s    </array>\n' "$indent"
        fi
        printf '%s  </dict>\n' "$indent"
    done < <(guard_ids)
    printf '%s</dict>\n' "$indent"
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
    if [ ${#REDACT_RULES[@]} -gt 0 ]; then
        printf '%s<key>redactList</key>\n' "$indent"
        build_redact_xml "$indent" "${REDACT_RULES[@]}"
    fi
    if [ ${#GUARD_RULES[@]} -gt 0 ] || [ ${#DISABLED_CHECKS[@]} -gt 0 ]; then
        printf '%s<key>guards</key>\n' "$indent"
        build_guards_xml "$indent"
    fi
    if [ -n "$MIN_CERTAINTY" ]; then
        printf '%s<key>guardMinCertainty</key>\n%s<integer>%s</integer>\n' "$indent" "$indent" "$MIN_CERTAINTY"
    fi
}

print_summary() {
    echo "  Extension ID: $EXTENSION_ID"
    local r
    for r in "${ALLOW_RULES[@]}"; do echo "  allow:         $r"; done
    for r in "${BLOCK_RULES[@]}"; do echo "  block:         $r"; done
    for r in "${REDACT_RULES[@]}"; do echo "  redact:        $r"; done
    for r in "${GUARD_RULES[@]}"; do echo "  guard:         $r"; done
    for r in "${DISABLED_CHECKS[@]}"; do echo "  disable-check: $r"; done
    [ -n "$MIN_CERTAINTY" ] && echo "  min-certainty: $MIN_CERTAINTY"
    return 0
}

if [ "$INSTALL" = true ]; then
    if [ "$(id -u)" -ne 0 ]; then
        echo "Error: --install requires root. Run with sudo."
        exit 1
    fi

    mkdir -p "$MANAGED_PREFS_DIR"

    ALLOW_BLOB=$(printf '%s\n' "${ALLOW_RULES[@]}")
    BLOCK_BLOB=$(printf '%s\n' "${BLOCK_RULES[@]}")
    REDACT_BLOB=$(printf '%s\n' "${REDACT_RULES[@]}")
    GUARD_BLOB=$(printf '%s\n' "${GUARD_RULES[@]}")
    CHECK_BLOB=$(printf '%s\n' "${DISABLED_CHECKS[@]}")

    EXT_FILE="$EXTENSION_PREFS_FILE" ALLOW_BLOB="$ALLOW_BLOB" BLOCK_BLOB="$BLOCK_BLOB" REDACT_BLOB="$REDACT_BLOB" \
    GUARD_BLOB="$GUARD_BLOB" CHECK_BLOB="$CHECK_BLOB" MIN_CERTAINTY="$MIN_CERTAINTY" python3 - <<'PY'
import os, plistlib

path = os.environ["EXT_FILE"]
allow_blob = os.environ.get("ALLOW_BLOB", "")
block_blob = os.environ.get("BLOCK_BLOB", "")
redact_blob = os.environ.get("REDACT_BLOB", "")
guard_blob = os.environ.get("GUARD_BLOB", "")
check_blob = os.environ.get("CHECK_BLOB", "")
min_certainty = os.environ.get("MIN_CERTAINTY", "")

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

def parse_redact_rules(blob: str):
    out = []
    for line in blob.splitlines():
        rule = line.strip()
        if not rule or ":" not in rule:
            continue
        kind, rest = rule.split(":", 1)
        if "|" in rest:
            value, scope = rest.split("|", 1)
        else:
            value, scope = rest, ""
        entry = {"kind": kind, "value": value}
        if scope:
            entry["scope"] = scope
        out.append(entry)
    return out

def parse_guards(guard_blob: str, check_blob: str):
    guards = {}
    for line in guard_blob.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        gid, state = line.split(":", 1)
        guards.setdefault(gid, {})["enabled"] = state == "on"
    for line in check_blob.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        gid, cid = line.split(":", 1)
        guards.setdefault(gid, {}).setdefault("disabledChecks", []).append(cid)
    return guards

policy = {
    "allowList": parse_rules(allow_blob),
    "blockList": parse_rules(block_blob),
    "redactList": parse_redact_rules(redact_blob),
}
guards = parse_guards(guard_blob, check_blob)
if guards:
    policy["guards"] = guards
if min_certainty:
    policy["guardMinCertainty"] = int(min_certainty)

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
    <string>Configures Claude Guard allow/block/redact rules for managed Chrome browsers.</string>
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
