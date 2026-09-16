#!/bin/bash
# Wrangler tail 캡처 — #622 transfer-leg sync 진단용.
#
# 사용:
#   scripts/capture-tail.sh [label]
#   예: scripts/capture-tail.sh transfer-test
#   npm run tail:capture -- transfer-test    # ← npm 경유 시 -- 필수
#
# 요구사항: bash, npx(wrangler), 분석 시 jq (macOS: brew install jq)
#
# 동작:
#   - backend/alarm-worker의 wrangler.toml에서 worker name 추출 (SSOT)
#   - npx wrangler tail "$WORKER_NAME" --format=json
#   - 표준출력 + 파일(tasks/wrangler-tail-<timestamp>-<label>.jsonl) 동시 기록
#   - Ctrl+C로 종료
#
# 분석 팁 (jq 사용):
#   - lockMissing 시점만:
#       jq 'select(.event.outcome.lockMissing > 0)' tasks/wrangler-tail-*.jsonl
#   - POST /trips 호출 시각:
#       jq -r 'select(.event.request.url? | endswith("/trips")) | .event.rayId,.eventTimestamp' tasks/wrangler-tail-*.jsonl
#   - reschedule push 발사:
#       jq 'select(.logs[]?.message[]? | test("reschedule push"))' tasks/wrangler-tail-*.jsonl
set -euo pipefail

LABEL="${1:-capture}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[capture-tail] label은 [A-Za-z0-9._-]만 허용됩니다: $LABEL" >&2
  exit 2
fi

TS=$(date +%Y%m%d-%H%M%S)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/tasks/wrangler-tail-$TS-$LABEL.jsonl"

WORKER_NAME=$(awk -F'"' '/^name *=/ {print $2; exit}' "$REPO_ROOT/backend/alarm-worker/wrangler.toml")
if [[ -z "$WORKER_NAME" ]]; then
  echo "[capture-tail] backend/alarm-worker/wrangler.toml에서 worker name을 추출하지 못했습니다." >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/tasks"

echo "[capture-tail] worker: $WORKER_NAME"
echo "[capture-tail] backend/alarm-worker → wrangler tail (json)"
echo "[capture-tail] 저장 경로: $OUT"
echo "[capture-tail] Ctrl+C로 종료"
echo

cd "$REPO_ROOT/backend/alarm-worker"
npx wrangler tail "$WORKER_NAME" --format=json | tee "$OUT"
