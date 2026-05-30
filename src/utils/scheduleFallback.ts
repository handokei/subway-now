import type { LineNumber } from '../types/station';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';
import headways from '../data/lineHeadways.json';
import terminals from '../data/lineTerminals.json';
import line1Timetable from '../data/timetables/line-1.json';
import line2Timetable from '../data/timetables/line-2.json';
import line3Timetable from '../data/timetables/line-3.json';
import line4Timetable from '../data/timetables/line-4.json';
import line5Timetable from '../data/timetables/line-5.json';
import line6Timetable from '../data/timetables/line-6.json';
import line7Timetable from '../data/timetables/line-7.json';
import line8Timetable from '../data/timetables/line-8.json';
import line9Timetable from '../data/timetables/line-9.json';

export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Period = 'peak' | 'offPeak' | 'late' | 'closed';

interface DayHeadway {
  peak: number;
  offPeak: number;
  late: number;
}

type HeadwayTable = Record<LineNumber, Record<DayType, DayHeadway>>;

interface LineTerminal {
  up: string;
  down: string;
}

type TerminalTable = Record<LineNumber, LineTerminal>;

const HEADWAYS = headways as HeadwayTable;
const TERMINALS = terminals as TerminalTable;

// Phase 3 (#473): 1~9호선 시간표 데이터.
interface DayDirectionTimetable {
  up?: string[];
  down?: string[];
}
interface StationTimetable {
  weekday?: DayDirectionTimetable;
  saturday?: DayDirectionTimetable;
  sunday?: DayDirectionTimetable;
}
interface LineTimetable {
  stations: Record<string, StationTimetable>;
}

// LineNumber에 시간표 데이터가 매핑된 노선만. 분당/신분당/경의중앙/공항은 다른 API 사용.
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

/** 서울 지하철 운행시간 분류는 KST 고정. arrivalApi의 recptnDt 처리와 동일한 관례. */
const SUBWAY_TIMEZONE = 'Asia/Seoul';

interface KstParts {
  weekday: string;
  hour: number;
  minute: number;
  second: number;
}

function getKstParts(date: Date): KstParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUBWAY_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  // Intl.DateTimeFormat은 요청한 옵션에 해당하는 part를 반드시 반환하므로 non-null 단언.
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)!.value;
  // Safari가 자정에 'hour'를 '24'로 주는 경우를 % 24로 정규화.
  const hour = Number.parseInt(lookup('hour'), 10) % 24;
  const minute = Number.parseInt(lookup('minute'), 10);
  const second = Number.parseInt(lookup('second'), 10);
  return { weekday: lookup('weekday'), hour, minute, second };
}

export function classifyDayType(date: Date): DayType {
  const { weekday } = getKstParts(date);
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

export function classifyPeriod(date: Date, dayType: DayType): Period {
  const { hour, minute } = getKstParts(date);
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

/** LineNumber 확장 시 lineHeadways.json에 키 누락 가능 — 무결성 정적 검증용. */
export function hasHeadwayData(line: LineNumber): boolean {
  return Number.isFinite(HEADWAYS[line]?.weekday?.offPeak);
}

/** LineNumber 확장 시 lineTerminals.json에 키 누락 가능 — 무결성 정적 검증용. */
export function hasTerminalData(line: LineNumber): boolean {
  const terminal = TERMINALS[line];
  return Boolean(terminal?.up && terminal?.down);
}

function lookupHeadwaySeconds(line: LineNumber, dayType: DayType, period: Period): number | null {
  if (period === 'closed') return null;
  const value = HEADWAYS[line]?.[dayType]?.[period];
  return Number.isFinite(value) ? value : null;
}

/**
 * 시간표 fallback이 생성한 가상 trainCode prefix. 실시간 API가 빈약한 시간대에 사용되며,
 * BoardingTrainList 등 UI에서 사용자에게 노출하지 않기 위한 식별자(#648).
 */
export const SCHEDULE_FALLBACK_TRAIN_CODE_PREFIX = 'SCHED-';

/** trainCode가 시간표 fallback에서 만들어진 가상 코드인지 판별(#648). */
export function isScheduleFallbackTrainCode(trainCode: string): boolean {
  return trainCode.startsWith(SCHEDULE_FALLBACK_TRAIN_CODE_PREFIX);
}

function makeTrain(
  secondsFromNow: number,
  suffix: string,
  nowMs: number,
  destination: string,
): ArrivalInfo {
  return {
    destination,
    arrivalMinutes: Math.max(0, Math.floor(secondsFromNow / 60)),
    arrivalSeconds: secondsFromNow,
    statusMessage: '',
    trainCode: `${SCHEDULE_FALLBACK_TRAIN_CODE_PREFIX}${suffix}`,
    receivedAtMs: nowMs,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
  };
}

/** 시간표 lookup 결과의 다음 2편 도착 시각(초 단위 future offset)을 반환. */
interface TimetableHit {
  upSeconds: number[];
  downSeconds: number[];
}

/**
 * 현재 시각을 시간표 비교용 "HHMM" 키로 변환. 새벽 0~5시는 전 영업일의 24h+ 표기
 * (예: "0030" → "2430")로 환산해 시간표의 익일 새벽 운행 엔트리("2421" 등)와 매칭한다.
 */
function nowToTimetableKey(nowKstHour: number, nowKstMinute: number): string {
  const adjustedHour = nowKstHour < 5 ? nowKstHour + 24 : nowKstHour;
  return `${String(adjustedHour).padStart(2, '0')}${String(nowKstMinute).padStart(2, '0')}`;
}

/** HHMM 시각 → KST nowDate 기준 future seconds. 24h+ 표기는 그대로 24h+로 해석. */
function hhmmToFutureSeconds(targetHHMM: string, nowKstHour: number, nowKstMinute: number, nowKstSecond: number): number {
  const targetHour = Number.parseInt(targetHHMM.slice(0, 2), 10);
  const targetMin = Number.parseInt(targetHHMM.slice(2, 4), 10);
  // KST hour < 5면 현재 시각을 24h+로 환산해 24h+ 시간표 엔트리와 정확히 비교.
  const adjustedNowHour = nowKstHour < 5 ? nowKstHour + 24 : nowKstHour;
  const targetSec = targetHour * 3600 + targetMin * 60;
  const nowSec = adjustedNowHour * 3600 + nowKstMinute * 60 + nowKstSecond;
  return Math.max(0, targetSec - nowSec);
}

function lookupTimetable(
  line: LineNumber,
  stationName: string,
  dayType: DayType,
  kstWeekday: string,
  nowKstHour: number,
  nowKstMinute: number,
  nowKstSecond: number,
): TimetableHit | null {
  const lineData = TIMETABLES[line];
  if (!lineData) return null;
  const station = lineData.stations[stationName];
  if (!station) return null;
  // KST 0~5시는 전 영업일 dayType으로 shift (예: Mon 04:00은 Sun 영업일 운행분).
  // 실제 요일 기준으로 결정: Mon→Sun, Sat→Fri(weekday), Sun→Sat, Tue~Fri→이전 weekday.
  const previousBusinessDay = (wd: string): DayType => {
    if (wd === 'Sun') return 'saturday';
    if (wd === 'Mon') return 'sunday';
    return 'weekday';
  };
  const effectiveDay: DayType = nowKstHour < 5 ? previousBusinessDay(kstWeekday) : dayType;
  const day = station[effectiveDay];
  if (!day) return null;
  const nowKey = nowToTimetableKey(nowKstHour, nowKstMinute);
  const pickNext = (times: string[] | undefined): number[] => {
    if (!times || times.length === 0) return [];
    // "0000" 등 미운행 슬롯은 정렬상 배열 앞부분에 위치 — nowKey가 최소 "0500"(또는
    // 새벽 "2400"+)이라 문자열 비교에서 자동 스킵된다. 별도 필터 불필요.
    const idx = times.findIndex((t) => t >= nowKey);
    if (idx === -1) return [];
    // ETA 0인 트레인(현재 분 정확히 일치)은 출력에서 제외 — UI가 "0분"으로 최대 60초 노출되는
    // 회귀(헤드웨이 경로의 격자 시프트 가드와 동일 의도). 두 번째 트레인까지 슬라이스 후 필터.
    return times
      .slice(idx, idx + 3)
      .map((t) => hhmmToFutureSeconds(t, nowKstHour, nowKstMinute, nowKstSecond))
      .filter((sec) => sec > 0)
      .slice(0, 2);
  };
  // 종착역은 한쪽 방향만 운행하는 단방향 케이스가 있다 (예: 1호선 인천, 3호선 대화). 이 경우
  // 한 방향만 빈 배열로 반환되어도 timetable hit으로 처리 (isMock=false 유지).
  const upSeconds = pickNext(day.up);
  const downSeconds = pickNext(day.down);
  if (upSeconds.length === 0 && downSeconds.length === 0) return null;
  return { upSeconds, downSeconds };
}

export function buildScheduleArrival(
  line: LineNumber,
  stationName: string,
  now: Date,
): StationArrival {
  const dayType = classifyDayType(now);
  const nowMs = now.getTime();
  const terminal = TERMINALS[line];
  const upTerminal = terminal?.up ?? '';
  const downTerminal = terminal?.down ?? '';

  // Phase 3 (#473): 시간표 lookup이 가능한 노선/역이면 실제 시간표 기반 ETA를 우선 반환.
  // 시간표 적중 시 isMock=false, source='schedule' 유지 (Phase 4에서 'timetable' 신규 source 검토).
  const { hour: kstHour, minute: kstMinute, second: kstSecond, weekday: kstWeekday } = getKstParts(now);
  const timetableHit = lookupTimetable(line, stationName, dayType, kstWeekday, kstHour, kstMinute, kstSecond);
  if (timetableHit) {
    const up = timetableHit.upSeconds.map((sec, i) => makeTrain(sec, `UP-${i + 1}`, nowMs, upTerminal));
    const down = timetableHit.downSeconds.map((sec, i) =>
      makeTrain(sec, `DN-${i + 1}`, nowMs, downTerminal),
    );
    return { up, down, isMock: false, source: 'schedule' };
  }

  // 시간표 없는 노선(분당/신분당/경의중앙/공항) 또는 시간표에 누락된 역 → 헤드웨이 폴백.
  // 다음 발차를 wall-clock 헤드웨이 격자에 정렬한다.
  // 폴링 사이클(5s)마다 같은 anchor를 산출해 ETA가 연속적으로 감소 (이슈 #468).
  // 정확히 격자 위(remainder=0)면 첫 차는 다음 격자(headway초 뒤)로 보내 0초 트레인 표시를 방지.
  // up 트레인은 up 방향(낮은 station id 쪽) 종착역으로, down 트레인은 그 반대.
  // 2호선은 순환선이라 물리 종착이 아닌 "내선순환/외선순환" 행선지를 사용한다.
  // 신규 노선이 lineTerminals.json에 누락되면 destination=''로 graceful degrade.
  const period = classifyPeriod(now, dayType);
  const headway = lookupHeadwaySeconds(line, dayType, period);

  if (headway === null) {
    return { up: [], down: [], isMock: true, source: 'closed' };
  }

  const headwayMs = headway * 1000;
  const nextDepartureSeconds = (anchorMs: number): number => {
    const remainder = anchorMs % headwayMs;
    const msUntilFirst = remainder === 0 ? headwayMs : headwayMs - remainder;
    return Math.round(msUntilFirst / 1000);
  };
  const upFirst = nextDepartureSeconds(nowMs);
  // #517: up과 down이 동일 격자에 정렬돼 같은 ETA로 표시되는 회귀를 막기 위해
  // down 방향은 half-headway 만큼 위상을 어긋나게 한다. 실제 운영도 양방향이
  // 정확히 동기화되어 있지 않으며, 디버그 시 dir 분기 검증을 가능하게 한다.
  const downFirst = nextDepartureSeconds(nowMs + Math.floor(headwayMs / 2));
  const up = [
    makeTrain(upFirst, 'UP-1', nowMs, upTerminal),
    makeTrain(upFirst + headway, 'UP-2', nowMs, upTerminal),
  ];
  const down = [
    makeTrain(downFirst, 'DN-1', nowMs, downTerminal),
    makeTrain(downFirst + headway, 'DN-2', nowMs, downTerminal),
  ];

  return { up, down, isMock: true, source: 'schedule' };
}
