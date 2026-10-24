#!/bin/bash
# 완료된 워크트리 정리
# 사용법: wt-clean.sh <이슈번호>
# 예시:   wt-clean.sh 68

set -e

ISSUE=$1

if [ -z "$ISSUE" ]; then
  echo "사용법: wt-clean.sh <이슈번호>"
  echo "예시:   wt-clean.sh 68"
  echo ""
  echo "현재 워크트리 목록:"
  git worktree list
  exit 1
fi

PROJECT_DIR=$(git -C "$(pwd)" rev-parse --show-toplevel)
PROJECT_NAME=$(basename "$PROJECT_DIR")
WORKTREE_DIR="${PROJECT_DIR}/../${PROJECT_NAME}-issue${ISSUE}"

if [ ! -d "$WORKTREE_DIR" ]; then
  echo "❌ 워크트리를 찾을 수 없음: $WORKTREE_DIR"
  exit 1
fi

echo "🗑️  워크트리 제거: $WORKTREE_DIR"
git worktree remove "$WORKTREE_DIR" --force
echo "✅ 완료"
