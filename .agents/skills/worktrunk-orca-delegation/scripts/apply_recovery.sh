#!/usr/bin/env bash
# scripts/apply_recovery.sh - translate a rule-emitted JSON action into orca CLI calls.
#
# Action shape (one JSON line on stdin):
#   {"mode": "A|B|C|D", "terminal": "<handle>", "task_id": "<id>", "reason": "..."}
#
# Mode mapping (mirrors SKILL.md section 5.6 decision table):
#   A - silent stall (lost Enter): send empty Enter
#   B - working silently: send a one-line progress nudge
#   C - finished without worker_done: ask the worker to commit + worker_done
#   D - process dead: close terminal, mark task ready
#
# Per-task cooldown: tracks last_nudge epoch per task in $WAKER_STATE_DIR.
# Default cooldown is 10 minutes. Mode A is exempt (always applies) because
# a lost-Enter does not self-resolve.
#
# Nudge prefix is 🟡 Please note: - the leading emoji and "Please note:"
# prevent Claude from tokenizing the first word as a bash command, which
# previously produced a stream of "Status: command not found" lines.
#
# Usage:  echo "$ACTION_JSON" | ./apply_recovery.sh
#         ./apply_recovery.sh "$ACTION_JSON"

set -uo pipefail

ACTION_JSON="${1:-$(cat)}"

MODE=$(echo "$ACTION_JSON"     | jq -r '.mode       // empty')
TERMINAL=$(echo "$ACTION_JSON" | jq -r '.terminal   // empty')
TASK_ID=$(echo "$ACTION_JSON"  | jq -r '.task_id    // empty')
REASON=$(echo "$ACTION_JSON"   | jq -r '.reason     // empty')

if [ -z "$MODE" ]; then
  echo "apply_recovery.sh: action missing 'mode'" >&2
  exit 1
fi

STATE_DIR=${WAKER_STATE_DIR:-.waker-state}
mkdir -p "$STATE_DIR"
COOLDOWN_FILE="$STATE_DIR/${TASK_ID:-unknown}.last_nudge"
COOLDOWN_S=${WAKER_COOLDOWN_S:-600}   # 10 minutes

now() { date +%s; }

in_cooldown() {
  [ -e "$COOLDOWN_FILE" ] || return 1
  local last last_age
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  last_age=$(( $(now) - last ))
  [ "$last_age" -lt "$COOLDOWN_S" ]
}

mark_nudged() {
  now > "$COOLDOWN_FILE"
}

log() { echo "[apply_recovery $(date -u +%FT%TZ)] mode=$MODE task=$TASK_ID $1"; }

case "$MODE" in
  A)
    # Mode A: lost-Enter / silent stall. Push the missing Enter.
    # Cooldown-exempt because a lost Enter does not self-resolve.
    [ -n "$TERMINAL" ] || { echo "apply_recovery.sh: Mode A requires terminal" >&2; exit 1; }
    log "pushing Enter to terminal=$TERMINAL ($REASON)"
    orca terminal send --terminal "$TERMINAL" --text "" --enter --json >/dev/null
    mark_nudged
    ;;
  B)
    # Mode B: worker is working silently. Ask for a one-line status.
    [ -n "$TERMINAL" ] || { echo "apply_recovery.sh: Mode B requires terminal" >&2; exit 1; }
    if in_cooldown; then
      log "skip (cooldown): terminal=$TERMINAL"
      exit 0
    fi
    log "requesting progress nudge from terminal=$TERMINAL"
    orca terminal send --terminal "$TERMINAL" \
      --text "🟡 Please note: status check - one sentence on what you are doing, then continue." \
      --enter --json >/dev/null
    mark_nudged
    ;;
  C)
    # Mode C: worker finished but did not call worker_done.
    [ -n "$TERMINAL" ] || { echo "apply_recovery.sh: Mode C requires terminal" >&2; exit 1; }
    if in_cooldown; then
      log "skip (cooldown): terminal=$TERMINAL"
      exit 0
    fi
    log "asking worker to commit + worker_done"
    orca terminal send --terminal "$TERMINAL" \
      --text "🟡 Please note: if the task is ready, commit your changes and report: orca orchestration worker_done" \
      --enter --json >/dev/null
    mark_nudged
    ;;
  D)
    # Mode D: process dead. Close terminal, reset task.
    # Cooldown-exempt: dead stays dead until we act.
    if [ -n "$TERMINAL" ]; then
      log "closing terminal=$TERMINAL"
      orca terminal close --terminal "$TERMINAL" --json >/dev/null 2>&1
    fi
    if [ -n "$TASK_ID" ]; then
      log "resetting task=$TASK_ID to ready"
      orca orchestration task-update --id "$TASK_ID" --status ready --json >/dev/null
    fi
    # Clear the cooldown file so a redispatch starts fresh.
    rm -f "$COOLDOWN_FILE"
    ;;
  *)
    echo "apply_recovery.sh: unknown mode '$MODE'" >&2
    exit 1
    ;;
esac
