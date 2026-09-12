#!/usr/bin/env bash
# Smoke-test the generated `npx tsx` hook script without a live vision model.
#
# Usage:
#   npm run build
#   scripts/test-hook.sh
#
# This installs the claude-code integration into an isolated HOME, points
# VP_BIN at a fake `vp` that echoes a fenced description, and pipes sample
# Claude Code hook events into `npx tsx <isolated-home>/.claude/hooks/vision-proxy.ts`.
# If the generated script is working, you will see a static Read reminder for
# UserPromptSubmit (no vp call) and JSON containing
# hookSpecificOutput.additionalContext for the PreToolUse Read event.
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

echo "=== UserPromptSubmit ==="
echo '{"hook_event_name":"UserPromptSubmit","prompt":"What is in /tmp/screenshot.png?"}' \
	| npx tsx "$SCRIPT"

echo
echo "=== PreToolUse Read ==="
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/diagram.png"}}' \
	| npx tsx "$SCRIPT"

echo
echo "=== PreToolUse Read (non-image: should be empty) ==="
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/etc/hosts"}}' \
	| npx tsx "$SCRIPT"
