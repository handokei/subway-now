/**
 * #3100 — 취침 알람 "N역 전부터" 칸 순수 함수 (백엔드·기기 공용).
 *
 * "남은 정거장 수(remaining)" = 타깃(환승/하차역)까지 같은 leg 안에서 몇 정거장 남았는가. 기본 칸(1역 전)은
 * `SLEEP_ALARM_MIN_STOPS_BEFORE`. 이 파일에는 숫자 리터럴을 두지 않는다 — 전부 `constants/sleepAlarm.ts`
 * 에서 파생되며, 가드 테스트(`sleepAlarmNoLiteral.test.ts`)가 [1-9] 리터럴을 CI에서 막는다.
 */
import {
  ONE_STATION_STEP,
  SLEEP_ALARM_MAX_STOPS_BEFORE,
  SLEEP_ALARM_MIN_STOPS_BEFORE,
  SLEEP_ALARM_MODES,
  type SleepAlarmConfig,
  type SleepAlarmMode,
} from '../constants/sleepAlarm';

/**
 * 한 번의 전진/소비가 지나간 남은-정거장 범위 — `toRemaining <= N < fromRemaining`인 칸 N이 걸쳤다.
 * cron 1칸 전진은 `{ fromRemaining: to + 1, toRemaining: to }`(= `crossingForSingleAdvance`).
 */
export interface SleepAlarmCrossing {
  fromRemaining: number;
  toRemaining: number;
}

/** UI 행 / 검증 범위: `[max .. MIN]` (내림차순). 행 수 = max - MIN + 1. */
export function sleepAlarmStopOptions(max: number = SLEEP_ALARM_MAX_STOPS_BEFORE): number[] {
  return Array.from({ length: max - SLEEP_ALARM_MIN_STOPS_BEFORE + ONE_STATION_STEP }, (_, index) => max - index);
}

/**
 * 설정을 발사할 칸 목록으로 전개한다. 설정 없음 = 기본 `[MIN]`, 선택 = 체크한 칸, 매 역 = 시작 N부터 MIN까지 전부.
 * 반환은 내림차순.
 */
export function expandSleepAlarmStops(config: SleepAlarmConfig | undefined): number[] {
  if (config === undefined) return [SLEEP_ALARM_MIN_STOPS_BEFORE];
  if (config.mode === 'every') {
    const start = Math.max(SLEEP_ALARM_MIN_STOPS_BEFORE, ...config.stops);
    return sleepAlarmStopOptions(start);
  }
  return [...config.stops];
}

function isSleepAlarmMode(value: unknown): value is SleepAlarmMode {
  return (SLEEP_ALARM_MODES as readonly unknown[]).includes(value);
}

/**
 * 외부 입력(register body / 저장값)을 정리한다.
 *  - 범위 `[MIN, max]` 밖 / 비정수 / 중복 원소를 걸러내고 내림차순 정렬, `every`는 시작 N 하나만 유지.
 *  - 쓸 수 있는 원소가 없거나 mode가 틀리면 `undefined`.
 *  - **기본값과 같은 설정은 `undefined`** — "기본값 = 필드 없음"이라 기본 사용자의 payload·hash가 바이트 동일하다.
 */
export function normalizeSleepAlarmConfig(
  raw: unknown,
  max: number = SLEEP_ALARM_MAX_STOPS_BEFORE,
): SleepAlarmConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { mode, stops } = raw as { mode?: unknown; stops?: unknown };
  if (!isSleepAlarmMode(mode) || !Array.isArray(stops)) return undefined;
  const valid = [
    ...new Set(
      stops.filter(
        (stop): stop is number =>
          typeof stop === 'number' && Number.isInteger(stop) && stop >= SLEEP_ALARM_MIN_STOPS_BEFORE && stop <= max,
      ),
    ),
  ].sort((a, b) => b - a);
  if (valid.length === 0) return undefined;
  const normalized: SleepAlarmConfig = { mode, stops: mode === 'every' ? [valid[0]] : valid };
  const [only, ...rest] = expandSleepAlarmStops(normalized);
  const isDefault = rest.length === 0 && only === SLEEP_ALARM_MIN_STOPS_BEFORE;
  return isDefault ? undefined : normalized;
}

/**
 * 전진이 지나간 범위에 설정한 칸이 걸쳤으면 **실제 남은 수(`toRemaining`)** 하나를 돌려준다(없으면 undefined).
 * 점프로 여러 칸을 건너뛰어도 1회(catch-up)이고, 문구는 실제 남은 수를 쓴다.
 */
export function selectSleepAlarmFire(
  stops: readonly number[],
  { fromRemaining, toRemaining }: SleepAlarmCrossing,
): number | undefined {
  return stops.some((stop) => toRemaining <= stop && stop < fromRemaining) ? toRemaining : undefined;
}

/** cron 1칸 전진: 방금 `toRemaining`에 도달 — 직전 위치는 한 정거장 더 멀었다. */
export function crossingForSingleAdvance(toRemaining: number): SleepAlarmCrossing {
  return { fromRemaining: toRemaining + ONE_STATION_STEP, toRemaining };
}

/** dedup 키 / collapse-id 접미사 조각. 기본 칸(MIN)은 빈 문자열 — 기존 키·id가 바이트 그대로다. */
export function sleepAlarmSuffix(remaining: number): string {
  return remaining === SLEEP_ALARM_MIN_STOPS_BEFORE ? '' : `s${remaining}`;
}
