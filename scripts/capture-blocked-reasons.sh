#!/bin/bash
# boarding-prompt 9단 게이트 blocked reason 분포 측정 — #854.
#
# 사용:
#   scripts/capture-blocked-reasons.sh                       # 30분, 전체 trip
#   scripts/capture-blocked-reasons.sh --duration=15m
#   scripts/capture-blocked-reasons.sh --token=35b3502c       # 특정 trip 8글자 prefix
#   scripts/capture-blocked-reasons.sh --output=blocked.jsonl
#   scripts/capture-blocked-reasons.sh --no-aggregate         # capture만, 집계 생략
#
# npm 경유:
#   npm run measure:blocked-reasons -- --token=35b3502c --duration=15m
#
# 동작:
#   - wrangler tail JSON을 jsonl로 캡처 → boarding-prompt 이벤트만 필터해 OUT 파일에 저장
#   - duration 초과 또는 Ctrl+C 시 정상 종료 → aggregate 스크립트 자동 호출
#   - timeout 도구 미존재 환경(macOS) 대비 background sleep + kill로 자체 구현
#
# 신뢰성 메모 (lesson_wrangler_tail_wrapper_reliability):
#   wrangler tail은 inactivity로 silent disconnect 될 수 있다. 이 스크립트는
#   "수신된 데이터의 시각 stamp"와 "마지막 line 수신 후 inactivity 경고"를 stderr로 찍어,
#   30분 후 결과 라인이 비정상적으로 적으면 즉시 인지할 수 있게 한다.
set -euo pipefail

DURATION="30m"
TOKEN_FILTER=""
OUTPUT=""
DO_AGGREGATE=1

for arg in "$@"; do
  case "$arg" in
    --duration=*) DURATION="${arg#--duration=}" ;;
    --token=*) TOKEN_FILTER="${arg#--token=}" ;;
    --output=*) OUTPUT="${arg#--output=}" ;;
    --no-aggregate) DO_AGGREGATE=0 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[capture-blocked-reasons] 알 수 없는 옵션: $arg" >&2
      exit 2
      ;;
  esac
done

# duration → seconds 변환 (예: 30m, 15m, 600s, 1h).
case "$DURATION" in
  *h) DURATION_SEC=$(( ${DURATION%h} * 3600 )) ;;
  *m) DURATION_SEC=$(( ${DURATION%m} * 60 )) ;;
  *s) DURATION_SEC=${DURATION%s} ;;
  *) DURATION_SEC="$DURATION" ;;
esac

if [[ -n "$TOKEN_FILTER" && ! "$TOKEN_FILTER" =~ ^[A-Za-z0-9]{4,}$ ]]; then
  echo "[capture-blocked-reasons] --token은 영숫자 4글자 이상이어야 합니다: $TOKEN_FILTER" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
LABEL="${TOKEN_FILTER:-all}"
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$REPO_ROOT/tasks/blocked-reasons-$TS-$LABEL.jsonl"
fi
RAW_TAIL="$REPO_ROOT/tasks/blocked-reasons-$TS-$LABEL.raw.jsonl"

WORKER_NAME=$(awk -F'"' '/^name *=/ {print $2; exit}' "$REPO_ROOT/backend/alarm-worker/wrangler.toml")
if [[ -z "$WORKER_NAME" ]]; then
  echo "[capture-blocked-reasons] backend/alarm-worker/wrangler.toml에서 worker name 추출 실패" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/tasks"

echo "[capture-blocked-reasons] worker:     $WORKER_NAME"
echo "[capture-blocked-reasons] duration:   ${DURATION_SEC}s"
echo "[capture-blocked-reasons] token:      ${TOKEN_FILTER:-(전체)}"
echo "[capture-blocked-reasons] 캡처 경로:  $OUTPUT"
echo "[capture-blocked-reasons] raw tail:   $RAW_TAIL"
echo "[capture-blocked-reasons] Ctrl+C 종료 시에도 aggregate가 실행됩니다."
echo

TAIL_PID=""
TIMER_PID=""
EXIT_REASON="unknown"

cleanup() {
  set +e
  if [[ -n "$TIMER_PID" ]] && kill -0 "$TIMER_PID" 2>/dev/null; then
    kill "$TIMER_PID" 2>/dev/null || true
  fi
  if [[ -n "$TAIL_PID" ]] && kill -0 "$TAIL_PID" 2>/dev/null; then
    kill "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
  fi
  echo
  echo "[capture-blocked-reasons] 종료 사유: $EXIT_REASON"

  local raw_lines=0
  local filtered_lines=0
  [[ -f "$RAW_TAIL" ]] && raw_lines=$(wc -l < "$RAW_TAIL" | tr -d ' ')
  [[ -f "$OUTPUT" ]] && filtered_lines=$(wc -l < "$OUTPUT" | tr -d ' ')
  echo "[capture-blocked-reasons] raw tail lines:    $raw_lines"
  echo "[capture-blocked-reasons] blocked events:    $filtered_lines"

  if [[ "$raw_lines" -eq 0 ]]; then
    echo "[capture-blocked-reasons] 경고: tail 라인 0건. wrangler 인증/접속 또는 inactivity disconnect 가능." >&2
  fi

  if [[ "$DO_AGGREGATE" -eq 1 && "$filtered_lines" -gt 0 ]]; then
    echo "[capture-blocked-reasons] aggregate 실행 → $OUTPUT"
    (cd "$REPO_ROOT" && node scripts/aggregate-blocked-reasons.js "$OUTPUT") || true
  elif [[ "$DO_AGGREGATE" -eq 1 ]]; then
    echo "[capture-blocked-reasons] blocked 이벤트 0건 → aggregate 생략"
  fi
}
trap cleanup EXIT INT TERM

# duration 만료를 별 프로세스로 관리 (macOS는 timeout 미내장).
(
  sleep "$DURATION_SEC"
  echo "[capture-blocked-reasons] duration ${DURATION_SEC}s 도달 → 종료" >&2
  kill -TERM $$ 2>/dev/null || true
) &
TIMER_PID=$!

# wrangler tail을 jsonl로 받아 raw에 tee + boarding-prompt 이벤트만 OUTPUT으로 필터.
# 필터는 awk로 jq 의존 없이 처리 — token 옵션과 reason 추출은 aggregate 단계에서.
cd "$REPO_ROOT/backend/alarm-worker"

set +e
npx wrangler tail "$WORKER_NAME" --format=json 2>>"$RAW_TAIL.stderr" \
  | tee -a "$RAW_TAIL" \
  | awk -v token="$TOKEN_FILTER" '
      /"boarding-prompt: gate blocked"/ {
        if (token == "" || index($0, token) > 0) {
          print
          fflush()
        }
      }
    ' >> "$OUTPUT" &
TAIL_PID=$!

wait "$TAIL_PID"
TAIL_EXIT=$?
set -e

if [[ $TAIL_EXIT -eq 0 ]]; then
  EXIT_REASON="wrangler tail이 자체 종료 (inactivity disconnect 의심)"
else
  EXIT_REASON="wrangler tail PID=$TAIL_PID exit=$TAIL_EXIT"
fi
