import i18next from 'i18next';
import type { Station } from '../types/station';
import { getStationDisplayNameByName } from './stationDisplay';

// 서울 열린데이터 API의 trainLineNm 필드는 순수 역명이 아닌 방면 표현을 담는다:
//   - "<역명>행" 일반 노선 (소요산행, 성수행, 광운대행 등)
//   - "내선순환" / "외선순환" 2호선 순환선 특수
//   - "<역명>방면" 또는 "<역명>(<별칭>)방면" — 종착이 본선 외 지선 분기 시 (#792 회귀에서 관찰)
// 이 함수는 패턴을 인식해 현재 언어로 자연스러운 방면 표시를 반환한다.
// 매칭 안 되는 입력은 원본을 그대로 반환 (fallback).
export function parseTrainLineDirection(
  trainLineNm: string,
  stations: readonly Station[],
): string {
  if (trainLineNm === '내선순환') return i18next.t('direction.innerLoop');
  if (trainLineNm === '외선순환') return i18next.t('direction.outerLoop');

  if (trainLineNm.endsWith('행')) {
    const stationName = trainLineNm.slice(0, -1);
    // 빈 역명 가드 — "행" 단독이거나 비정상 입력은 원본 그대로
    if (stationName.length === 0) return trainLineNm;
    const displayName = getStationDisplayNameByName(stationName, stations);
    return i18next.t('direction.boundFor', { name: displayName });
  }

  return trainLineNm;
}

/**
 * #792: 종착역의 "기준 역명"만 추출한다. dedup용 정확 비교 키.
 *
 * 패턴별 추출:
 *   "도봉산행"               → "도봉산"
 *   "어린이대공원(세종대)방면" → "어린이대공원"   (괄호 안 별칭/노선 표기 제거)
 *   "어린이대공원방면"         → "어린이대공원"
 *   "내선순환" / "외선순환"    → null            (순환선은 종착이 없음)
 *   ""                       → null
 *   "비정형 텍스트"            → null            (외부 호출자는 비교 못 함 → 안전한 fallback)
 *
 * 호출자(`buildDirectionMeta`)는 추출된 terminal이 nextStationLabel과 **정확히 같을 때만** dedup해
 * substring false-positive(예: "도봉산행".includes("도봉")=true → 잘못된 dedup)를 방지한다.
 *
 * 구현 노트: `.+?` 같은 lazy quantifier + optional group 조합은 ReDoS(super-linear backtracking)
 * 위험이라 sonar:typescript:S5852가 잡는다. suffix 매칭 + 단순 char-class 정규식으로 회피한다.
 */
const TRAILING_PAREN_ALIAS_RE = /\([^()]*\)$/;
const TERMINAL_SUFFIX_BOUND_FOR = '행';
const TERMINAL_SUFFIX_VIA_NAME = '방면';

export function getTerminalStationName(trainLineNm: string): string | null {
  if (!trainLineNm) return null;
  if (trainLineNm === '내선순환' || trainLineNm === '외선순환') return null;

  if (trainLineNm.endsWith(TERMINAL_SUFFIX_VIA_NAME)) {
    const withoutSuffix = trainLineNm.slice(0, -TERMINAL_SUFFIX_VIA_NAME.length);
    const withoutAlias = withoutSuffix.replace(TRAILING_PAREN_ALIAS_RE, '');
    return withoutAlias.length > 0 ? withoutAlias : null;
  }
  if (trainLineNm.endsWith(TERMINAL_SUFFIX_BOUND_FOR)) {
    const withoutSuffix = trainLineNm.slice(0, -TERMINAL_SUFFIX_BOUND_FOR.length);
    return withoutSuffix.length > 0 ? withoutSuffix : null;
  }
  return null;
}

/**
 * #792: 종착·방면 라벨 빌더. parseTrainLineDirection으로 종착 표기 i18n 정규화 후, nextStationLabel과
 * 종착 역명이 같으면 "방면" 접미사 생략(중복 차단). 다국어 부속 라벨은 `direction.viaName` 키 사용.
 *
 * 회귀 가드:
 *   - destination="어린이대공원(세종대)방면", nextStationLabel="어린이대공원" → terminal 일치 → dedup ✓
 *   - destination="도봉산행", nextStationLabel="도봉" → terminal "도봉산" ≠ "도봉" → 정상 부착 ✓
 *     (이전 substring 기반은 false-positive로 dedup해 사용자에게 방면 정보 누락)
 *   - destination="도봉산행", nextStationLabel="도봉산" → terminal 일치 → dedup ✓
 *   - destination="내선순환" → terminal null → 항상 부속 라벨 부착 (단 nextStationLabel 있을 때)
 */
export function buildDirectionMeta(
  destination: string,
  nextStationLabel: string | null,
  stations: readonly Station[],
): string {
  const direction = parseTrainLineDirection(destination, stations);
  if (!nextStationLabel) return direction;
  const terminal = getTerminalStationName(destination);
  if (terminal !== null && terminal === nextStationLabel) return direction;
  return `${direction} · ${i18next.t('direction.viaName', { name: nextStationLabel })}`;
}
