#!/usr/bin/env bash
# Wire-completion CI: detects orphan exports (#1582)
#
# 정책: "(used in module)" 라인은 ts-prune false-positive (모듈 내부 자기 참조)이므로 무시한다.
# entry-point/배럴 re-export 경로(app/, modules/, providers/index.ts, theme/index.ts,
# shared/types/ 등)는 --ignore regex로 제외한다.
#
# 새로운 orphan(미연결 export)이 발견되면 exit 1 → CI fail.
# 의도적 entry-point 추가 시 IGNORE_PATTERN 갱신.

set -euo pipefail

IGNORE_PATTERN='app/|modules/|providers/index\.ts|providers/types\.ts|providers/progress/index\.ts|theme/index\.ts|src/shared/types/|src/shared/constants/(e2e|storageKeys)\.ts|silentPushTask\.ts|movementGate\.ts|useColdStartCandidates\.ts'

OUTPUT=$(npx --no-install ts-prune --ignore "$IGNORE_PATTERN" 2>&1 | grep -v "(used in module)" || true)

if [ -n "$OUTPUT" ]; then
  echo "Orphan exports detected (Wire-completion 5단 룰 위반):"
  echo "$OUTPUT"
  echo ""
  echo "→ caller 추가 또는 export 제거. 의도적 entry-point면 scripts/check-orphan-exports.sh IGNORE_PATTERN 갱신."
  exit 1
fi

echo "No orphan exports detected."
exit 0
