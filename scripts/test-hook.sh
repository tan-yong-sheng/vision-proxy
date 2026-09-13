#!/usr/bin/env bash
# Smoke-test the generated `npx tsx` hook script without a live vision model.
#
# Usage:
#   npm run build
#   scripts/test-hook.sh
#
# This installs the claude-code integration into an isolated HOME, points
# VP_BIN at a fake `vp` that echoes a fenced description, and pipes sample
# Claude Code hook events into the generated hook script. It asserts the
# `npx tsx` contract end to end:
#   - UserPromptSubmit emits a static Read reminder (never shells out to vp)
#   - PreToolUse Read emits hookSpecificOutput.additionalContext via vp analyze
#   - PreToolUse Read on a non-image path emits nothing
#
# The script is explicit and offline-safe: it runs entirely under an isolated
# HOME, including the tsx preflight up front (`npx --no-install tsx`, the
# exact command the installer registers, so a missing tsx fails fast instead
# of triggering a silent network install), with no network access required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ROOT}/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
	echo "dist/cli.js not found. Run 'npm run build' first." >&2
	exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME"

# --- tsx preflight (under the isolated HOME so the check is honest): always
# exercise the exact command the installer registers (`npx tsx <script>`),
# with `--no-install` so a missing tsx fails fast instead of triggering a
# silent network install.
if npx --no-install tsx --version >/dev/null 2>&1; then
	TSX=(npx --no-install tsx)
else
	echo "error: tsx is required to run the hook script but was not found." >&2
	echo "Install it (e.g. 'npm install -g tsx'), then re-run this script." >&2
	exit 1
fi

FAKE_VP="$TMP/vp"
cat > "$FAKE_VP" <<'EOF'
#!/usr/bin/env node
const out = '<vision_proxy_description>A red square on white.</vision_proxy_description>';
process.stdout.write(out + '\n');
EOF
chmod +x "$FAKE_VP"

export VP_BIN="$FAKE_VP"

HOME="$TMP/home" node "$CLI" integration install claude-code >/dev/null

SCRIPT="$HOME/.claude/hooks/vision-proxy.ts"
if [[ ! -f "$SCRIPT" ]]; then
	echo "hook script not found at $SCRIPT" >&2
	exit 1
fi

fail() {
	echo "FAIL: $1" >&2
	echo "--- captured output ---" >&2
	printf '%s\n' "$2" >&2
	exit 1
}

echo "=== UserPromptSubmit ==="
UPS_OUT=$(echo '{"hook_event_name":"UserPromptSubmit","prompt":"What is in /tmp/screenshot.png?"}' | "${TSX[@]}" "$SCRIPT")
printf '%s\n' "$UPS_OUT"
[[ "$UPS_OUT" == *'"hookEventName":"UserPromptSubmit"'* ]] \
	|| fail "UserPromptSubmit output must carry hookEventName UserPromptSubmit" "$UPS_OUT"
[[ "$UPS_OUT" == *'The user prompt references'* ]] \
	|| fail "UserPromptSubmit output must contain the static Read reminder" "$UPS_OUT"
[[ "$UPS_OUT" == *'/tmp/screenshot.png'* ]] \
	|| fail "UserPromptSubmit reminder must name the prompt image path" "$UPS_OUT"
[[ "$UPS_OUT" != *'permissionDecision'* ]] \
	|| fail "UserPromptSubmit reminder must not carry a permissionDecision" "$UPS_OUT"

echo
echo "=== PreToolUse Read ==="
PRE_OUT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/diagram.png"}}' | "${TSX[@]}" "$SCRIPT")
printf '%s\n' "$PRE_OUT"
[[ "$PRE_OUT" == *'"hookEventName":"PreToolUse"'* ]] \
	|| fail "PreToolUse output must carry hookEventName PreToolUse" "$PRE_OUT"
[[ "$PRE_OUT" == *'"additionalContext"'* ]] \
	|| fail "PreToolUse output must carry hookSpecificOutput.additionalContext" "$PRE_OUT"
[[ "$PRE_OUT" == *'A red square on white'* ]] \
	|| fail "PreToolUse additionalContext must contain the vp analyze description" "$PRE_OUT"
[[ "$PRE_OUT" == *'"permissionDecision":"deny"'* ]] \
	|| fail "PreToolUse image Read must deny with permissionDecision" "$PRE_OUT"

echo
echo "=== PreToolUse Read (non-image: should be empty) ==="
EMPTY_OUT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/etc/hosts"}}' | "${TSX[@]}" "$SCRIPT")
printf '%s\n' "$EMPTY_OUT"
[[ -z "$EMPTY_OUT" ]] \
	|| fail "PreToolUse Read on a non-image path must emit nothing" "$EMPTY_OUT"

echo
echo "All hook contract checks passed."
