/**
 * 시간대×역×방향 평균 혼잡도 타입.
 *
 * 데이터 출처: 서울교통공사 지하철혼잡도정보 (서울 열린데이터 OA-12928).
 * 30분 단위 요일/시간대 평균 혼잡도(%). 100 ≈ 좌석 모두 사용 + 손잡이 채움.
 *
 * 이슈 #1097 P0-A PoC.
 */

import type { LineNumber } from './station';

/** 진행 방향. 서울 OD `INNER_OUTER`/`UPDN_LINE` → 'up'(상행/외선) / 'down'(하행/내선). */
export type CongestionDirection = 'up' | 'down';

/**
 * 혼잡도 단계 — 서울교통공사 공식 기준.
 * - low: ~80% (여유, 좌석 여유 있음)
 * - medium: 80~130% (보통, 손잡이까지 사용)
 * - high: 130~150% (혼잡, 가까이 밀착)
 * - veryHigh: 150% 이상 (매우 혼잡)
 *
 * 임계값은 `congestionLevel.ts`의 상수로 분리한다.
 */
export type CongestionLevel = 'low' | 'medium' | 'high' | 'veryHigh';

/** 30분 단위 시간대 키. `HH:mm` 형식, mm은 `00` 또는 `30`. 예: '05:30', '08:00', '23:30'. */
export type CongestionTimeSlot = string;

/** 요일 구분 — 서울 OD `WEEK_TAG`: 1=평일, 2=토요일, 3=일/공휴일. */
export type CongestionDayType = 'weekday' | 'saturday' | 'sunday';

export interface CongestionEntry {
  line: LineNumber;
  stationName: string;
  direction: CongestionDirection;
  dayType: CongestionDayType;
  timeSlot: CongestionTimeSlot;
  level: CongestionLevel;
  /** 원본 평균 혼잡도(%) — 0~200 추정. UI에서 단계 표시 외 미세 정렬용. */
  raw: number;
}
