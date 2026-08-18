#!/usr/bin/env bash
# Smoke-test vp hook without a live vision model.
#
# Usage:
#   npm run build
#   scripts/test-hook.sh
#
# This creates a fake `vp` binary that echoes a fenced description, points
# VP_BIN at it, and pipes sample Claude Code / Codex hook events into
# `node dist/cli.js hook`. If the dispatcher is working, you will see JSON
# containing hookSpecificOutput.additionalContext for both events.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${ROOT}/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
	echo "dist/cli.js not found. Run 'npm run build' first." >&2
	exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAKE_VP="$TMP/vp"
cat > "$FAKE_VP" <<'EOF'
#!/usr/bin/env node
const out = '<vision_proxy_description>A red square on white.</vision_proxy_description>';
process.stdout.write(out + '\n');
EOF
chmod +x "$FAKE_VP"

export VP_BIN="$FAKE_VP"

echo "=== UserPromptSubmit ==="
echo '{"hook_event_name":"UserPromptSubmit","prompt":"What is in /tmp/screenshot.png?"}' \
	| node "$CLI" hook

echo
echo "=== PreToolUse Read ==="
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/diagram.png"}}' \
	| node "$CLI" hook

echo
echo "=== PreToolUse Read (non-image: should be empty) ==="
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/etc/hosts"}}' \
	| node "$CLI" hook
