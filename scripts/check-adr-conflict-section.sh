#!/usr/bin/env bash
# Wire-completion CI: ADR 간 "수정·대체·모순하는 결정" 선언 검사 (#2931)
#
# 왜: ADR-039가 2026-09-03 확정 아키텍처와 표시 축 권한을 반대로 배정했는데,
# "관련" 링크만 있고 내용 대조 섹션이 없어 아무도 충돌을 못 잡았다(10/9 라이드 회귀).
# 이 스크립트는 그 재발을 막는 "섹션 존재 + 언급된 ADR 번호 실존" 2가지만 강제한다.
#
# 검사 범위: 이번 PR/커밋에서 **새로 추가(added)된** docs/decisions/ADR-*.md 파일만.
# 기존 ADR을 다른 이유(예: 본 PR의 ADR-014 룰 추가)로 수정하는 것은 검사 대상이 아니다
# — "기존 38개 ADR에 섹션 소급 추가 금지"(#2931 금지사항)와 상충하지 않도록 added-only로
# 스코프한다. renamed/modified까지 넓히면 이 PR의 ADR-014 수정 자체가 CI를 깨뜨린다.
#
# ★★★ 토폴로지 제약 (#2935, #2932 회귀) ★★★
# 이 스크립트는 base가 **dev인 PR 전용**이다 — ADR 작성은 feature→dev에서 일어난다.
# base가 main(릴리스 PR, dev→main)이면 main 이후 작성된 모든 ADR이 "added"로 집계되어
# 섹션 없는 기존 ADR 전부가 FAIL하는 소급 강제가 된다(의도와 반대). 그래서:
#   1) 워크플로 레벨에서 base=main PR은 이 job 자체를 실행하지 않는다
#      (.github/workflows/wire-completion.yml의 job-level `if`).
#   2) 이 스크립트도 전달된 BASE_REF가 origin/main과 동일한 커밋을 가리키면
#      자체적으로 skip + 사유 로그 + exit 0 한다 — 워크플로 if 없이 로컬/다른 경로로
#      직접 호출되어도("base=main" 검증 포함) 안전하게 동작하도록 하는 방어선이다.
#
# 검사 내용:
#   1. "## 이 ADR이 수정·대체·모순하는 결정" 섹션이 존재하고, 본문이 비어있지 않을 것.
#   2. 그 섹션 본문에 언급된 "ADR-0NN" 패턴이 실제로 docs/decisions/ADR-0NN-*.md로 존재할 것.
#
# ★★★ 한계 (과신 방지, 이슈 스펙 2항목) ★★★
# 이 스크립트는 "섹션이 있는가 / 언급된 ADR 번호가 실존하는가"만 기계적으로 판정한다.
# 섹션 내용이 실제로 정확한 충돌 분석인지, 빠뜨린 충돌이 없는지는 전혀 판정하지 못한다.
# "없음 — 확인한 결정 목록: ADR-0NN"이라고만 적고 실제로는 안 읽었어도 이 스크립트는 통과시킨다.
# 섹션 내용의 정확성 검증은 전적으로 코드 리뷰(사람)의 책임이다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DECISIONS_DIR="$REPO_ROOT/docs/decisions"

SECTION_HEADING='## 이 ADR이 수정·대체·모순하는 결정'

# base ref: 1st arg > origin/dev와의 merge-base > HEAD~1
BASE_REF="${1:-}"
if [ -z "$BASE_REF" ]; then
  if git -C "$REPO_ROOT" rev-parse --verify origin/dev >/dev/null 2>&1; then
    BASE_REF="$(git -C "$REPO_ROOT" merge-base origin/dev HEAD 2>/dev/null || echo origin/dev)"
  else
    BASE_REF="HEAD~1"
  fi
fi

# base=main(릴리스 PR) skip: BASE_REF가 origin/main과 동일 커밋을 가리키면
# "새로 작성하는 ADR"이 아니라 "이미 승인된 ADR을 배송만" 하는 경우이므로 검사하지 않는다.
# 조용한 통과로 오인되지 않게 사유를 로그에 명시한다(이슈 스펙 2항목).
RESOLVED_BASE_SHA=$(git -C "$REPO_ROOT" rev-parse "$BASE_REF" 2>/dev/null || echo "")
MAIN_SHA=$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$RESOLVED_BASE_SHA" ] && [ -n "$MAIN_SHA" ] && [ "$RESOLVED_BASE_SHA" = "$MAIN_SHA" ]; then
  echo "base=main (릴리스 PR) — ADR 작성 PR이 아니므로 skip"
  exit 0
fi

CHANGED_FILES=$(git -C "$REPO_ROOT" diff --name-only --diff-filter=A "$BASE_REF" -- 'docs/decisions/ADR-*.md' || true)

if [ -z "$CHANGED_FILES" ]; then
  echo "변경/추가된 ADR 파일 없음. 검사 skip."
  exit 0
fi

FAIL=0

for FILE in $CHANGED_FILES; do
  FULL_PATH="$REPO_ROOT/$FILE"

  if [ ! -f "$FULL_PATH" ]; then
    # 삭제된 파일은 검사 대상 아님
    continue
  fi

  echo "검사: $FILE"
  FILE_FAIL=0

  if ! grep -qF "$SECTION_HEADING" "$FULL_PATH"; then
    echo "  FAIL — 섹션 없음: \"$SECTION_HEADING\""
    FAIL=1
    continue
  fi

  # 섹션 본문 추출: 헤딩 다음 줄부터 다음 "## " 헤딩(또는 EOF) 전까지
  SECTION_BODY=$(awk -v heading="$SECTION_HEADING" '
    found && /^## / { exit }
    found { print }
    $0 == heading { found=1 }
  ' "$FULL_PATH")

  TRIMMED_BODY=$(echo "$SECTION_BODY" | sed '/^[[:space:]]*$/d')

  if [ -z "$TRIMMED_BODY" ]; then
    echo "  FAIL — 섹션은 있으나 본문이 비어있음"
    FAIL=1
    continue
  fi

  # 섹션 본문에 언급된 ADR-0NN 패턴이 실제로 존재하는지 검사
  MENTIONED_ADRS=$(echo "$SECTION_BODY" | grep -oE 'ADR-[0-9]{3}' | sort -u || true)

  for ADR_REF in $MENTIONED_ADRS; do
    if ! ls "$DECISIONS_DIR/${ADR_REF}-"*.md >/dev/null 2>&1; then
      echo "  FAIL — 존재하지 않는 ADR 언급: $ADR_REF"
      FAIL=1
      FILE_FAIL=1
    fi
  done

  if [ "$FILE_FAIL" -eq 0 ]; then
    echo "  OK"
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "→ 변경/추가된 ADR에 \"$SECTION_HEADING\" 섹션을 추가하거나, 언급한 ADR 번호를 확인해라."
  echo "→ 해당 없으면 \"없음 — 확인한 결정 목록: ADR-0NN, ADR-0MM, memory/<file>\"로 확인한 사실을 명시한다."
  exit 1
fi

echo ""
echo "모든 변경 ADR이 충돌 선언 섹션을 갖추고 있음."
exit 0
