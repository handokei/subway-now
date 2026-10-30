import type { LineNumber } from '../types/station';
import { getDateParts } from './intlDateParts';
import headways from '../../data/lineHeadways.json';

/**
 * 노선별 요일×시간대 배차간격 + KST 요일/시간대 분류의 SSoT.
 *
 * #1480 PR-C — `features/alarm/utils/scheduleFallback.ts`(시간표 fallback 도착정보)에 있던 것을
 * shared로 옮겼다. 여정 타임라인 엔진(shared)이 시간표 없는 노선·방향 미상 환승의 대기를
 * 배차간격/2로 추정하는 데 같은 분류·표를 써야 drift가 없다. scheduleFallback은 여기서 import한다.
 */

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Period = 'peak' | 'offPeak' | 'late' | 'closed';

interface DayHeadway {
  peak: number;
  offPeak: number;
  late: number;
}

type HeadwayTable = Record<LineNumber, Record<DayType, DayHeadway>>;

const HEADWAYS = headways as HeadwayTable;

/** 서울 지하철 운행시간 분류는 KST 고정. arrivalApi의 recptnDt 처리와 동일한 관례. */
const SUBWAY_TIMEZONE = 'Asia/Seoul';

export interface KstParts {
  weekday: string;
  hour: number;
  minute: number;
  second: number;
}

export function getKstParts(date: Date): KstParts | null {
  // Hermes/iOS에서 weekday part가 누락되는 회귀(#1088). 안전 helper로 nullable 추출 후,
  // 필수 part 중 하나라도 누락되면 null로 위로 전파해 호출자가 헤드웨이 fallback으로 graceful degrade.
  const parts = getDateParts(
    date,
    {
      timeZone: SUBWAY_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    },
    ['weekday', 'hour', 'minute', 'second'],
  );
  if (
    parts.weekday === undefined ||
    parts.hour === undefined ||
    parts.minute === undefined ||
    parts.second === undefined
  ) {
    return null;
  }
  // Safari가 자정에 'hour'를 '24'로 주는 경우를 % 24로 정규화.
  const hour = Number.parseInt(parts.hour, 10) % 24;
  const minute = Number.parseInt(parts.minute, 10);
  const second = Number.parseInt(parts.second, 10);
  return { weekday: parts.weekday, hour, minute, second };
}

export function classifyDayType(date: Date): DayType {
  const parts = getKstParts(date);
  // weekday part 누락 시 보수적으로 weekday (가장 흔한 케이스, 헤드웨이 적용 가능).
  if (parts === null) return 'weekday';
  const { weekday } = parts;
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

export function classifyPeriod(date: Date, dayType: DayType): Period {
  const parts = getKstParts(date);
  // 시간 part 누락 시 가장 흔한 offPeak으로 보수 처리.
  if (parts === null) return 'offPeak';
  const { hour, minute } = parts;
  const minutes = hour * 60 + minute;
  // closed: 01:00 ~ 05:30
  if (minutes >= 60 && minutes < 330) return 'closed';
  // late: 22:00 ~ 24:00 + 00:00 ~ 01:00
  if (minutes >= 22 * 60 || minutes < 60) return 'late';
  // weekday peak: 07:00 ~ 09:30, 18:00 ~ 20:00
  if (dayType === 'weekday') {
    const inMorningPeak = minutes >= 7 * 60 && minutes < 9 * 60 + 30;
    const inEveningPeak = minutes >= 18 * 60 && minutes < 20 * 60;
    if (inMorningPeak || inEveningPeak) return 'peak';
  }
  return 'offPeak';
}

export function lookupHeadwaySeconds(line: LineNumber, dayType: DayType, period: Period): number | null {
  if (period === 'closed') return null;
  const value = HEADWAYS[line]?.[dayType]?.[period];
  return Number.isFinite(value) ? value : null;
}
