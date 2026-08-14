#!/usr/bin/env bash
# scripts/rules/duration-loop-check.sh
#
# Detects workers that have been dispatched for a long time without
# producing a worker_done. Two thresholds (env-overridable):
#   - NUDGE_PROGRESS_MS   (default 600000 = 10 min) -> Mode B progress nudge
#   - NUDGE_DONE_HINT_MS  (default 1800000 = 30 min) -> Mode B + worker_done hint
#
# Setting WAKER_INTERVAL_MS to e.g. 600000 means a dispatched worker that
# has not reported progress in 10 min gets nudged; if it has not produced
# worker_done in 30 min we hint that calling worker_done is fine mid-stream.

set -o pipefail

RUN_ID="${RUN_ID:-${1:-}}"
[ -n "$RUN_ID" ] || exit 0

NOW_S=$(date +%s)
NUDGE_PROGRESS_MS=${NUDGE_PROGRESS_MS:-600000}     # 10 min
NUDGE_DONE_HINT_MS=${NUDGE_DONE_HINT_MS:-1800000}  # 30 min

orca orchestration task-list --run "$RUN_ID" --json 2>/dev/null \
  | jq -c '.result.tasks[]? | select(.status == "dispatched")' \
  | while read -r TASK; do
      TASK_ID=$(echo "${TASK:-}" | jq -r '.id // empty')
      [ -n "$TASK_ID" ] || continue

      DISPATCH_JSON=$(orca orchestration dispatch-show --task "$TASK_ID" --json 2>/dev/null)
      # Use dispatch.dispatched_at, NOT task.created_at - the task may have been
      # created hours ago but only re-dispatched minutes ago after a recovery.
      DISPATCHED_AT=$(echo "${DISPATCH_JSON:-}" | jq -r '.result.dispatch.dispatched_at // empty')
      TERMINAL=$(echo "${DISPATCH_JSON:-}" | jq -r '.result.dispatch.assignee_handle // empty')
      [ -n "$TERMINAL" ] || continue
      [ -n "$DISPATCHED_AT" ] || continue

      # dispatched_at is "YYYY-MM-DD HH:MM:SS" in UTC. Parse with -u so we do
      # not add the local timezone offset.
      DISPATCHED_S=$(date -u -d "$DISPATCHED_AT" +%s 2>/dev/null) || continue
      AGE_S=$((NOW_S - DISPATCHED_S))
      AGE_MS=$((AGE_S * 1000))

      if [ "$AGE_MS" -ge "$NUDGE_DONE_HINT_MS" ]; then
        jq -nc \
          --arg mode "B" \
          --arg terminal "$TERMINAL" \
          --arg task_id "$TASK_ID" \
          --arg reason "dispatched ${AGE_S}s ago (>${NUDGE_DONE_HINT_MS}ms); worker_done is fine even mid-stream" \
          '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
      elif [ "$AGE_MS" -ge "$NUDGE_PROGRESS_MS" ]; then
        jq -nc \
          --arg mode "B" \
          --arg terminal "$TERMINAL" \
          --arg task_id "$TASK_ID" \
          --arg reason "dispatched ${AGE_S}s ago (>${NUDGE_PROGRESS_MS}ms); one-sentence status?" \
          '{mode:$mode, terminal:$terminal, task_id:$task_id, reason:$reason}'
      fi
    done

exit 0
