/**
 * APNs host 선택 정책 (#482) — scheduled.ts와 liveActivity.ts가 공유하는 SSOT.
 *
 * - 누락된 apnsEnv는 sandbox로 fallback. 구버전 클라이언트(필드 없음)가 production host로
 *   잘못 보내져 BadDeviceToken을 받는 회귀를 막기 위함. App Store/TestFlight 빌드는
 *   반드시 명시적으로 'production'을 보내야 한다.
 * - `flipApnsEnv`는 self-heal에서 1차 host와 반대 host로 retry할 때 사용. undefined는
 *   sandbox로 시작했으므로 production으로 뒤집는다.
 */

import type { ApnsEnv } from './types';
import type { SendPushResult } from './apns';

type Logger = (message: string, meta?: Record<string, unknown>) => void;

export function pickApnsHost(apnsEnv: ApnsEnv | undefined, hosts: Record<ApnsEnv, string>): string {
  return hosts[apnsEnv ?? 'sandbox'];
}

export function flipApnsEnv(env: ApnsEnv | undefined): ApnsEnv {
  return (env ?? 'sandbox') === 'sandbox' ? 'production' : 'sandbox';
}

/** BadDeviceToken(400) — 토큰이 잘못된 APNs env로 전송됐다는 신호. */
export function isApnsEnvMismatch(status: number, reason: string | undefined): boolean {
  return status === 400 && reason === 'BadDeviceToken';
}

/**
 * #1721 — APNs response status 분류 (transient retry vs permanent fail).
 *
 * 6/23 13:44 evidence (backend log): env mismatch self-heal이 1회 retry만 시도하고 second
 * call도 transient 실패면 silent push 영구 lost. 본 helper는 transient retry가 필요한 상태
 * 를 분리해 retry queue 적재 결정을 단순화한다.
 *
 * | status | 분류           | 처리                                                   |
 * |--------|---------------|--------------------------------------------------------|
 * | 410    | unrecoverable | device token 제거 + trip cleanup (기존 흐름 유지)     |
 * | 429    | retryable     | exponential backoff (60s/120s/240s) → retry           |
 * | 500-599| retryable     | exponential backoff (60s/120s/240s) → retry           |
 * | 그 외  | non-retryable | 기존 동작 (envHeal/dedup 등)                          |
 */
export function isRetryableApnsError(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * #1721 — exponential backoff schedule for retryable APNs failures.
 * - attempt 0 → 1차 시도 (즉시)
 * - attempt 1 → 60s 후 retry
 * - attempt 2 → 120s 후 retry
 * - attempt 3 → 240s 후 retry
 * - attempt ≥ 4 → 영구 폐기 (RETRY_BACKOFF_SCHEDULE_MS.length 초과)
 *
 * 60s가 1차 backoff인 이유: cron이 1분 주기라 그보다 짧은 backoff는 의미 없음. APNs 429는
 * 대개 burst rate-limit이라 60s면 충분히 해소.
 */
export const RETRY_BACKOFF_SCHEDULE_MS = [60_000, 120_000, 240_000] as const;

/**
 * 다음 retry 시각 계산. attempt가 schedule 범위 밖이면 null (영구 폐기 신호).
 */
export function computeNextRetryAt(attempt: number, now: number): number | null {
  if (attempt < 0 || attempt >= RETRY_BACKOFF_SCHEDULE_MS.length) return null;
  return now + RETRY_BACKOFF_SCHEDULE_MS[attempt];
}

export interface EnvHealResult {
  result: SendPushResult;
  /** retry로 정정된 새 env. 정정 발생 시에만 set. */
  correctedEnv?: ApnsEnv;
  /** 양쪽 host 모두 BadDeviceToken — 토큰 자체 무효 신호. */
  envMismatchExhausted: boolean;
}

/**
 * APNs env mismatch self-heal (#482). 1차 호출 → BadDeviceToken이면 opposite host로 1회 retry.
 * `sender`는 host를 받아 push를 보내는 클로저 — phase / reschedule / lockless / trip-ended push가 재사용.
 *
 * 호출자 책임:
 *   - correctedEnv set → trip.apnsEnv 갱신 + envCorrected stat 카운트
 *   - envMismatchExhausted true → trip 삭제
 *   - result.ok / !ok 분기는 각 경로별 후처리에 맡김
 */
export async function sendWithEnvHeal(
  sender: (host: string) => Promise<SendPushResult>,
  currentEnv: ApnsEnv | undefined,
  apnsHosts: Record<ApnsEnv, string>,
  log: Logger,
  tokenForLog: string,
): Promise<EnvHealResult> {
  const initial = await sender(pickApnsHost(currentEnv, apnsHosts));
  if (initial.ok || !isApnsEnvMismatch(initial.status, initial.reason)) {
    return { result: initial, envMismatchExhausted: false };
  }
  const corrected = flipApnsEnv(currentEnv);
  log('apns env mismatch — retry with opposite host', {
    token: tokenForLog,
    from: currentEnv ?? 'sandbox',
    to: corrected,
  });
  const retry = await sender(apnsHosts[corrected]);
  if (retry.ok) {
    log('apns env corrected', { token: tokenForLog, to: corrected });
    return { result: retry, correctedEnv: corrected, envMismatchExhausted: false };
  }
  return {
    result: retry,
    envMismatchExhausted: isApnsEnvMismatch(retry.status, retry.reason),
  };
}
