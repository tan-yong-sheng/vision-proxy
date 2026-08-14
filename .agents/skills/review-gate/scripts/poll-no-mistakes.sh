#!/usr/bin/env bash
# Poll a no-mistakes axi run and unblock approval gates automatically.
# Usage: poll-no-mistakes.sh [poll-interval-seconds]
# Run from inside the target worktree or set WORKTREE env var.
#
# Behavior:
# - Prints RUNNING while the daemon is busy.
# - When blocked at a gate, extracts finding actions:
#     * auto-fix findings -> asks no-mistakes to fix them
#     * ask-user findings -> prints them and exits (unless AUTO_APPROVE_ASK_USER=1)
# - Prints FINISHED once an outcome appears.

set -euo pipefail

POLL_INTERVAL="${1:-30}"

if [ -n "${WORKTREE:-}" ]; then
  cd "$WORKTREE"
fi

while true; do
  STATUS=$(no-mistakes axi status 2>/dev/null || true)

  if [ -z "$STATUS" ]; then
    echo "$(date -Iseconds) | no-mistakes status unavailable"
    sleep "$POLL_INTERVAL"
    continue
  fi

  if echo "$STATUS" | grep -q "awaiting_agent: parked"; then
    echo "$(date -Iseconds) | BLOCKED"
    STEP=$(echo "$STATUS" | grep -A5 "^gate:" | grep "^  step:" | awk '{print $2}' || true)
    echo "$(date -Iseconds) | gate step: ${STEP:-unknown}"

    # Findings are printed as CSV lines under the "findings[N]" block.
    # Fields: id, severity, file, action, description
    FINDING_LINES=$(echo "$STATUS" | grep -A50 "^  findings\[" | grep -E '^    [^ ]+,')

    AUTO_FIX_IDS=()
    ASK_USER_IDS=()

    while IFS= read -r line; do
      ID=$(echo "$line" | cut -d, -f1 | tr -d ' ')
      ACTION=$(echo "$line" | cut -d, -f4 | tr -d ' ')
      case "$ACTION" in
        auto-fix) AUTO_FIX_IDS+=("$ID") ;;
        ask-user) ASK_USER_IDS+=("$ID") ;;
      esac
    done <<< "$FINDING_LINES"

    if [ ${#AUTO_FIX_IDS[@]} -gt 0 ]; then
      FIX_LIST=$(IFS=,; echo "${AUTO_FIX_IDS[*]}")
      echo "$(date -Iseconds) | auto-fixing: $FIX_LIST"
      no-mistakes axi respond --action fix --findings "$FIX_LIST"
    fi

    if [ ${#ASK_USER_IDS[@]} -gt 0 ]; then
      if [ "${AUTO_APPROVE_ASK_USER:-0}" = "1" ]; then
        echo "$(date -Iseconds) | auto-approving ask-user findings"
        no-mistakes axi respond --action approve
      else
        echo "$(date -Iseconds) | ask-user findings need manual review. Re-run with AUTO_APPROVE_ASK_USER=1 to approve them automatically."
        printf '%s\n' "${ASK_USER_IDS[@]}"
        exit 1
      fi
    fi
  elif echo "$STATUS" | grep -q "^outcome:"; then
    echo "$(date -Iseconds) | FINISHED"
    echo "$STATUS"
    break
  else
    echo "$(date -Iseconds) | RUNNING"
  fi

  sleep "$POLL_INTERVAL"
done
