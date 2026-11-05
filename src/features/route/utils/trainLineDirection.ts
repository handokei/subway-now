import i18next from 'i18next';
import type { Station } from '../../../shared/types/station';
import { getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';

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
 * #807: 종착(마천행/방화행 등)이 아니라 **다음으로 지날 인접역 방면**만 노출한다.
 *
 * 사용자 요구(#807): "내가 타야하는 다음 역" 정보만 한 줄로. 종착 표기는 정보 과부하 + 노선별
 * 분기(상일동/하남검단산 등) 누락 회귀의 원인이라 제거. nextStationLabel이 있으면 항상
 * `<name>방면`만 반환한다 — terminal/destination 비교 없이 일관 통일.
 *
 * nextStationLabel 미전달(null/빈문자) 시에만 종착(`parseTrainLineDirection`)으로 fallback —
 * 환승 list 등에서 진행 방향 미정인 경우 종착 텍스트라도 보여주기 위함.
 *
 * 다국어:
 *   - ko: "<name>방면"
 *   - en: "via <name>"
 *   - ja: "<name>方面"
 *   - zh: "<name>方向"
 *
 * 회귀 가드(#807):
 *   - destination="마천행", nextStationLabel="중곡" → "중곡방면" (5호선 마천/방화 누락 차단)
 *   - destination="어린이대공원(세종대)방면", nextStationLabel="어린이대공원" → "어린이대공원방면"
 *   - destination="내선순환", nextStationLabel="신도림" → "신도림방면"
 *
 * stations 인자는 fallback 경로(`parseTrainLineDirection`)에서만 사용. 일반 경로는 i18n 키만 사용.
 */
export function buildDirectionMeta(
  destination: string,
  nextStationLabel: string | null,
  stations: readonly Station[],
): string {
  if (!nextStationLabel) return parseTrainLineDirection(destination, stations);
  return i18next.t('direction.viaName', { name: nextStationLabel });
}
