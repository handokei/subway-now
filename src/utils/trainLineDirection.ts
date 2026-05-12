import i18next from 'i18next';
import type { Station } from '../types/station';
import { getStationDisplayNameByName } from './stationDisplay';

// 서울 열린데이터 API의 trainLineNm 필드는 순수 역명이 아닌 방면 표현을 담는다:
//   - "<역명>행" 일반 노선 (소요산행, 성수행, 광운대행 등)
//   - "내선순환" / "외선순환" 2호선 순환선 특수
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
