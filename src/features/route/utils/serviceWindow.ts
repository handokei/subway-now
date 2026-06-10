import type { LineNumber } from '../../../shared/types/station';
import line1Timetable from '../../../data/timetables/line-1.json';
import line2Timetable from '../../../data/timetables/line-2.json';
import line3Timetable from '../../../data/timetables/line-3.json';
import line4Timetable from '../../../data/timetables/line-4.json';
import line5Timetable from '../../../data/timetables/line-5.json';
import line6Timetable from '../../../data/timetables/line-6.json';
import line7Timetable from '../../../data/timetables/line-7.json';
import line8Timetable from '../../../data/timetables/line-8.json';
import line9Timetable from '../../../data/timetables/line-9.json';

/**
 * 운행 시간 외(첫차 전 / 막차 후) 안내용 util.
 *
 * - 1~9호선 정적 timetable JSON에서 (역, 요일)별 첫차/막차 시각을 읽어,
 *   현재 시각이 운행 시간 내인지 판정한다.
 * - timetable이 없는 노선(분당/신분당/경의중앙/공항)은 status='unknown'.
 * - dayType은 KST 기준 weekday/saturday/sunday로 자동 분류
 *   (#1043 lastTrainTime / scheduleFallback의 classifyDayType과 동일 관례).
 * - timetable의 익일 새벽 운행 entry는 "2436" 같은 24h+ 표기를 사용하며,
 *   본 util은 이를 firstTrain/lastTrain 표시 시 "00:36"으로 정규화하고,
 *   상태 판정 시에는 raw 분(>=1440)을 그대로 사용해 overnight tail을 in-service로 본다.
 *
 * UI 미연결 — banner 등 consumer는 별도 PR에서 wiring한다.
 *
 * NOTE(follow-up): lastTrainTime.ts(#1043)와 timetable 로딩/HHMM 정규화/dayType 분류 로직이
 * 겹친다. #1043 머지 후 공통 helper(예: src/features/.../utils/timetableShared.ts)로
 * 추출 검토.
 */

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type ServiceStatus = 'pre-first' | 'in-service' | 'post-last' | 'unknown';

export interface ServiceWindow {
  firstTrain: string | null;
  lastTrain: string | null;
  status: ServiceStatus;
}

interface DayDirectionTimetable {
  up: string[];
  down: string[];
}
interface StationTimetable {
  weekday: DayDirectionTimetable;
  saturday: DayDirectionTimetable;
  sunday: DayDirectionTimetable;
}
interface LineTimetable {
  stations: Record<string, StationTimetable>;
}

const TIMETABLES: Partial<Record<LineNumber, LineTimetable>> = {
  '1': line1Timetable,
  '2': line2Timetable,
  '3': line3Timetable,
  '4': line4Timetable,
  '5': line5Timetable,
  '6': line6Timetable,
  '7': line7Timetable,
  '8': line8Timetable,
  '9': line9Timetable,
};

const SUBWAY_TIMEZONE = 'Asia/Seoul';
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_HOUR = 60;
/** timetable JSON의 미운행 슬롯 표기 (앞쪽 padding). */
const NON_OPERATING_SLOT = '0000';

function classifyDayTypeKst(date: Date): DayType {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUBWAY_TIMEZONE,
    weekday: 'short',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')!.value;
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

/** Date → KST 기준 minutes-of-day (0~1439). */
function getKstMinutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUBWAY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  // hour12:false에서 자정은 '24'로 나올 수 있어 % 24로 정규화.
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')!.value, 10) % HOURS_PER_DAY;
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  return hour * MINUTES_PER_HOUR + minute;
}

/** "HHMM"(또는 익일 표기 "2436") → raw minutes (>=1440이면 overnight). */
function rawToMinutes(raw: string): number {
  const hour = Number.parseInt(raw.slice(0, 2), 10);
  const minute = Number.parseInt(raw.slice(2, 4), 10);
  return hour * MINUTES_PER_HOUR + minute;
}

/** raw minutes → "HH:mm" — 24h+ 표기는 % 1440으로 정규화. */
function formatMinutes(minutes: number): string {
  const normalized = minutes % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / MINUTES_PER_HOUR);
  const minute = normalized % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface Params {
  stationName: string;
  line: LineNumber;
  /** 미지정 시 now 기준 KST로 자동 분류. */
  dayType?: DayType;
  /** 미지정 시 new Date(). */
  now?: Date;
}

/**
 * 역 단위 service window 계산:
 * - firstTrain: up/down 합쳐 가장 빠른 실제 운행 entry(NON_OPERATING_SLOT 제외)
 * - lastTrain: up/down 합쳐 가장 늦은 entry (overnight raw 분 우선)
 */
function pickStationWindow(timetable: DayDirectionTimetable): {
  firstRaw: number | null;
  lastRaw: number | null;
} {
  const directions = [timetable.up, timetable.down];
  let firstRaw: number | null = null;
  let lastRaw: number | null = null;
  for (const entries of directions) {
    for (const entry of entries) {
      if (entry === NON_OPERATING_SLOT) continue;
      const minutes = rawToMinutes(entry);
      if (firstRaw === null || minutes < firstRaw) firstRaw = minutes;
      if (lastRaw === null || minutes > lastRaw) lastRaw = minutes;
    }
  }
  return { firstRaw, lastRaw };
}

export function getServiceWindow({
  stationName,
  line,
  dayType,
  now,
}: Params): ServiceWindow {
  const reference = now ?? new Date();
  const lineData = TIMETABLES[line];
  if (!lineData) {
    return { firstTrain: null, lastTrain: null, status: 'unknown' };
  }
  const station = lineData.stations[stationName];
  if (!station) {
    return { firstTrain: null, lastTrain: null, status: 'unknown' };
  }
  const resolvedDayType = dayType ?? classifyDayTypeKst(reference);
  const { firstRaw, lastRaw } = pickStationWindow(station[resolvedDayType]);
  if (firstRaw === null || lastRaw === null) {
    // 모든 슬롯이 NON_OPERATING_SLOT인 비정상 케이스 — 호출자가 fallback할 수 있게 unknown.
    return { firstTrain: null, lastTrain: null, status: 'unknown' };
  }

  const firstTrain = formatMinutes(firstRaw);
  const lastTrain = formatMinutes(lastRaw);
  const nowMinutes = getKstMinutesOfDay(reference);

  // 24h+ overnight 처리:
  // - lastRaw가 1440 이상이고 nowMinutes <= (lastRaw - 1440)이면 아직 어제 운행분의 끝자락(in-service).
  // - 그 윈도우를 지났는데 아직 nowMinutes < firstRaw이면 어제 막차는 끝났고 오늘 첫차 전 = post-last.
  if (lastRaw >= MINUTES_PER_DAY) {
    const overnightTailEnd = lastRaw - MINUTES_PER_DAY;
    if (nowMinutes <= overnightTailEnd) {
      return { firstTrain, lastTrain, status: 'in-service' };
    }
    if (nowMinutes < firstRaw) {
      return { firstTrain, lastTrain, status: 'post-last' };
    }
    return { firstTrain, lastTrain, status: 'in-service' };
  }

  // lastRaw < 1440 (당일 내 종료): 단순 [first, last] 윈도우.
  if (nowMinutes < firstRaw) {
    return { firstTrain, lastTrain, status: 'pre-first' };
  }
  if (nowMinutes > lastRaw) {
    return { firstTrain, lastTrain, status: 'post-last' };
  }
  return { firstTrain, lastTrain, status: 'in-service' };
}
