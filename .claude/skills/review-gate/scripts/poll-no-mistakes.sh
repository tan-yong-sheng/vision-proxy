#!/usr/bin/env bash
# Poll a no-mistakes axi run via the daemon IPC socket and unblock gates.
# This is deterministic: it reads JSON-RPC instead of parsing the CLI's TOON text.
#
# Usage: poll-no-mistakes-structured.sh [poll-interval-seconds]
# Run from inside the target worktree or set WORKTREE env var.

set -euo pipefail

POLL_INTERVAL="${1:-30}"
SOCKET="${NM_SOCKET:-$HOME/.no-mistakes/socket}"
# no-mistakes records the main working path, not linked-worktree paths.
# Resolve the main repo directory from the git common dir.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON_DIR" ]; then
  MAIN_REPO="${GIT_COMMON_DIR%/.git}"
else
  MAIN_REPO="${WORKTREE:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
fi

if [ -z "$MAIN_REPO" ]; then
  echo "Cannot determine repo path; set WORKTREE env var or run inside a git repo." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required." >&2
  exit 1
fi

REPO_ID=$(sqlite3 "$HOME/.no-mistakes/state.sqlite" <<EOF
.parameter init
.parameter set :path "$MAIN_REPO"
SELECT id FROM repos WHERE working_path = :path;
EOF
)
if [ -z "$REPO_ID" ]; then
  echo "No no-mistakes repo record for $MAIN_REPO" >&2
  exit 1
fi

decode_toon_status() {
  local dir="${1:-$MAIN_REPO}"
  (
    cd "$dir"
    no-mistakes axi status 2>/dev/null | npx -y @toon-format/cli 2>/dev/null || \
    no-mistakes axi status 2>/dev/null | node -e 'import("@toon-format/toon").then(t=>process.stdin.on("data",d=>console.log(JSON.stringify(t.decode(d.toString())))))' 2>/dev/null || true
  )
}

rpc_call() {
  local method=$1
  local params=$2
  if [ -S "$SOCKET" ]; then
    printf '{"jsonrpc":"2.0","method":"%s","params":%s,"id":1}\n' "$method" "$params" | nc -U -w 5 "$SOCKET" 2>/dev/null || true
  fi
}

while true; do
  RESP=""
  if [ -n "$REPO_ID" ]; then
    RESP=$(rpc_call get_active_run "{\"repo_id\":\"$REPO_ID\"}" || true)
  fi

  if [ -z "$RESP" ]; then
    CLI_JSON=$(decode_toon_status "$MAIN_REPO")
    if [ -n "$CLI_JSON" ] && [ "$CLI_JSON" != "null" ]; then
      RESP="{\"result\":$CLI_JSON}"
    fi
  fi

  if [ -z "$RESP" ]; then
    echo "$(date -Iseconds) | daemon and cli status not responding"
    sleep "$POLL_INTERVAL"
    continue
  fi

  RUN=$(echo "$RESP" | jq -c '.result.run' 2>/dev/null || true)
  if [ -z "$RUN" ] || [ "$RUN" = "null" ]; then
    echo "$(date -Iseconds) | no active run"
    break
  fi

  STATUS=$(echo "$RUN" | jq -r '.status')
  AWAITING=$(echo "$RUN" | jq -r '.awaiting_agent // false')

  if [ "$AWAITING" = "true" ]; then
    echo "$(date -Iseconds) | BLOCKED"

    STEP=$(echo "$RUN" | jq -c '.steps[] | select(.status == "fix_review" or .status == "awaiting_approval") | .' | head -1)
    if [ -n "$STEP" ]; then
      STEP_NAME=$(echo "$STEP" | jq -r '.step_name')
      echo "$(date -Iseconds) | gate step: $STEP_NAME"

      AUTO_FIX_IDS=$(echo "$STEP" | jq -r '.findings_json | fromjson | .findings[] | select(.action == "auto-fix") | .id' | paste -sd, -)
      ASK_USER_IDS=$(echo "$STEP" | jq -r '.findings_json | fromjson | .findings[] | select(.action == "ask-user") | .id' | paste -sd, -)

      if [ -n "$AUTO_FIX_IDS" ]; then
        echo "$(date -Iseconds) | auto-fixing: $AUTO_FIX_IDS"
        no-mistakes axi respond --action fix --findings "$AUTO_FIX_IDS"
      fi

      if [ -n "$ASK_USER_IDS" ]; then
        if [ "${AUTO_APPROVE_ASK_USER:-0}" = "1" ]; then
          echo "$(date -Iseconds) | auto-approving ask-user findings: $ASK_USER_IDS"
          no-mistakes axi respond --action approve
        else
          echo "$(date -Iseconds) | ask-user findings need manual review. Re-run with AUTO_APPROVE_ASK_USER=1 to approve them automatically."
          echo "$ASK_USER_IDS" | tr ',' '\n'
          exit 1
        fi
      fi
    else
      echo "$(date -Iseconds) | awaiting agent but no gate step found; approving"
      no-mistakes axi respond --action approve
    fi
  elif [ "$STATUS" != "running" ]; then
    echo "$(date -Iseconds) | FINISHED status=$STATUS"
    echo "$RUN" | jq .
    break
  else
    ACTIVE=$(echo "$RUN" | jq -r '[.steps[] | select(.status == "running" or .status == "fixing")] | map(.step_name) | join(",")')
    echo "$(date -Iseconds) | RUNNING steps=$ACTIVE"
  fi

  sleep "$POLL_INTERVAL"
done
