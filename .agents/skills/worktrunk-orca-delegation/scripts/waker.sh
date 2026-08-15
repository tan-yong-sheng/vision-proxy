#!/usr/bin/env bash
# scripts/waker.sh - time-driven waker + rule iterator
#
# Walks every rule under scripts/rules/*.sh on a fixed cadence. Rules emit
# one JSON action per line on stdout (see SKILL.md section 6.2 for the
# contract). The waker collects all actions, deduplicates by task (one
# action per task per tick), and dispatches them through apply_recovery.sh,
# which enforces a per-task cooldown.
#
# Iteration cadence is driven by a plain `sleep`, NOT by `check --wait`,
# because `check --wait --timeout-ms N` only bounds the time until the
# first message arrives - it returns immediately when the queue is empty.
#
# Usage:  WAKER_INTERVAL_MS=600000 RUN_ID=run_... ./waker.sh
#
# Launch as a bg_run background shell process with isAgent:false and
# notifyOnCompletion:true. Do not use nohup/&/disown - those break the
# harness wake-up rule.

set -uo pipefail

RUN_ID="${RUN_ID:-}"
WAKER_INTERVAL_MS="${WAKER_INTERVAL_MS:-600000}"   # 10 minutes
STATE_DIR="${WAKER_STATE_DIR:-.waker-state}"
SINGLE_TICK=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--run <run-id>] [--single-tick|--once] [--interval-ms <n>] [--state-dir <dir>]

Walk all recovery rules under rules/*.sh, deduplicate actions, and apply them.

Options:
  --run <run-id>         The orchestration run ID (or set RUN_ID env).
  --single-tick, --once  Run rules once and exit without sleeping.
  --interval-ms <n>      Sleep interval between ticks in ms (default: 600000).
  --state-dir <dir>      Directory for waker cooldown state (default: .waker-state).
  -h, --help             Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_ID="$2"
      shift 2
      ;;
    --single-tick|--once)
      SINGLE_TICK=1
      shift
      ;;
    --interval-ms)
      WAKER_INTERVAL_MS="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$RUN_ID" ]; then
  echo "waker.sh: RUN_ID is required (--run <run-id> or RUN_ID env)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULES_DIR="$SCRIPT_DIR/rules"
mkdir -p "$STATE_DIR"
export WAKER_STATE_DIR="$STATE_DIR"

run_tick() {
  local tick="$1"

  # Collect every action from every rule into an in-memory buffer,
  # dedup by task_id so each task gets at most one action per tick.
  declare -A BEST_MODE=()
  declare -A BEST_PAYLOAD=()

  # Order matters for tie-breaking: A > B > C > D (A is most urgent).
  MODE_RANK_A=1
  MODE_RANK_B=2
  MODE_RANK_C=3
  MODE_RANK_D=4

  for rule in "$RULES_DIR"/*.sh; do
    [ -e "$rule" ] || continue
    while IFS= read -r ACTION_JSON; do
      [ -z "$ACTION_JSON" ] && continue
      TASK_ID=$(echo "$ACTION_JSON" | jq -r '.task_id // empty')
      MODE=$(echo "$ACTION_JSON" | jq -r '.mode // empty')
      [ -n "$TASK_ID" ] && [ -n "$MODE" ] || continue

      RANK=$(eval echo \$MODE_RANK_$MODE)
      RANK=${RANK:-99}

      PREV_RANK=${BEST_MODE[$TASK_ID]:-99}
      if [ "$RANK" -lt "$PREV_RANK" ]; then
        BEST_MODE[$TASK_ID]=$MODE
        BEST_PAYLOAD[$TASK_ID]=$ACTION_JSON
      fi
    done < <(bash "$rule" "$RUN_ID" 2>/dev/null)
  done

  # Apply the deduplicated actions through apply_recovery.sh. Cooldown
  # lives there so direct callers also benefit.
  for TASK_ID in "${!BEST_PAYLOAD[@]}"; do
    bash "$SCRIPT_DIR/apply_recovery.sh" "${BEST_PAYLOAD[$TASK_ID]}"
  done
}

if [[ "$SINGLE_TICK" -eq 1 ]]; then
  run_tick 1
  exit 0
fi

TICK=0
while true; do
  TICK=$((TICK + 1))
  run_tick "$TICK"

  # Time-driven sleep. Use milliseconds -> seconds for portability.
  SLEEP_S=$((WAKER_INTERVAL_MS / 1000))
  sleep "$SLEEP_S"
done
