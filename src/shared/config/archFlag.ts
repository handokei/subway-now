/**
 * Arrival API SSOT 아키텍처 Feature Flag — client 측 (Phase 0, ADR-022 / 이슈 #1982).
 *
 * ADR-022 는 알림 SSOT 를 Seoul TOPIS `realtimeStationArrival` API (`arvlCd`) 로 단일화한다.
 * 전환 롤아웃은 OR 조건 두 채널로 게이팅한다:
 *
 *  1. **client env** `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` (`'true'` → 활성)
 *     — 특정 dogfood 빌드에 embed. rebuild 필요.
 *  2. **backend KV** `arch:simple-arrival-v1` (`'on'` → 활성)
 *     — 전 사용자 대상 rollout 스위치. rebuild 없이 즉시 전환/rollback.
 *
 * 판정: **OR** — 둘 중 하나만 활성이어도 새 아키텍처. 이유:
 *  - env: dogfood 개별 device 강제 ON (사용자 명시적 opt-in)
 *  - remote: 전 사용자 dogfood/rollout 스위치. 두 채널이 독립적이어야 각각의 롤백 경로가 살아있다.
 *
 * Phase 0 시점의 flag 값은 어떤 동작도 바꾸지 않는다(dormant). Phase 1 이후 caller 가 결과 값을
 * 새/구 아키텍처 분기 조건으로 사용한다. 본 모듈은 결과 판정 SSOT 만 제공한다.
 *
 * @see docs/decisions/ADR-022-arrival-api-ssot-redesign.md
 */

/** Env var 이름 — DebugModal 표시 / 테스트에서 재사용. */
export const SIMPLE_ARRIVAL_ARCH_ENV_KEY = 'EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH';

/**
 * Env 값을 읽어 flag ON 여부 반환. `'true'` 문자열만 활성 — 다른 값(미설정 / `'false'` /
 * 오타 등) 은 모두 비활성으로 정규화 (`.env.example` 도 default `false`).
 *
 * `process.env` 참조는 함수화 — Expo 는 빌드 타임에 인라인하지만 테스트에서는 런타임에 override
 * 가능하도록 매 호출 평가한다 (`isDebugModalEnabled` 와 동일 패턴).
 */
export function isSimpleArchEnvEnabled(): boolean {
  return process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] === 'true';
}

/**
 * Env OR Remote 판정. `remoteFlag` 인자는 `useArchFlagRemote()` hook 이나 다른 sync 조회
 * 결과를 그대로 전달. `undefined` (미조회 / unconfigured) 는 비활성으로 간주한다.
 *
 * 판정 순서:
 *  1. env=true → true (dogfood 빌드 강제 ON)
 *  2. remote='on' → true (전 사용자 rollout 스위치)
 *  3. 그 외 → false (dormant, 기존 동작 유지)
 */
export function isSimpleArchEnabled(
  remoteFlag?: 'on' | 'off',
): boolean {
  if (isSimpleArchEnvEnabled()) return true;
  return remoteFlag === 'on';
}
