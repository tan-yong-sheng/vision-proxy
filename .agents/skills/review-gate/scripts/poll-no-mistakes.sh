#!/usr/bin/env bash
# Poll a no-mistakes axi run and unblock approval gates automatically.
# Usage: poll-no-mistakes.sh [poll-interval-seconds]
# Run from inside the target worktree or set WORKTREE env var.

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
    echo "$(date -Iseconds) | auto-approving..."
    no-mistakes axi respond --action approve
  elif echo "$STATUS" | grep -q "^outcome:"; then
    echo "$(date -Iseconds) | FINISHED"
    echo "$STATUS"
    break
  else
    echo "$(date -Iseconds) | RUNNING"
  fi

  sleep "$POLL_INTERVAL"
done
