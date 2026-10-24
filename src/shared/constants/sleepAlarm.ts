/**
 * #3100 — 취침 알람 "N역 전부터" 상수 (단일 출처).
 *
 * 행 수·검증 범위·칸 계산이 전부 이 파일에서 파생된다. 숫자 리터럴(1, 2, 3)은 여기에만 둔다 —
 * 최대치를 바꾸면(예: 4) UI 행 수, parse 범위, 칸 판정이 함께 따라간다. 이를 어기는 리터럴은
 * `sleepAlarmNoLiteral.test.ts` 가드가 CI에서 막고, 가드가 못 보는 의미 하드코딩은 MAX 변형
 * 테스트(최대치 mock)가 잡는다.
 */

/** 가장 임박한 칸 = 타깃 바로 앞 역(1역 전). 기본값. */
export const SLEEP_ALARM_MIN_STOPS_BEFORE = 1;

/** 선택 가능한 가장 이른 칸(N역 전의 N 최대치). */
export const SLEEP_ALARM_MAX_STOPS_BEFORE = 3;

/** advance 1회 = 정거장 1개 전진. */
export const ONE_STATION_STEP = 1;

/** leg의 출발역 위치 — `trip.waypoints`에는 출발역이 없어 첫 원소보다 하나 앞(-1)이다. */
export const LEG_START_INDEX = -1;

/** 발사 방식 — 매 역(N역 전부터 도착 직전까지 전부) / 선택한 역에서만(체크한 칸만). */
export const SLEEP_ALARM_MODES = ['every', 'selected'] as const;

export type SleepAlarmMode = (typeof SLEEP_ALARM_MODES)[number];

/** 저장·전송 형태. 기본값과 같은 설정은 필드를 두지 않는다(`normalizeSleepAlarmConfig`가 undefined). */
export interface SleepAlarmConfig {
  mode: SleepAlarmMode;
  /** 내림차순, 중복 없음. `every`는 시작 N 하나만 가진다. */
  stops: number[];
}
