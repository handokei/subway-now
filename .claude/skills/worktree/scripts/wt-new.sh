#!/bin/bash
# 새 격리된 워크트리 생성 + node_modules 실제 install (symlink 금지)
# 사용법: wt-new.sh <이슈번호> <타입> <기능명>
# 예시:   wt-new.sh 68 feat widget-destination
#         wt-new.sh 69 fix arrival-crash
#
# 본 스크립트는 이슈 #1090(워크트리 symlink 시 jest 35건 false positive)을 막기 위해
# `npm install`을 항상 자동 실행한다. node_modules symlink는 절대 사용하지 않는다.

set -e

ISSUE=$1
TYPE=$2
NAME=$3

if [ -z "$ISSUE" ] || [ -z "$TYPE" ] || [ -z "$NAME" ]; then
  echo "사용법: wt-new.sh <이슈번호> <타입> <기능명>"
  echo "예시:   wt-new.sh 68 feat widget-destination"
  exit 1
fi

BRANCH="${TYPE}/#${ISSUE}-${NAME}"
PROJECT_DIR=$(git -C "$(pwd)" rev-parse --show-toplevel)
PROJECT_NAME=$(basename "$PROJECT_DIR")
WORKTREE_DIR="${PROJECT_DIR}/../${PROJECT_NAME}-issue${ISSUE}"

echo "📁 워크트리 생성 중..."
echo "  브랜치: $BRANCH"
echo "  경로:   $WORKTREE_DIR"

# dev 최신화 후 워크트리 생성
cd "$PROJECT_DIR"
git fetch origin
git worktree add "$WORKTREE_DIR" -b "$BRANCH" origin/dev

# ─────────────────────────────────────────────────────────────
# node_modules 실제 install (symlink 금지 — 이슈 #1090)
# ─────────────────────────────────────────────────────────────
echo ""
echo "📦 npm install 실행 중 (symlink 금지, 실제 install)..."
echo "   사유: node_modules symlink 시 로컬 expo modules 상대 심링크가"
echo "         메인 repo로 해석되어 jest mock이 매칭되지 않음 (#1090)."

cd "$WORKTREE_DIR"

# 혹시라도 워크트리에 symlink가 미리 만들어진 경우 제거
if [ -L node_modules ]; then
  echo "⚠️  기존 node_modules symlink 감지 — 제거 후 실제 install"
  rm node_modules
fi

if npm install --prefer-offline --no-audit --no-fund; then
  echo "✅ npm install 완료"
else
  echo "❌ npm install 실패 — 워크트리는 유지되었으니 수동으로 재시도하세요:"
  echo "   cd $WORKTREE_DIR && npm install --prefer-offline --no-audit --no-fund"
  exit 1
fi

# ─────────────────────────────────────────────────────────────
# 검증
# ─────────────────────────────────────────────────────────────
echo ""
echo "🔍 검증 중..."

if [ -L node_modules ]; then
  echo "❌ FAIL: node_modules가 여전히 symlink 입니다. 수동 점검 필요."
  exit 1
fi
echo "  ✓ node_modules는 실제 디렉토리"

RESOLVED=$(node -e "console.log(require.resolve('live-activity'))" 2>/dev/null || echo "")
if [ -z "$RESOLVED" ]; then
  echo "  ⚠️  live-activity resolve 실패 (선택적 모듈일 수 있음 — 무시)"
elif [[ "$RESOLVED" != "$WORKTREE_DIR"* ]]; then
  echo "❌ FAIL: live-activity가 워크트리 외부로 resolve 됨"
  echo "   resolved: $RESOLVED"
  echo "   expected prefix: $WORKTREE_DIR"
  exit 1
else
  echo "  ✓ live-activity resolve OK ($RESOLVED)"
fi

echo ""
echo "✅ 완료! 아래 명령으로 이동하세요:"
echo ""
echo "  cd $WORKTREE_DIR && claude"
echo ""
