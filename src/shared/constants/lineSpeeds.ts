/**
 * 노선별 평균 운행 속도(km/h) — 표정속도 기반.
 *
 * 출처 (운영사 공개 자료, 정차 시간 포함 평균):
 *   - 1~8호선: 약 32 km/h (서울교통공사 일반 평균)
 *   - 9호선: 약 40 km/h (완행 기준; 급행 60 분리는 후속 작업)
 *   - 신분당: 약 50 km/h (네오트랜스)
 *   - 공항철도: 약 60 km/h (직통 90 분리는 후속)
 *   - 분당/수인분당: 약 35 km/h (코레일)
 *   - 경의중앙: 약 50 km/h (정차역 간격 넓음)
 *
 * 본 상수는 `getStopSeconds` fallback에서만 사용 — 1~8호선은 실측
 * `stationTravelTimes.json`(서울 열린데이터)을 우선 사용한다.
 *
 * #1472 — 거리 × 속도 기반 fallback 정밀화. 기존 120s/hop 고정 fallback 대체.
 */

import type { LineNumber } from '../types/station';

export const LINE_AVERAGE_SPEED_KMH: Record<LineNumber, number> = {
  '1': 32,
  '2': 32,
  '3': 32,
  '4': 32,
  '5': 32,
  '6': 32,
  '7': 32,
  '8': 32,
  '9': 40,
  airport: 60,
  bundang: 35,
  gyeongui: 50,
  sinbundang: 50,
};
