import type { LineNumber } from '../types/station';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';
import headways from '../data/lineHeadways.json';
import terminals from '../data/lineTerminals.json';

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

/** 서울 지하철 운행시간 분류는 KST 고정. arrivalApi의 recptnDt 처리와 동일한 관례. */
const SUBWAY_TIMEZONE = 'Asia/Seoul';

interface KstParts {
  weekday: string;
  hour: number;
  minute: number;
}

function getKstParts(date: Date): KstParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUBWAY_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  // Intl.DateTimeFormat은 요청한 옵션에 해당하는 part를 반드시 반환하므로 non-null 단언.
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)!.value;
  // Safari가 자정에 'hour'를 '24'로 주는 경우를 % 24로 정규화.
  const hour = Number.parseInt(lookup('hour'), 10) % 24;
  const minute = Number.parseInt(lookup('minute'), 10);
  return { weekday: lookup('weekday'), hour, minute };
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
    trainCode: `SCHED-${suffix}`,
    receivedAtMs: nowMs,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
  };
}

export function buildScheduleArrival(line: LineNumber, now: Date): StationArrival {
  const dayType = classifyDayType(now);
  const period = classifyPeriod(now, dayType);
  const headway = lookupHeadwaySeconds(line, dayType, period);
  const nowMs = now.getTime();

  if (headway === null) {
    return { up: [], down: [], isMock: true, source: 'closed' };
  }

  // 다음 발차를 wall-clock 헤드웨이 격자에 정렬한다.
  // 폴링 사이클(5s)마다 같은 anchor를 산출해 ETA가 연속적으로 감소 (이슈 #468).
  // 정확히 격자 위(remainder=0)면 첫 차는 다음 격자(headway초 뒤)로 보내 0초 트레인 표시를 방지.
  // up 트레인은 up 방향(낮은 station id 쪽) 종착역으로, down 트레인은 그 반대.
  // 2호선은 순환선이라 물리 종착이 아닌 "내선순환/외선순환" 행선지를 사용한다.
  // 5호선 하남검단산 분기는 stations.json에 미포함이라 마천행만 표시 — 하남선 추가 시 함께 보강.
  // 신규 노선이 lineTerminals.json에 누락되면 destination=''로 graceful degrade.
  const terminal = TERMINALS[line];
  const upTerminal = terminal?.up ?? '';
  const downTerminal = terminal?.down ?? '';

  const headwayMs = headway * 1000;
  const remainder = nowMs % headwayMs;
  const msUntilFirst = remainder === 0 ? headwayMs : headwayMs - remainder;
  const first = Math.round(msUntilFirst / 1000);
  const second = first + headway;
  const up = [
    makeTrain(first, 'UP-1', nowMs, upTerminal),
    makeTrain(second, 'UP-2', nowMs, upTerminal),
  ];
  const down = [
    makeTrain(first, 'DN-1', nowMs, downTerminal),
    makeTrain(second, 'DN-2', nowMs, downTerminal),
  ];

  return { up, down, isMock: true, source: 'schedule' };
}
