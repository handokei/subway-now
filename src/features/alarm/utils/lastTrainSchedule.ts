import lastTrainsData from '../../../data/lastTrains.json';
import type { LineNumber } from '../../../shared/types/station';
import { getWeekdayShort } from '../../../shared/utils/intlDateParts';

/**
 * #474 — `src/data/lastTrains.json` runtime lookup.
 *
 * SSOT: ETL (`scripts/fetch-last-train.js` or `scripts/seed-last-trains-from-first-last.js`).
 * 형식:
 *   {
 *     version: "1",
 *     lines: { "<LineNumber>": "covered" | "uncovered" },
 *     stations: { "<stationsJsonId>": { [dayType]: { up?: "HH:MM" | null, down?: "HH:MM" | null } } }
 *   }
 *
 * 본 모듈은 호선/방향/요일을 모두 데이터 주도로 처리한다 — 노선 이름이나 dayType을 직접 분기하지 않는다.
 */

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Direction = 'up' | 'down';

interface LastTrainsDataset {
  version: string;
  lines: Record<string, 'covered' | 'uncovered'>;
  stations: Record<string, Partial<Record<DayType, Partial<Record<Direction, string | null>>>>>;
}

const dataset = lastTrainsData as LastTrainsDataset;

const SUBWAY_TIMEZONE = 'Asia/Seoul';
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;
/** "0~3시"를 익일로 간주하는 cutoff. 막차가 자정을 넘기는 표준 표기 정규화. */
const NEXT_DAY_HOUR_CUTOFF = 4;

/** Intl 기반 KST 요일 약자 → dayType 매핑. weekday part 누락 회귀(#1088)는 null 전파. */
export function classifyDayTypeKst(date: Date): DayType | null {
  const weekday = getWeekdayShort(date, SUBWAY_TIMEZONE);
  if (weekday === null) return null;
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

/** 노선이 lastTrains.json 데이터셋에 포함돼 있는지. uncovered면 호출자가 알람 graceful skip. */
export function isLineCovered(line: LineNumber): boolean {
  return dataset.lines[line] === 'covered';
}

export interface LastTrainQuery {
  stationsJsonId: string;
  dayType: DayType;
  direction: Direction;
}

/** "HH:MM" 막차 시각. 미운행/미지원 노선/데이터 부재 → null. */
export function getLastTrainTime({ stationsJsonId, dayType, direction }: LastTrainQuery): string | null {
  const station = dataset.stations[stationsJsonId];
  if (!station) return null;
  const day = station[dayType];
  if (!day) return null;
  const value = day[direction];
  return value ?? null;
}

/** KST 기준 HH:MM 시각 추출. weekday helper와 동일하게 Intl 의존 안전 fallback. */
function getKstHourMinute(date: Date): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SUBWAY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour');
    const minutePart = parts.find((p) => p.type === 'minute');
    if (!hourPart || !minutePart) return null;
    // 자정을 "24"로 반환하는 Intl 구현 호환: HOURS_PER_DAY로 mod해 0~23 범위에 매핑.
    const hour = Number.parseInt(hourPart.value, 10) % HOURS_PER_DAY;
    const minute = Number.parseInt(minutePart.value, 10);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}

/** "HH:MM" → 0~24*60 분. 형식 불일치 → null. RegExp가 `\d{2}`만 통과시키므로 NaN 분기는 불필요. */
function parseHHmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  if (hour >= HOURS_PER_DAY || minute >= MINUTES_PER_HOUR) return null;
  return hour * MINUTES_PER_HOUR + minute;
}

export interface MinutesUntilLastTrainInput {
  lastTrainTime: string;
  now: Date;
}

/**
 * 현재 시각(KST) → "HH:MM" 막차까지 남은 분.
 *
 * - 막차 시각이 0~3시(NEXT_DAY_HOUR_CUTOFF 미만)이면 익일 운행분으로 간주(+24h).
 * - 그래도 음수가 나오면 (이미 지난 막차) 음수 그대로 반환 — 호출자가 임계값 체크에서 자연스럽게 skip.
 * - 시각 parse / KST 추출 실패 → null.
 */
export function minutesUntilLastTrain({
  lastTrainTime,
  now,
}: MinutesUntilLastTrainInput): number | null {
  const target = parseHHmmToMinutes(lastTrainTime);
  if (target === null) return null;
  const nowParts = getKstHourMinute(now);
  if (nowParts === null) return null;
  const nowMinutes = nowParts.hour * MINUTES_PER_HOUR + nowParts.minute;
  // 막차 시각이 새벽(0~3시)이면 익일 발차 — 현재 시각이 23시여도 자연스럽게 다음 날로 비교.
  const targetWrapped =
    target < NEXT_DAY_HOUR_CUTOFF * MINUTES_PER_HOUR ? target + MINUTES_PER_DAY : target;
  const nowWrapped =
    nowParts.hour < NEXT_DAY_HOUR_CUTOFF ? nowMinutes + MINUTES_PER_DAY : nowMinutes;
  return targetWrapped - nowWrapped;
}

/** 1회 발화 dedup용 일별 키. YYYYMMDD KST. */
export function todayKstKey(date: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SUBWAY_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    if (!year || !month || !day) return '';
    return `${year}${month}${day}`;
  } catch {
    return '';
  }
}
