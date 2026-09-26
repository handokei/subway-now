#!/bin/bash
# Info.plist 동기화 체크 — #753 (#747 후속).
#
# 배경:
#   Expo 관리형 프로젝트에서 `app.config.js`의 `ios.infoPlist`가 SSOT지만,
#   실기기/EAS 빌드는 `npx expo prebuild` 산출물인 `ios/subwaynow/Info.plist`를 사용한다.
#   `npx expo run:ios`는 prebuild를 다시 돌리지 않으므로, `app.config.js`에 새 키를
#   추가하고도 `ios/` 캐시가 stale 하면 Info.plist에 반영되지 않아 실기기 splash 후
#   크래시가 발생할 수 있다 (#747 NSMotionUsageDescription 실사고).
#
# 동작:
#   1. `app.config.js`에서 `expo.ios.infoPlist` 키 목록 추출 (node 평가)
#   2. `ios/subwaynow/Info.plist`의 `<key>` 목록 추출 (plutil → JSON)
#   3. app.config.js에 선언됐지만 Info.plist에 없는 키 = drift → exit 1
#   4. Info.plist에만 있는 키는 경고만 표시 (Expo 기본 키 다수 있음)
#   5. `ios/` 디렉토리가 없으면 prebuild 안내 후 exit 0 (CI 친화적)
#
# 사용:
#   scripts/check-infoplist-sync.sh
#   npm run check:infoplist
#
# 종료 코드:
#   0  drift 없음 (또는 prebuild 안 됨)
#   1  drift 발견 (app.config.js에 있고 Info.plist에 없는 키 존재)
#   2  실행 환경/입력 오류
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_CONFIG="$ROOT_DIR/app.config.js"
INFO_PLIST="$ROOT_DIR/ios/subwaynow/Info.plist"

if [[ ! -f "$APP_CONFIG" ]]; then
  echo "[check-infoplist] app.config.js를 찾을 수 없습니다: $APP_CONFIG" >&2
  exit 2
fi

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "[check-infoplist] ios/subwaynow/Info.plist 없음 — prebuild 미실행 상태로 판단합니다."
  echo "  실기기/EAS 빌드 전 다음을 실행해 동기화하세요:"
  echo "    npx expo prebuild --platform ios"
  echo "    npm run check:infoplist"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[check-infoplist] node 명령을 찾을 수 없습니다." >&2
  exit 2
fi

if ! command -v plutil >/dev/null 2>&1; then
  echo "[check-infoplist] plutil 명령을 찾을 수 없습니다 (macOS 전용)." >&2
  exit 2
fi

# 1) app.config.js → JSON
CONFIG_JSON="$(node -e '
  const cfg = require(process.argv[1]);
  const ip = (cfg && cfg.expo && cfg.expo.ios && cfg.expo.ios.infoPlist) || {};
  process.stdout.write(JSON.stringify(ip));
' "$APP_CONFIG")"

# 2) Info.plist → JSON
PLIST_JSON="$(plutil -convert json -o - "$INFO_PLIST")"

# 3) 비교 (node로 분석 + 사람이 읽을 수 있는 출력)
node -e '
  const cfgKeys = JSON.parse(process.argv[1]);
  const plistKeys = JSON.parse(process.argv[2]);

  const cfg = Object.keys(cfgKeys).sort();
  const plist = new Set(Object.keys(plistKeys));

  const missing = cfg.filter((k) => !plist.has(k));
  const plistOnly = [...plist].filter((k) => !(k in cfgKeys)).sort();

  const fmt = (k) => {
    const v = cfgKeys[k];
    if (typeof v === "string") return `${k}  →  "${v.slice(0, 60)}${v.length > 60 ? "…" : ""}"`;
    return `${k}  (${Array.isArray(v) ? "array" : typeof v})`;
  };

  console.log(`[check-infoplist] app.config.js ios.infoPlist 키: ${cfg.length}개`);
  console.log(`[check-infoplist] Info.plist <key>: ${plist.size}개`);
  console.log("");

  if (missing.length === 0) {
    console.log("✓ drift 없음 — app.config.js의 모든 키가 Info.plist에 반영됨.");
  } else {
    console.log(`✗ drift 발견 — app.config.js에 있지만 Info.plist에 없는 키 ${missing.length}개:`);
    for (const k of missing) console.log(`    - ${fmt(k)}`);
    console.log("");
    console.log("  복구 방법:");
    console.log("    npx expo prebuild --platform ios --clean");
    console.log("    git add ios/   # 트래킹하는 경우만");
  }

  if (plistOnly.length > 0) {
    console.log("");
    console.log(`(참고) Info.plist에만 있는 키 ${plistOnly.length}개 — Expo 기본/플러그인 생성분일 수 있음:`);
    for (const k of plistOnly) console.log(`    · ${k}`);
  }

  process.exit(missing.length === 0 ? 0 : 1);
' "$CONFIG_JSON" "$PLIST_JSON"
