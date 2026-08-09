/**
 * Cross-boundary push 계약 SSoT (ADR-029 Phase 0 / #2235).
 *
 * backend(Cloudflare Worker, `backend/alarm-worker`)와 device(RN, `src/`)는 untyped JSON push
 * payload로 통신한다. 두 런타임이 별도 빌드라 discriminator(kind/type/targetKind) union이 여러
 * 벌 복제·드리프트되던 문제(2026-08-09 dump RCA)를 이 모듈 하나로 통합한다.
 *
 * - 모든 discriminator를 `as const` 배열 + 파생 union type으로 정의(SSoT).
 * - backend/device 양쪽 소비 지점은 이 모듈을 import하고, exhaustive `switch` + `assertNever`로
 *   소비해 새 discriminator 추가 시 컴파일 에러가 나도록 한다.
 * - 순수 타입/상수 모듈 — 런타임 동작을 갖지 않는다(assertNever 예외 throw 제외).
 *
 * 원천 정의는 이 파일 하나. backend/device 각 벌 union을 "SSoT를 re-export"로 남기는 것은
 * 허용되지만(호출부 광범위 변경 최소화), 값의 집합 자체는 여기서만 바뀐다.
 */

/**
 * station waypoint 종류. backend `Waypoint.kind` / silent push payload `kind` 필드의 원천.
 * - 'transfer' — 환승 안내
 * - 'destination' — 최종 도착
 * - 'intermediate' — 중간역 통과
 */
export const STATION_WAYPOINT_KINDS = ['transfer', 'destination', 'intermediate'] as const;
export type StationWaypointKind = (typeof STATION_WAYPOINT_KINDS)[number];

/**
 * standard station push와 별개로 존재하는 "제어용" silent/alert push discriminator.
 * 각 값은 서로 다른 payload schema를 가진 별도 채널이다(backend `apns.ts` sender 함수 1:1).
 */
export const CONTROL_PUSH_KINDS = [
  'reschedule',
  'trip-ended',
  'boarding-prompt',
  'sleep-alarm-companion',
] as const;
export type ControlPushKind = (typeof CONTROL_PUSH_KINDS)[number];

/**
 * alarm-event ring buffer(`TripPositionSSoT.alarmEvents`) 항목의 `type`. backend `apns.ts`
 * `AlarmEventPayload.type` / device `backendSsotMirror`의 alarmEvents entry와 1:1.
 */
export const ALARM_EVENT_TYPES = ['station-passed', 'transfer', 'destination', 'imminent'] as const;
export type AlarmEventType = (typeof ALARM_EVENT_TYPES)[number];

/**
 * 취침 알람 companion push의 `targetKind` — 알람 대상이 환승역인지 도착역인지.
 * station waypoint kind의 부분집합(intermediate 제외 — companion은 임박 도착/환승만 대상).
 */
export const SLEEP_ALARM_TARGET_KINDS = ['transfer', 'destination'] as const;
export type SleepAlarmTargetKind = (typeof SLEEP_ALARM_TARGET_KINDS)[number];

/**
 * exhaustive switch용 헬퍼. 모든 case를 처리한 뒤 남은 타입이 `never`가 아니면 컴파일 에러가 난다
 * (drift = 빌드 실패). 런타임에 도달하면 SSoT에 없는 미지 discriminator를 만난 것 — 개발 중
 * 새 discriminator를 SSoT에 추가하지 않고 소비 지점만 늘렸을 때만 발생 가능하다.
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `pushContract: unhandled discriminator${context ? ` (${context})` : ''}: ${JSON.stringify(value)}`,
  );
}

/** `STATION_WAYPOINT_KINDS`에 속하는 값인지. 런타임 미검증 문자열(JSON payload)의 narrowing에 사용. */
export function isStationWaypointKind(value: unknown): value is StationWaypointKind {
  return (STATION_WAYPOINT_KINDS as readonly unknown[]).includes(value);
}

/** `CONTROL_PUSH_KINDS`에 속하는 값인지. */
export function isControlPushKind(value: unknown): value is ControlPushKind {
  return (CONTROL_PUSH_KINDS as readonly unknown[]).includes(value);
}

/** `SLEEP_ALARM_TARGET_KINDS`에 속하는 값인지. */
export function isSleepAlarmTargetKind(value: unknown): value is SleepAlarmTargetKind {
  return (SLEEP_ALARM_TARGET_KINDS as readonly unknown[]).includes(value);
}
