/**
 * #1040 follow-up — Sentry 활성 상태 in-memory 플래그.
 *
 * sentryInit.ts에서 init 성공 시 `setSentryEnabled(true)` 호출.
 * breadcrumb wiring은 매 로그마다 AsyncStorage를 읽지 않고 이 플래그로 가드한다.
 *
 * 별도 모듈로 분리한 이유: logger.ts → breadcrumb.ts → (state) 경로에서
 * sentryInit.ts(logger를 import)와 순환 의존을 피하기 위함.
 */
let sentryEnabled = false;

export function setSentryEnabled(value: boolean): void {
  sentryEnabled = value;
}

export function isSentryEnabled(): boolean {
  return sentryEnabled;
}
