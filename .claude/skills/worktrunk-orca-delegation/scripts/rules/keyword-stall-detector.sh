#!/usr/bin/env bash
# scripts/rules/keyword-stall-detector.sh
#
# Scans each dispatched terminal's recent output for known stall phrases
# that suggest the worker is blocked, looping, or stuck on a question it
# will not ask.
#
# Stall phrases (extend as new patterns surface):
#   - "waiting for approval"     - worker is blocked on a permission prompt
#   - "rate limit"               - API throttling, worker is retrying
#   - "Please proceed"           - worker finished but did not call worker_done (Mode C)
#   - "Press enter to continue"  - blocked on a confirmation prompt
#
# Emits Mode B for in-progress stalls, Mode C for "please proceed".

set -uo pipefail

RUN_ID="${RUN_ID:-${1:-}}"
[ -n "$RUN_ID" ] || exit 0

ora() { orca "$@"; }

ora orchestration task-list --run "$RUN_ID" --json 2>/dev/null \
  | jq -c '.result.tasks[]? | select(.status == "dispatched")' \
  | while read -r TASK; do
      TASK_ID=$(echo "$TASK" | jq -r '.id // empty')
      [ -n "$TASK_ID" ] || continue

      DISPATCH_JSON=$(ora orchestration dispatch-show --task "$TASK_ID" --json 2>/dev/null)
      TERMINAL=$(echo "$DISPATCH_JSON" | jq -r '.result.dispatch.assignee_handle // empty')
      [ -n "$TERMINAL" ] || continue

      # Read the tail of the terminal output.
      TAIL_JSON=$(ora terminal read --terminal "$TERMINAL" --limit 200 --json 2>/dev/null)
      TAIL=$(echo "$TAIL_JSON" | jq -r '.result.terminal.tail // [] | join("\n")')

      # Mode C: "please proceed" or static checkmark with no tool activity.
      if echo "$TAIL" | grep -qi "please proceed\|task is ready"; then
        jq -nc \
          --arg mode "C" \
          --arg terminal "$TERMINAL" \
          --arg task_id "$TASK_ID" \
          --arg reason "please-proceed pattern in terminal tail" \
          '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
        continue
      fi

      # Mode B (in-progress): known stall phrases.
      if echo "$TAIL" | grep -qi "waiting for approval\|rate limit\|press enter to continue"; then
        jq -nc \
          --arg mode "B" \
          --arg terminal "$TERMINAL" \
          --arg task_id "$TASK_ID" \
          --arg reason "stall phrase in tail" \
          '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
      fi
    done

exit 0
