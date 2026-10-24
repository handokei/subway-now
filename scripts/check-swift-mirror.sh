#!/usr/bin/env bash
# Swift 안전망 CI 1/2 (#2839): ⚠️MIRROR 사본 diff 가드
#
# modules/live-activity/ios/SubwayActivityAttributes.swift 와
# targets/subway-widget/_shared/SubwayActivityAttributes.swift 는 LiveActivity CocoaPod 모듈이
# @bacons/apple-targets의 _shared 자동 링크 범위 밖이라 손으로 동기화하는 사본 2벌이다.
# 두 파일의 헤더 주석은 "자기 자신 기준으로 상대 파일을 가리키는" 자기참조 문구라 서로
# 의도적으로 다르게 쓰여 있다(예: "modules/... 를 보라" vs "targets/... 를 보라). 이 스크립트는
# `//` 로 시작하는 순수 주석 라인을 제외한 본문(코드/필드 선언)이 byte-identical한지만 검사한다.
#
# 불일치(=필드 drift, 즉 widget/app/pod 간 ActivityKit wire format 불일치 위험) 시 exit 1.

set -euo pipefail

FILE_A="modules/live-activity/ios/SubwayActivityAttributes.swift"
FILE_B="targets/subway-widget/_shared/SubwayActivityAttributes.swift"

for f in "$FILE_A" "$FILE_B"; do
  if [ ! -f "$f" ]; then
    echo "MIRROR 가드 오류: $f 가 없다. scripts/check-swift-mirror.sh의 FILE_A/FILE_B 경로를 갱신하라."
    exit 1
  fi
done

strip_comments() {
  grep -v '^[[:space:]]*//' "$1"
}

if ! diff_output=$(diff <(strip_comments "$FILE_A") <(strip_comments "$FILE_B")); then
  echo "MIRROR drift detected (Wire-completion 5단 룰 위반 위험):"
  echo "  $FILE_A"
  echo "  $FILE_B"
  echo ""
  echo "$diff_output"
  echo ""
  echo "→ 한쪽을 수정했으면 반드시 다른 쪽도 함께 갱신하라 (헤더 주석 문구 차이는 무시됨, 코드만 비교)."
  exit 1
fi

echo "OK: Swift MIRROR 사본 2벌이 코드 기준 동일하다."
exit 0
