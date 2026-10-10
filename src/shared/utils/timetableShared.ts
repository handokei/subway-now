import type { LineNumber } from '../types/station';
import { getWeekdayShort } from './intlDateParts';
import line1Timetable from '../../data/timetables/line-1.json';
import line2Timetable from '../../data/timetables/line-2.json';
import line3Timetable from '../../data/timetables/line-3.json';
import line4Timetable from '../../data/timetables/line-4.json';
import line5Timetable from '../../data/timetables/line-5.json';
import line6Timetable from '../../data/timetables/line-6.json';
import line7Timetable from '../../data/timetables/line-7.json';
import line8Timetable from '../../data/timetables/line-8.json';
import line9Timetable from '../../data/timetables/line-9.json';

/**
 * 정적 timetable JSON(`src/data/timetables/line-{1..9}.json`)의 공통 lookup SSOT.
 *
 * 본 모듈을 신설한 배경 (#1480):
 * - `src/features/route/utils/serviceWindow.ts`(#1093)와
 *   `src/features/arrival/utils/lastTrainTime.ts`(#1043)가 같은 timetable JSON 로딩 +
 *   DayType KST 분류 + HHMM 정규화 로직을 각자 가지고 있어 drift 위험.
 * - boardable train ETA 알고리즘(#1480)에서도 동일 lookup이 필요해, 세 번째 복제 대신
 *   shared helper로 추출.
 *
 * **주의 — 본 PR은 신규 사용처만 본 helper를 채택.** 기존 serviceWindow.ts/lastTrainTime.ts
 * 마이그레이션은 별도 refactor 이슈로 분리 (디렉토리 경계 ESLint + 회귀 위험 별개로 검증).
 *
 * 데이터 전제 (`src/data/timetables/line-{1..9}.json`):
 * - station name을 키로 weekday/saturday/sunday × up/down 시각 배열.
 * - 시각은 "HHMM" 4자리. 익일 새벽 운행분은 "2436" 같은 24h+ 표기.
 * - "0000"은 미운행 슬롯 (선두 padding).
 *
 * 미지원 노선 (1~9호선 외 — 분당/신분당/경의중앙/공항/우이신설/김포골드/인천1·2/경춘/수인분당):
 * - timetable 부재 → 모든 lookup은 null 반환. 호출자가 정적 ETA fallback 결정.
 */

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Direction = 'up' | 'down';

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
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
/** timetable JSON의 미운행 슬롯 표기 (앞쪽 padding). */
const NON_OPERATING_SLOT = '0000';

/**
 * KST 기준 요일을 weekday/saturday/sunday로 분류.
 * Hermes/iOS의 weekday part 누락 회귀(#1088)는 null로 전파한다.
 */
export function classifyDayTypeKst(date: Date): DayType | null {
  const weekday = getWeekdayShort(date, SUBWAY_TIMEZONE);
  if (weekday === null) return null;
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

/**
 * 다음 DayType (overnight tail이 막차 후 → 다음 운행일 첫차로 넘어갈 때 사용).
 * weekday → 다음 평일(금요일 다음은 saturday, 토요일 다음은 sunday, 일요일 다음은 weekday).
 */
export function nextDayType(dayType: DayType): DayType {
  if (dayType === 'weekday') return 'saturday';
  if (dayType === 'saturday') return 'sunday';
  return 'weekday';
}

/**
 * "HHMM" → 분 (24h+ 표기는 1440 이상 반환). 파싱 실패 시 null.
 *
 * production timetable JSON은 length=4 + 숫자만으로 보장. length/NaN 가드는 데이터 회귀
 * (빌드 파이프라인 깨짐 / 외부 endpoint 응답 형식 변형)에 대비한 안전망. main module 인스턴스는
 * 실 timetable JSON으로 lookup하므로 본 두 분기는 main coverage 통계상 도달 불가.
 */
function rawToMinutes(raw: string): number | null {
  /* istanbul ignore if -- 데이터 회귀 안전망 (위 NOTE 참조). */
  if (raw.length !== 4) return null;
  const hour = Number.parseInt(raw.slice(0, 2), 10);
  const minute = Number.parseInt(raw.slice(2, 4), 10);
  /* istanbul ignore if -- 데이터 회귀 안전망 (위 NOTE 참조). */
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * MINUTES_PER_HOUR + minute;
}

/** 분 → "HH:mm" (24h+ 분은 % 1440으로 정규화 — 익일 새벽 표기). */
export function formatMinutesAsHHmm(minutes: number): string {
  const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / MINUTES_PER_HOUR);
  const minute = normalized % MINUTES_PER_HOUR;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Date → 정수 분 단위 KST minutes-of-day (0~1439). part 누락 시 null. */
function getKstMinutesOfDay(date: Date): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: SUBWAY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const minutePart = parts.find((p) => p.type === 'minute')?.value;
    /* istanbul ignore if -- classifyDayTypeKst이 같은 Date에서 weekday part를 추출했다면 hour/minute
       part도 함께 추출됨 (Intl 동일 구현, #1088). 본 분기는 안전망. */
    if (hourPart === undefined || minutePart === undefined) return null;
    const hour = Number.parseInt(hourPart, 10) % HOURS_PER_DAY;
    const minute = Number.parseInt(minutePart, 10);
    /* istanbul ignore if -- 위 hour/minute part가 hh/mm 두 자리 string으로 보장되므로 parseInt가 NaN을
       반환하는 경로는 도달 불가. 안전망. */
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return hour * MINUTES_PER_HOUR + minute;
  } catch {
    /* istanbul ignore next -- new Intl.DateTimeFormat은 timeZone='Asia/Seoul'/hour='2-digit' 같이
       유효한 option만 사용해 생성 시점에 throw하지 않고, formatToParts도 invalid Date에는 빈 parts를
       반환해(undefined 분기로 fall-through) try 본문에서 throw 발생 가능성은 사실상 0. Hermes/iOS
       버전별 회귀에 대비한 안전망. */
    return null;
  }
}

export interface DepartureLookupParams {
  stationName: string;
  line: LineNumber;
  direction: Direction;
  /** 기준 시각 — 이 시각 이후 (>=) 첫 발차를 boardable로 본다. */
  from: Date;
}

export interface BoardableDeparture {
  /** boardable 열차 출발 분 (KST raw minutes — 24h+ 가능). */
  departureMinutes: number;
  /** boardable 열차 출발 시각 표시용 ("HH:mm" — 24h+는 다음날 표기). */
  departureLabel: string;
  /** 기준 시각부터 이 열차 출발까지 대기 시간 (초). */
  waitSeconds: number;
  /** 기준 시각 이전에 출발해 사용자가 못 탄 열차 수 (현재 운행일 한정). */
  missedCount: number;
  /** boardable이 익일 첫차 fallback인 경우 true (막차 이후 trip 산출). */
  isNextDayFallback: boolean;
}

export type DepartureLookupResult =
  | { status: 'ok'; departure: BoardableDeparture }
  | { status: 'no-timetable' } // 1~9호선 외 노선
  | { status: 'station-missing' } // timetable에 station name 없음 (alias 불일치 등)
  | { status: 'day-type-unknown' } // Hermes weekday part 누락 (#1088)
  | { status: 'no-departures'}; // 모든 슬롯이 NON_OPERATING_SLOT

/**
 * `from` 시각 이후 (>=) 가장 빠른 boardable 열차를 lookup.
 *
 * - 막차 후 → 다음 운행일 첫차 fallback ({@link nextDayType}로 진행).
 * - 환승역 도착 시각 + 도보/플랫폼 buffer 같은 입력이 from에 들어간다고 가정.
 *
 * 시간 비교는 분 단위로 수행한다. 같은 분 (예: 12:30 도착, 12:30 발차)도 boardable로 본다
 * — 사용자가 lock 활성 시에도 정확히 같은 분을 허용하는 ADR-010 첫 줄 원칙과 동일하게,
 * 환승역에서도 같은 분을 miss로 정의하지 않는다.
 */
export function findBoardableDeparture(params: DepartureLookupParams): DepartureLookupResult {
  const { stationName, line, direction, from } = params;
  const lineData = TIMETABLES[line];
  if (!lineData) return { status: 'no-timetable' };

  const station = lineData.stations[stationName];
  if (!station) return { status: 'station-missing' };

  const dayType = classifyDayTypeKst(from);
  if (dayType === null) return { status: 'day-type-unknown' };

  const fromMinutes = getKstMinutesOfDay(from);
  /* istanbul ignore next -- classifyDayTypeKst이 weekday part를 성공적으로 추출했다면 동일 Date의 hour/minute
     part도 추출 가능 (Intl 동일 구현 — partial part 누락은 weekday에서만 관측됨, #1088). 본 분기는 안전망. */
  if (fromMinutes === null) return { status: 'day-type-unknown' };

  const result = scanForBoardable({
    station,
    dayType,
    direction,
    referenceMinutes: fromMinutes,
  });

  if (result === null) {
    // 현재 운행일에 boardable 없음 → 다음 운행일 첫차 fallback.
    return scanNextDayFirstDeparture({
      station,
      currentDayType: dayType,
      direction,
      referenceMinutes: fromMinutes,
    });
  }

  return { status: 'ok', departure: result };
}

interface ScanParams {
  station: StationTimetable;
  dayType: DayType;
  direction: Direction;
  /** KST minutes-of-day (0~1439). overnight tail은 raw-minutes(>=1440)와 비교. */
  referenceMinutes: number;
}

function scanForBoardable(params: ScanParams): BoardableDeparture | null {
  const { station, dayType, direction, referenceMinutes } = params;
  const entries = station[dayType][direction];

  let missedCount = 0;
  for (const entry of entries) {
    if (entry === NON_OPERATING_SLOT) continue;
    const minutes = rawToMinutes(entry);
    if (minutes === null) continue;
    if (minutes >= referenceMinutes) {
      const waitMinutes = minutes - referenceMinutes;
      return {
        departureMinutes: minutes,
        departureLabel: formatMinutesAsHHmm(minutes),
        waitSeconds: waitMinutes * MINUTES_PER_HOUR,
        missedCount,
        isNextDayFallback: false,
      };
    }
    missedCount += 1;
  }
  return null;
}

interface NextDayScanParams {
  station: StationTimetable;
  currentDayType: DayType;
  direction: Direction;
  /** 현재 운행일의 referenceMinutes (대기 시간 계산용 — 익일은 +1440). */
  referenceMinutes: number;
}

function scanNextDayFirstDeparture(params: NextDayScanParams): DepartureLookupResult {
  const { station, currentDayType, direction, referenceMinutes } = params;
  const upcomingDayType = nextDayType(currentDayType);
  const entries = station[upcomingDayType][direction];

  for (const entry of entries) {
    if (entry === NON_OPERATING_SLOT) continue;
    const minutes = rawToMinutes(entry);
    if (minutes === null) continue;
    // 익일 첫차의 raw minutes를 다음날(+1440)로 평행이동해 대기 시간 계산.
    const minutesAcrossDay = minutes + MINUTES_PER_DAY;
    return {
      status: 'ok',
      departure: {
        departureMinutes: minutes,
        departureLabel: formatMinutesAsHHmm(minutes),
        waitSeconds: (minutesAcrossDay - referenceMinutes) * MINUTES_PER_HOUR,
        missedCount: 0,
        isNextDayFallback: true,
      },
    };
  }
  return { status: 'no-departures' };
}

/** 테스트/디버그용 — 특정 노선/요일의 timetable이 존재하는지. */
export function hasTimetable(line: LineNumber): boolean {
  return TIMETABLES[line] !== undefined;
}
