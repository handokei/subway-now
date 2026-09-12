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

/**
 * G6 unknown-kind 처리 정책 (ADR-029 Phase 1 / #2243) — SSoT.
 *
 * backend가 SSoT에 없는 새 kind를 보내는 계약 스큐 발생 시, "종류"에 따라 정책이 갈린다:
 * - station 계열(payload가 `nextWaypoint`를 갖는 standard silent push 형태인데 kind가
 *   STATION_WAYPOINT_KINDS 밖) → 안전 우선. 사용자 노출 알림을 조용히 누락시키지 않도록
 *   **generic imminent fallback을 발사**한다(어떤 역인지는 알지만 kind 의미만 모르는 상황).
 * - control 계열(payload가 station 형태가 아닌데 kind가 CONTROL_PUSH_KINDS 밖) → **fail-closed**.
 *   control push는 schema 자체가 kind마다 달라 임의 fallback 처리가 오히려 위험(state
 *   corruption 가능) — 거부하고 로그만 남긴다.
 *
 * 두 경우 모두 조용한 drop은 금지 — 소비자(device `silentPushTask.ts`)가 반드시 skew 로그를
 * 남겨야 한다(A2). 정책 값 자체는 여기 SSoT에서만 정의하고, 소비자는 이 상수를 참조해 분기한다.
 */
export const UNKNOWN_KIND_POLICY = {
  /** station-shaped unknown kind. */
  stationLike: 'fallback-imminent-fire',
  /** control-shaped unknown kind. */
  controlLike: 'fail-closed',
} as const;
export type UnknownKindPolicyAction = (typeof UNKNOWN_KIND_POLICY)[keyof typeof UNKNOWN_KIND_POLICY];

/**
 * G2 semantic value 검증 (ADR-029 Phase 1 / #2243) — SSoT.
 *
 * Phase 0의 exhaustive switch/assertNever는 discriminator(kind)의 **집합**(어떤 값들이
 * 허용되는지)을 컴파일 타임에 보증한다. 그 아래 값(stationId/phase/etaSeconds)은 타입은
 * 맞아도(`string`/`number`) 런타임 값이 도메인 semantics를 벗어나는 drift가 가능하다
 * (예: NaN etaSeconds, epoch를 잘못 실어보낸 초대형 값, 빈 문자열 station identifier).
 * 이 경계에서 값을 검증해 통과 못한 값은 소비자가 skew로 관측하도록 한다.
 */

/**
 * station identifier(표시 역명 — `nextWaypoint`/`nextStation`/`originStation` 등, stationId 형식
 * 호환) 최소 형식 검증. 서울 지하철 최장 역명(예: "동대문역사문화공원")보다 넉넉한 길이 상한 +
 * 제어문자 배제만 강제한다 — 다국어 역명(ko/en/ja/zh)을 전부 수용해야 하므로 문자셋 자체는
 * 제한하지 않는다.
 */
const STATION_IDENTIFIER_MAX_LEN = 40;
/** 제어문자(0x00~0x1F) 미포함 여부. regex literal escape로인한 바이트 오염을 피하기 위해 charCode 반복으로 검사.*/
function hasNoControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f) return false;
  }
  return true;
}
export function isValidStationIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= STATION_IDENTIFIER_MAX_LEN &&
    hasNoControlChars(value)
  );
}

/** silent push discriminator `phase` — SilentPushPayload/backend AlarmPhase와 값 집합 1:1. */
export const PUSH_ALARM_PHASES = ['early', 'imminent'] as const;
export type PushAlarmPhase = (typeof PUSH_ALARM_PHASES)[number];
export function isPushAlarmPhase(value: unknown): value is PushAlarmPhase {
  return (PUSH_ALARM_PHASES as readonly unknown[]).includes(value);
}

/**
 * `etaSeconds` 상한 — trip lifecycle 9h force-end backstop(device `TRIP_LIFECYCLE_FORCE_END_MS`
 * / backend `BACKEND_TRIP_LIFECYCLE_FORCE_END_MS`)과 같은 자릿수(초 단위 32400s)를 상한으로
 * 삼는다. 이보다 큰 값은 단위 실수(예: ms를 s로 착각) 또는 계산 drift로 판정한다.
 */
export const PUSH_ETA_SECONDS_MAX = 32_400;
export function isValidEtaSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= PUSH_ETA_SECONDS_MAX
  );
}

/**
 * 런타임 버전 스큐 방어 (ADR-029 Phase 5 / G1, #2253) — SSoT.
 *
 * backend와 device는 이 파일(SSoT)을 각자 별도 빌드에 컴파일해 넣는다 — **같은 git SHA로 배포된
 * 경우에만** 완전히 정합하다. App Store 심사 지연 등으로 device가 backend보다 낡은 빌드를
 * 실행 중이면, 두 런타임이 별도로 배포됐기 때문에 컴파일 타임 exhaustive switch(Phase 0)로도
 * 못 잡는 **런타임 스큐**가 발생한다(2026-08-09 dump `unk=5`의 실제 원인 중 하나로 추정).
 *
 * backend `apns.ts` `buildSilentPushData`가 매 standard silent push payload에 이 값을
 * `contractVersion`으로 stamp하고, device `silentPushTask.ts`가 자신이 빌드된 시점의
 * `PUSH_CONTRACT_VERSION`(같은 SSoT를 import한 값)과 비교한다. device 값보다 backend 값이 크면
 * device가 낡은 것 — **skew 관측(P1 skew 로그 경로 재사용) + 기존 kind는 fail-open으로 정상
 * 발사**(P1 G6 정책 재사용, ADR-029 A5). 발사를 막는 것은 A2(silent drop 금지) 취지에 반한다.
 *
 * **backward-compat 규칙(additive-only)**: 이 값을 올리는 것은 discriminator 집합/필수 필드
 * semantics 자체가 바뀔 때만 — 신규 optional 필드 추가는 버전을 올리지 않는다. 값을 올리는 PR은
 * backend가 **최소 2릴리스** 동안 구 device가 이해하는 kind/필드를 계속 발사할 수 있어야 한다
 * (ADR-029 Phase 5 본문).
 *
 * **관측 범위(#2253 최초 구현)**: stamp/비교는 backend `buildSilentPushData`(standard silent
 * push — station waypoint kind + unknown-kind fallback 경로 포함)에 한정된다. reschedule/
 * trip-ended/boarding-prompt/sleep-alarm-companion 등 별도 control payload builder는 아직
 * stamp하지 않는다 — 이번 dump(`unk=5`)의 원인이 standard 경로였기 때문에 그쪽부터 닫았다.
 * control 채널까지 확장은 후속 스코프.
 */
export const PUSH_CONTRACT_VERSION = 1;

/** `contractVersion` 값 형식 검증 — 1 이상 정수만 유효. */
export function isValidContractVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
