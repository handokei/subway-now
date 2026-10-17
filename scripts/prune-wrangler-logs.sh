#!/bin/bash
# wrangler 로그 prune — #1453.
#
# `~/Library/Preferences/.wrangler/logs/`는 wrangler CLI 호출마다 새 파일을 적재한다
# (2026-06-18 시점 105MB 누적 확인). 7일 이상 된 파일을 자동 삭제한다.
#
# 사용:
#   scripts/prune-wrangler-logs.sh                    # 7일 기준 prune
#   scripts/prune-wrangler-logs.sh --days 14          # 14일 기준
#   scripts/prune-wrangler-logs.sh --dry-run          # 삭제 대상 출력만
#
# 환경변수:
#   WRANGLER_LOG_DIR  override (기본: ~/Library/Preferences/.wrangler/logs)
#
# launchd 등록:
#   ~/Library/LaunchAgents/com.subway-now.wrangler-log-prune.plist 참고
set -euo pipefail

DAYS=7
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "[prune-wrangler-logs] 알 수 없는 옵션: $1" >&2; exit 2;;
  esac
done

LOG_DIR="${WRANGLER_LOG_DIR:-$HOME/Library/Preferences/.wrangler/logs}"

if [[ ! -d "$LOG_DIR" ]]; then
  echo "[prune-wrangler-logs] log dir 없음 — 종료: $LOG_DIR"
  exit 0
fi

# find -mtime +N — mtime이 N일보다 오래된 파일.
if [[ "$DRY_RUN" -eq 1 ]]; then
  count=$(find "$LOG_DIR" -type f -name 'wrangler-*.log' -mtime "+$DAYS" -print | tee /dev/stderr | wc -l | tr -d ' ')
  echo "[prune-wrangler-logs] dry-run: $count files >$DAYS days"
else
  count=$(find "$LOG_DIR" -type f -name 'wrangler-*.log' -mtime "+$DAYS" -delete -print | wc -l | tr -d ' ')
  echo "[prune-wrangler-logs] pruned $count files (> $DAYS days) in $LOG_DIR"
fi
