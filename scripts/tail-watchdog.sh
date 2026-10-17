#!/bin/bash
# wrangler tail watchdog — #1453.
#
# `wrangler tail`은 inactivity 또는 stream 죽음으로 silent "좀비"가 된다
# (lesson_wrangler_tail_wrapper_reliability). 단순 `while true; do wrangler tail; sleep N; done`
# 루프는 프로세스가 EXIT할 때만 재시작하므로 좀비(alive + 무데이터) 상태에서 복구 못 함.
#
# 본 스크립트는 두 개의 협력 루프를 한 프로세스에서 돌린다:
#   1) tail loop — wrangler tail을 jsonl에 append. EXIT 시 자동 재spawn (max-restarts 이내).
#   2) watchdog loop — jsonl mtime이 STALE_SECS 이상 정지면 wrangler node를 강제 kill →
#      tail loop가 EXIT 감지해 재spawn.
#
# 부수 기능:
#   - log rotation: jsonl이 MAX_BYTES 도달 시 timestamp suffix로 회전
#   - max-restarts: 100회 초과 시 stderr에 ALERT 출력 + 종료
#
# 사용:
#   scripts/tail-watchdog.sh [label]
#   예: scripts/tail-watchdog.sh origin-verify
#
# 종료:
#   Ctrl+C 또는 SIGTERM. 자식(wrangler + watchdog)도 같이 정리됨.
#
# 환경변수 (테스트/튜닝용):
#   STALE_SECS=90      jsonl mtime 이 N초 stale이면 좀비 판정
#   CHECK_INTERVAL=30  watchdog poll 주기
#   MAX_BYTES=10485760 회전 임계 (10MB)
#   MAX_RESTARTS=100   tail spawn 누적 상한
#   RESPAWN_SLEEP=3    EXIT 후 재spawn 대기
#   OUT_DIR=tasks      출력 디렉토리 (절대경로 권장)
#   TAIL_CMD           override 시 wrangler 대신 임의 명령 (테스트용)
set -euo pipefail

LABEL="${1:-watchdog}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[tail-watchdog] label은 [A-Za-z0-9._-]만 허용: $LABEL" >&2
  exit 2
fi

STALE_SECS="${STALE_SECS:-90}"
CHECK_INTERVAL="${CHECK_INTERVAL:-30}"
MAX_BYTES="${MAX_BYTES:-10485760}"
MAX_RESTARTS="${MAX_RESTARTS:-100}"
RESPAWN_SLEEP="${RESPAWN_SLEEP:-3}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/tasks}"
mkdir -p "$OUT_DIR"

OUT="$OUT_DIR/wrangler-tail-watchdog.jsonl"
ERR="$OUT_DIR/wrangler-tail-watchdog.err"
ALERT="$OUT_DIR/wrangler-tail-watchdog.alert"

# Determine tail command. Default: wrangler tail against backend/alarm-worker.
if [[ -z "${TAIL_CMD:-}" ]]; then
  WORKER_NAME=$(awk -F'"' '/^name *=/ {print $2; exit}' "$REPO_ROOT/backend/alarm-worker/wrangler.toml")
  if [[ -z "$WORKER_NAME" ]]; then
    echo "[tail-watchdog] backend/alarm-worker/wrangler.toml에서 worker name 추출 실패" >&2
    exit 1
  fi
  TAIL_CMD="cd $REPO_ROOT/backend/alarm-worker && npx wrangler tail $WORKER_NAME --format=json"
fi

# stat -f (BSD/macOS) vs stat -c (GNU/Linux) shim.
#
# 주의: `stat -f %z file` 의 `-f` 는 BSD/macOS에서 `--format`이지만 GNU coreutils
# stat에서는 `--file-system` 옵션으로 해석되어 filesystem info를 출력하고 exit 0
# 한다. 즉 `stat -f ... || stat -c ...` chain은 GNU에서도 첫 호출이 exit 0이라
# fallback이 안 일어나고 잘못된 출력을 size로 받는다. → version 감지 후 분기한다.
if stat --version >/dev/null 2>&1; then
  STAT_IS_GNU=1
else
  STAT_IS_GNU=0
fi

file_mtime() {
  local f="$1"
  if [[ ! -e "$f" ]]; then echo 0; return; fi
  if [[ "$STAT_IS_GNU" -eq 1 ]]; then
    stat -c %Y "$f" 2>/dev/null || echo 0
  else
    stat -f %m "$f" 2>/dev/null || echo 0
  fi
}

# `wc -c < file` 은 GNU/BSD 동일 출력 (leading whitespace는 trim).
file_size() {
  local f="$1"
  if [[ ! -e "$f" ]]; then echo 0; return; fi
  local size
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  echo "${size:-0}"
}

rotate_if_needed() {
  local size
  size=$(file_size "$OUT")
  if [[ "$size" -ge "$MAX_BYTES" ]]; then
    local ts
    ts=$(date +%Y%m%d-%H%M%S)
    mv "$OUT" "$OUT.$ts"
    : > "$OUT"
    echo "[tail-watchdog] rotated → $OUT.$ts" >> "$ERR"
  fi
}

CHILD_PIDS=()
cleanup() {
  for pid in "${CHILD_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # kill any straggling wrangler tail
  pkill -f "node_modules/.bin/wrangler tail" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# Watchdog loop — pkill wrangler tail when jsonl mtime is stale.
(
  while true; do
    sleep "$CHECK_INTERVAL"
    mtime=$(file_mtime "$OUT")
    now=$(date +%s)
    if [[ "$mtime" -eq 0 ]]; then continue; fi
    age=$(( now - mtime ))
    if [[ "$age" -gt "$STALE_SECS" ]]; then
      echo "[tail-watchdog] jsonl stale ${age}s > ${STALE_SECS}s — killing wrangler tail" >> "$ERR"
      pkill -f "node_modules/.bin/wrangler tail" 2>/dev/null || true
    fi
  done
) &
WATCHDOG_PID=$!
CHILD_PIDS+=("$WATCHDOG_PID")

# Tail loop — respawn on EXIT, rotate before each spawn.
restarts=0
while true; do
  if [[ "$restarts" -ge "$MAX_RESTARTS" ]]; then
    msg="[tail-watchdog] ALERT max-restarts $MAX_RESTARTS 초과 — 종료. wrangler/network 점검 필요."
    echo "$msg" >> "$ALERT"
    echo "$msg" >&2
    cleanup
  fi
  rotate_if_needed
  echo "[tail-watchdog] spawn #$((restarts + 1)) label=$LABEL out=$OUT" >> "$ERR"
  # run command — append stdout to OUT, stderr to ERR. Don't fail on non-zero.
  bash -c "$TAIL_CMD" >> "$OUT" 2>> "$ERR" || true
  restarts=$((restarts + 1))
  sleep "$RESPAWN_SLEEP"
done
