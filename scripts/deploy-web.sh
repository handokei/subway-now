#!/bin/bash
# #2698 — 웹(Expo export) 정적 에셋 배포 전용 스크립트.
# 루트 wrangler.jsonc(worker: subway-now)를 --config로 명시해 backend/alarm-worker/의
# wrangler.toml(worker: subway-now-alarm-worker)과 절대 혼동되지 않게 한다.
# 배포 후 출력에서 대상 worker명을 확인해 엉뚱한 worker가 배포되지 않았는지 검증한다.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_NAME="subway-now"

npx expo export -p web

echo "── 배포: ${EXPECTED_NAME} (wrangler.jsonc) ──"
DEPLOY_OUT=$(npx wrangler deploy --config wrangler.jsonc 2>&1)
echo "$DEPLOY_OUT"
echo ""
DEPLOY_OUT_PLAIN=$(echo "$DEPLOY_OUT" | sed -E 's/\x1b\[[0-9;]*m//g')

if ! echo "$DEPLOY_OUT_PLAIN" | grep -q "Deployed ${EXPECTED_NAME}"; then
  echo "❌ postdeploy 검증 실패: worker '${EXPECTED_NAME}' 배포 확인 불가(#2698)." >&2
  exit 1
fi
echo "✅ 배포 검증 완료: ${EXPECTED_NAME}"
