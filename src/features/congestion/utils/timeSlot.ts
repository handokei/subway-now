import type { CongestionDayType, CongestionTimeSlot } from '../../../shared/types/congestion';

/**
 * Date → 30분 단위 슬롯(`HH:mm`).
 * 분이 30 미만이면 `:00`, 그 이상이면 `:30`으로 절사 (floor).
 * 서울 OD가 30분 평균치를 제공하므로 floor 가 자연스러운 매칭이다.
 */
export function toTimeSlot(date: Date): CongestionTimeSlot {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = date.getMinutes() < 30 ? '00' : '30';
  return `${hh}:${mm}`;
}

/** Date → 평일/토/일 분류. JS `getDay()`: 0=일, 6=토, 1~5=평일. */
export function toDayType(date: Date): CongestionDayType {
  const day = date.getDay();
  if (day === 0) return 'sunday';
  if (day === 6) return 'saturday';
  return 'weekday';
}
