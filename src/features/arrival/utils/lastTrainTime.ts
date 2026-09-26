import type { LineNumber } from '../../../shared/types/station';
import { getWeekdayShort } from '../../../shared/utils/intlDateParts';
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
 * 1~9호선 정적 timetable JSON의 마지막 entry에서 막차 발차 시각을 읽어 "HH:mm" 형식으로 반환한다.
 *
 * - 분당/신분당/경의중앙/공항 등 timetable이 없는 노선은 null을 반환해 호출자가 기존 "막차" 라벨로 fallback한다.
 * - dayType은 KST 기준 weekday/saturday/sunday로 자동 분류 (scheduleFallback의 classifyDayType과 동일 관례).
 * - timetable의 익일 새벽 운행 entry는 "2436" 같은 24h+ 표기를 사용하며, 본 함수는 이를 "00:36"으로 정규화해 반환한다.
 */

type DayType = 'weekday' | 'saturday' | 'sunday';
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

function classifyDayTypeKst(date: Date): DayType | null {
  // Hermes/iOS에서 weekday part가 누락되는 회귀(#1088)를 안전 helper로 흡수한다.
  // 누락 시 null을 그대로 위로 전파해 호출자가 막차 시각 미표시로 fallback한다.
  const weekday = getWeekdayShort(date, SUBWAY_TIMEZONE);
  if (weekday === null) return null;
  if (weekday === 'Sun') return 'sunday';
  if (weekday === 'Sat') return 'saturday';
  return 'weekday';
}

/** "HHMM"(또는 익일 표기 "2436") → "HH:mm" — 24h+ 표기는 % 24로 정규화. */
function formatHHmm(raw: string): string {
  // timetable JSON은 항상 4자리 "HHMM" 형식 (24h+ 새벽 운행분 포함)을 전제한다.
  // 데이터 정합성은 빌드 파이프라인에서 보장한다고 가정하고, 본 함수는 정규화만 담당.
  const hourRaw = Number.parseInt(raw.slice(0, 2), 10);
  const minute = Number.parseInt(raw.slice(2, 4), 10);
  const hour = hourRaw % HOURS_PER_DAY;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface Params {
  stationName: string;
  line: LineNumber;
  direction: Direction;
  now: Date;
}

export function getLastTrainTime({ stationName, line, direction, now }: Params): string | null {
  const lineData = TIMETABLES[line];
  if (!lineData) return null;
  const station = lineData.stations[stationName];
  if (!station) return null;
  const dayType = classifyDayTypeKst(now);
  if (dayType === null) return null;
  const times = station[dayType][direction];
  // timetable JSON은 시간순 정렬 + 모든 요일/방향에 entry 보유를 전제로 한다
  // (scheduleFallback과 동일 전제). "0000" 같은 미운행 슬롯이 앞쪽에 있어도
  // 마지막 entry는 실제 마지막 발차 시각.
  const last = times[times.length - 1];
  return formatHHmm(last);
}
