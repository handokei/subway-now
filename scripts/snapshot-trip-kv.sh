#!/bin/bash
# Trip KV snapshot — backend TRIPS KV의 trip:{tokenPrefix} 키를 주기적으로 캡처한다 (#1519).
#
# 사용:
#   scripts/snapshot-trip-kv.sh <tokenPrefix> [--interval=60] [--duration=3600]
#   예: scripts/snapshot-trip-kv.sh a1b2c3d4 --interval=30 --duration=1800
#   npm run kv:snapshot -- a1b2c3d4 --interval=30    # ← npm 경유 시 -- 필수
#
# 인자:
#   tokenPrefix    [A-Fa-f0-9]{4,16}. trip:<prefix> 키를 조회.
#   --interval=N   샘플링 주기(초, 기본 60). 양의 정수.
#   --duration=N   총 실행 시간(초, 기본 3600). 양의 정수.
#
# 요구사항: bash, npx(wrangler), Cloudflare 인증, 분석 시 jq.
#
# 동작:
#   - backend/alarm-worker/wrangler.toml에서 worker name(SSOT)만 추출 (출력에 영향 X)
#   - interval마다 `npx wrangler kv key get --binding=TRIPS "trip:<prefix>" --remote` 호출
#   - 결과를 NDJSON으로 tasks/trip-kv-<timestamp>-<prefix>.jsonl 에 저장
#       각 줄: {"ts":"<ISO>","kv":<parsed JSON or null>,"error":"<msg>"?}
#   - duration 경과 후 종료. Ctrl+C로 즉시 종료 가능.
#
# 분석 팁 (jq 사용):
#   - currentLine 시계열:
#       jq -r '[.ts, (.kv.currentLine // "null")] | @tsv' tasks/trip-kv-*.jsonl
#   - scheduledPushes 개수 변화:
#       jq -r '[.ts, (.kv.scheduledPushes // [] | length)] | @tsv' tasks/trip-kv-*.jsonl
#   - lock 활성 구간만:
#       jq 'select(.kv.lock?.active == true) | {ts, station: .kv.lock.stationName}' tasks/trip-kv-*.jsonl
#   - 두 스냅샷 사이 diff:
#       jq -s '.[0].kv as $a | .[-1].kv as $b | {first:$a, last:$b}' tasks/trip-kv-*.jsonl
#   - error 발생 시점:
#       jq 'select(.error)' tasks/trip-kv-*.jsonl
set -euo pipefail

usage() {
  sed -n '2,28p' "$0" >&2
  exit "${1:-2}"
}

TOKEN_PREFIX=""
INTERVAL=60
DURATION=3600

for arg in "$@"; do
  case "$arg" in
    --interval=*) INTERVAL="${arg#--interval=}" ;;
    --duration=*) DURATION="${arg#--duration=}" ;;
    -h|--help) usage 0 ;;
    --*) echo "[snapshot-trip-kv] 알 수 없는 옵션: $arg" >&2; usage ;;
    *)
      if [[ -z "$TOKEN_PREFIX" ]]; then
        TOKEN_PREFIX="$arg"
      else
        echo "[snapshot-trip-kv] tokenPrefix는 한 번만 지정해야 합니다: $arg" >&2
        usage
      fi
      ;;
  esac
done

if [[ -z "$TOKEN_PREFIX" ]]; then
  echo "[snapshot-trip-kv] tokenPrefix 인자가 필요합니다." >&2
  usage
fi

if [[ ! "$TOKEN_PREFIX" =~ ^[A-Fa-f0-9]{4,16}$ ]]; then
  echo "[snapshot-trip-kv] tokenPrefix는 [A-Fa-f0-9]{4,16}이어야 합니다: $TOKEN_PREFIX" >&2
  exit 2
fi

if [[ ! "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "[snapshot-trip-kv] --interval은 양의 정수여야 합니다: $INTERVAL" >&2
  exit 2
fi

if [[ ! "$DURATION" =~ ^[1-9][0-9]*$ ]]; then
  echo "[snapshot-trip-kv] --duration은 양의 정수여야 합니다: $DURATION" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRANGLER_TOML="$REPO_ROOT/backend/alarm-worker/wrangler.toml"

if [[ ! -f "$WRANGLER_TOML" ]]; then
  echo "[snapshot-trip-kv] wrangler.toml을 찾을 수 없습니다: $WRANGLER_TOML" >&2
  exit 1
fi

WORKER_NAME=$(awk -F'"' '/^name *=/ {print $2; exit}' "$WRANGLER_TOML")
if [[ -z "$WORKER_NAME" ]]; then
  echo "[snapshot-trip-kv] backend/alarm-worker/wrangler.toml에서 worker name을 추출하지 못했습니다." >&2
  exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
OUT="$REPO_ROOT/tasks/trip-kv-$TS-$TOKEN_PREFIX.jsonl"
KEY="trip:$TOKEN_PREFIX"

mkdir -p "$REPO_ROOT/tasks"

# Allow tests/dry-runs to inject a fake wrangler binary.
WRANGLER_BIN="${WRANGLER_BIN:-npx wrangler}"

echo "[snapshot-trip-kv] worker: $WORKER_NAME"
echo "[snapshot-trip-kv] key: $KEY"
echo "[snapshot-trip-kv] interval: ${INTERVAL}s / duration: ${DURATION}s"
echo "[snapshot-trip-kv] 저장 경로: $OUT"
echo "[snapshot-trip-kv] Ctrl+C로 즉시 종료"
echo

cd "$REPO_ROOT/backend/alarm-worker"

# json-string escape (백슬래시/큰따옴표/제어문자 최소 처리).
json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))'
}

snapshot_once() {
  local now stdout rc line
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set +e
  stdout=$($WRANGLER_BIN kv key get --binding=TRIPS "$KEY" --remote 2>&1)
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    local err_json
    err_json=$(printf '%s' "$stdout" | json_escape)
    line=$(printf '{"ts":"%s","kv":null,"error":%s}' "$now" "$err_json")
  elif [[ -z "$stdout" || "$stdout" == "null" ]]; then
    line=$(printf '{"ts":"%s","kv":null}' "$now")
  else
    # If wrangler stdout is valid JSON, embed as-is; otherwise wrap as string under error.
    if printf '%s' "$stdout" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d);process.exit(0)}catch(e){process.exit(1)}})' >/dev/null 2>&1; then
      line=$(printf '{"ts":"%s","kv":%s}' "$now" "$stdout")
    else
      local raw_json
      raw_json=$(printf '%s' "$stdout" | json_escape)
      line=$(printf '{"ts":"%s","kv":null,"error":%s}' "$now" "$raw_json")
    fi
  fi
  printf '%s\n' "$line" >> "$OUT"
  printf '[snapshot-trip-kv] %s 1 sample appended\n' "$now"
}

START=$(date +%s)
END=$(( START + DURATION ))

while :; do
  snapshot_once
  NOW=$(date +%s)
  REMAINING=$(( END - NOW ))
  if (( REMAINING <= 0 )); then
    break
  fi
  if (( REMAINING < INTERVAL )); then
    sleep "$REMAINING"
  else
    sleep "$INTERVAL"
  fi
done

echo "[snapshot-trip-kv] 완료. 총 출력: $OUT"
