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
