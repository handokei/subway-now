#!/bin/bash
# #2698 — backend 배포 config 하이재킹 차단
#
# 배경: backend/alarm-worker/ 에는 wrangler.toml 만 있는데도, wrangler 4.x 가 상위
# 디렉토리의 루트 wrangler.jsonc(웹 export 배포용, 바인딩/cron 없음)를 채택해버리는
# 사고가 실사용자와 에이전트 각각 1회씩(2026-09-17) 발생했다. bare `wrangler deploy`
# 는 이 경로를 원천적으로 열어둔다 — 반드시 이 스크립트(`npm run deploy`)로만 배포한다.
#
# 안전장치 2단:
#   [1/2] predeploy dry-run — 바인딩 7종이 실제로 잡히는지 실배포 전에 확인.
#         하이재킹되면 바인딩 0개로 나오므로 여기서 즉시 중단된다.
#   [2/2] 실배포 후 출력에서 worker명 + cron 이 정확히 찍혔는지 확인.
#         (dry-run 출력에는 worker명/cron 이 나오지 않아 실배포 출력으로만 검증 가능)
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_NAME="subway-now-alarm-worker"
EXPECTED_CRON="*/1 * * * *"
EXPECTED_BINDING_COUNT=7

echo "── [1/2] predeploy dry-run: 바인딩 ${EXPECTED_BINDING_COUNT}종 확인 ──"
DRY_OUT=$(npx wrangler deploy --dry-run --outdir /tmp/subway-now-alarm-worker-dryrun --config wrangler.toml 2>&1)
echo "$DRY_OUT"
# ANSI 컬러 코드 제거 후 리소스 바인딩(KV/D1/R2/DO)만 카운트. 평문 Environment Variable은 제외.
BINDING_COUNT=$(echo "$DRY_OUT" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -E "^env\." | grep -vc "Environment Variable")
if [ "$BINDING_COUNT" -ne "$EXPECTED_BINDING_COUNT" ]; then
  echo "" >&2
  echo "❌ predeploy 검증 실패: 바인딩 ${EXPECTED_BINDING_COUNT}종을 기대했으나 ${BINDING_COUNT}종만 발견." >&2
  echo "   루트 wrangler.jsonc 로 config 가 하이재킹됐을 가능성이 높다(#2698). 실배포를 중단한다." >&2
  exit 1
fi
echo "✅ 바인딩 ${BINDING_COUNT}종 확인 (${EXPECTED_NAME})"
echo ""

echo "── [2/2] 실배포 ──"
DEPLOY_OUT=$(npx wrangler deploy --config wrangler.toml 2>&1)
echo "$DEPLOY_OUT"
echo ""
DEPLOY_OUT_PLAIN=$(echo "$DEPLOY_OUT" | sed -E 's/\x1b\[[0-9;]*m//g')

if ! echo "$DEPLOY_OUT_PLAIN" | grep -q "Deployed ${EXPECTED_NAME}"; then
  echo "❌ postdeploy 검증 실패: worker '${EXPECTED_NAME}' 배포 확인 불가 — 잘못된 worker가 배포됐을 수 있다(#2698)." >&2
  exit 1
fi
if ! echo "$DEPLOY_OUT_PLAIN" | grep -qF "${EXPECTED_CRON}"; then
  echo "❌ postdeploy 검증 실패: cron '${EXPECTED_CRON}' 확인 불가." >&2
  exit 1
fi
echo "✅ 배포 검증 완료: ${EXPECTED_NAME} + cron ${EXPECTED_CRON}"
