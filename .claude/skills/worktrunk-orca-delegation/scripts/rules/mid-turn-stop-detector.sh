#!/usr/bin/env bash
# scripts/rules/mid-turn-stop-detector.sh
#
# Detects workers that exited mid-tool without ever calling worker_done.
#
# Signal:
#   - dispatch.status == "dispatched" (worker did not transition)
#   - worker.last_error is non-null
#   - or: terminal.connected == false but terminal was alive at last check
#
# Action: emit Mode D so the waker closes the terminal and resets the task.

set -uo pipefail

RUN_ID="${RUN_ID:-${1:-}}"
[ -n "$RUN_ID" ] || exit 0

ora orchestration task-list --run "$RUN_ID" --json 2>/dev/null \
  | jq -c '.result.tasks[]? | select(.status == "dispatched")' \
  | while read -r TASK; do
      TASK_ID=$(echo "$TASK" | jq -r '.id // empty')
      [ -n "$TASK_ID" ] || continue

      DISPATCH_ID=$(orca orchestration dispatch-show --task "$TASK_ID" --json 2>/dev/null \
                     | jq -r '.result.dispatch.id // empty')
      [ -n "$DISPATCH_ID" ] || continue
      WORKER_JSON=$(orca orchestration worker-show --dispatch "$DISPATCH_ID" --json 2>/dev/null)

      LAST_ERROR=$(echo "$WORKER_JSON" | jq -r '.result.worker.last_error // empty')
      [ -n "$LAST_ERROR" ] || continue

      TERMINAL=$(echo "$WORKER_JSON" | jq -r '.result.worker.agent_terminal_handle // empty')
      [ -n "$TERMINAL" ] || continue

      jq -nc \
        --arg mode "D" \
        --arg terminal "$TERMINAL" \
        --arg task_id "$TASK_ID" \
        --arg reason "worker.last_error=$LAST_ERROR" \
        '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
    done

exit 0
