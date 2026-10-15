#!/usr/bin/env bash
# 떠돌이 중첩 `node_modules` 심볼릭 링크 탐지 (#2995)
#
# ## 무엇을 막는가
#
# 2026-09-21 로컬에 다음 심볼릭 링크가 생겼다(생성 주체 미확인 — 레포 스크립트에는 이런 구문이
# 없다. `npm scripts` 전수 확인):
#
#   node_modules/node_modules -> <repo>/backend/alarm-worker/node_modules
#
# node 모듈 해석은 basedir에서 디렉토리를 거슬러 올라가며 각 단계의 `node_modules`를 후보로
# 넣는다. 그 후보 목록에는 `<repo>/node_modules/node_modules`도 **항상** 들어가는데(root
# `node_modules`로 올라가는 경로상), 보통 존재하지 않아 조용히 건너뛴다. 위 링크가 그 자리를
# 채우자 **root `node_modules`보다 먼저** 탐색돼 backend의 의존성이 device 빌드/테스트를
# 이겼다.
#
# 실측 피해: device `npm test`가 **125 failed / 59 suites**(`SyntaxError: Unexpected token
# 'export'` — backend의 ESM-only `ansi-regex` v6가 root의 CJS v5를 가림). CI는 backend
# 의존성을 설치하지 않아 **green**이었으므로 로컬에서만, 그리고 **조용히** 깨졌다.
#
# 가장 나쁜 점은 테스트가 깨진 것 자체가 아니라 **측정이 무효가 되는 것**이다: 59개 스위트가
# 아예 실행되지 않은 상태에서 mutation 측정을 돌리면 baseline과 mutant가 똑같이 "125 failed"로
# 나와 "이 결함은 아무도 잡지 못한다"는 **거짓 결론**이 나온다(#2993 작업 중 실제로 발생).
#
# `jest`의 `modulePathIgnorePatterns: ['<rootDir>/backend/']`로는 막히지 않는다 — 탐색 중
# 경로는 `<rootDir>/node_modules/node_modules/...`이고, backend 경로로 바뀌는 것은
# `realpathSync`(`preserveSymlinks: false`) 이후, 즉 해석이 끝난 뒤다.
#
# ## 정책
#
# 레포 안을 가리키는 `node_modules` **심볼릭 링크**는 전부 거부한다(이 레포는 plain npm —
# workspace/pnpm 링크 전략을 쓰지 않으므로 정상적인 경우가 없다). 발견되면 exit 1.
set -euo pipefail

# `-type l` + 이름이 정확히 node_modules인 것만. maxdepth 4로 상위 구조만 본다(실 node_modules
# 내부를 전수 순회하면 느리고, 해석을 가리는 위치는 상위 몇 단계에 한정된다).
STRAY=$(find . -maxdepth 4 -name node_modules -type l -not -path './.git/*' 2>/dev/null || true)

if [ -n "$STRAY" ]; then
  echo "떠돌이 node_modules 심볼릭 링크 발견 (#2995) — 모듈 해석이 조용히 오염됩니다:"
  echo ""
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    printf '  %s -> %s\n' "$link" "$(readlink "$link")"
  done <<< "$STRAY"
  echo ""
  echo "이 링크는 root node_modules보다 먼저 탐색돼 다른 프로젝트의 의존성이 이 프로젝트를"
  echo "이깁니다. 테스트가 깨지는 것보다 **측정이 조용히 무효가 되는 것**이 더 위험합니다"
  echo "(스위트가 아예 실행되지 않은 채 'mutation이 안 잡혔다'로 보입니다)."
  echo ""
  echo "조치 — 링크만 삭제하면 타겟(실제 node_modules)은 보존됩니다:"
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    printf '  rm %s\n' "$link"
  done <<< "$STRAY"
  exit 1
fi

echo "No stray node_modules symlinks detected."
