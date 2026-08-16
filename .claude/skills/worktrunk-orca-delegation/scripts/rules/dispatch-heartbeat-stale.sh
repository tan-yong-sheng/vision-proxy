#!/usr/bin/env bash
# scripts/rules/dispatch-heartbeat-stale.sh
#
# Fires Mode A (lost-Enter nudge) when:
#   - dispatch.status == "dispatched"
#   - worker.stage == "input_accepted"   (the dispatch injection was acknowledged
#                                         but the worker never started processing)
#   - lastOutputAt is older than 5 minutes
#
# We intentionally do NOT use a bare "❯" in the preview as the trigger.
# A bare prompt is also the normal idle state of a healthy Claude
# terminal. The dispatch-stage check is the only signal that proves the
# dispatch never actually started.

set -o pipefail

RUN_ID="${RUN_ID:-${1:-}}"
[ -n "$RUN_ID" ] || { echo "dispatch-heartbeat-stale.sh: RUN_ID required" >&2; exit 0; }

NOW_MS=$(date +%s%3N)
STAGE_AGE_MS=$((5 * 60 * 1000))   # 5 minutes

# Iterate every still-dispatched task.
orca orchestration task-list --run "$RUN_ID" --json 2>/dev/null \
  | jq -c '.result.tasks[]? | select(.status == "dispatched")' \
  | while read -r TASK; do
      TASK_ID=$(echo "$TASK" | jq -r '.id // empty')
      [ -n "$TASK_ID" ] || continue

      DISPATCH_JSON=$(orca orchestration dispatch-show --task "$TASK_ID" --json 2>/dev/null)
      DISPATCH_ID=$(echo "${DISPATCH_JSON:-}"  | jq -r '.result.dispatch.id              // empty')
      ASSIGNEE=$(echo "${DISPATCH_JSON:-}"     | jq -r '.result.dispatch.assignee_handle // empty')
      [ -n "$ASSIGNEE" ] && [ -n "$DISPATCH_ID" ] || continue

      # Stage lives on worker-show, not dispatch-show.
      WORKER_JSON=$(orca orchestration worker-show --dispatch "$DISPATCH_ID" --json 2>/dev/null)
      STAGE=$(echo "${WORKER_JSON:-}" | jq -r '.result.worker.stage // "ready"')

      # Worker is still in input_accepted stage => prompt was injected but
      # the worker has not transitioned into a working turn.
      [ "$STAGE" = "input_accepted" ] || continue

      TERMINAL_JSON=$(orca terminal show --terminal "$ASSIGNEE" --json 2>/dev/null)
      CONNECTED=$(echo "${TERMINAL_JSON:-}"    | jq -r '.result.terminal.connected    // false')
      LAST_OUT=$(echo "${TERMINAL_JSON:-}"     | jq -r '.result.terminal.lastOutputAt // 0')
      LAST_OUT=${LAST_OUT:-0}

      # Skip disconnected terminals - those are Mode D, not Mode A.
      [ "$CONNECTED" = "true" ] || continue

      AGE_MS=$((NOW_MS - LAST_OUT))
      if [ "$AGE_MS" -lt "$STAGE_AGE_MS" ]; then
        # Recent terminal activity. Skip - the worker may be starting up.
        continue
      fi

      jq -nc \
        --arg mode "A" \
        --arg terminal "$ASSIGNEE" \
        --arg task_id "$TASK_ID" \
        --arg reason "stage=input_accepted for ${AGE_MS}ms (>=5m)" \
        '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
    done

# Rules must always exit 0 so the waker loop survives errors.
exit 0
