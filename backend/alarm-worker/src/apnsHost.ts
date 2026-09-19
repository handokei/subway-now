/**
 * APNs host 선택 정책 (#482) — scheduled.ts와 liveActivity.ts가 공유하는 SSOT.
 *
 * - 누락된 apnsEnv는 sandbox로 fallback. 구버전 클라이언트(필드 없음)가 production host로
 *   잘못 보내져 BadDeviceToken을 받는 회귀를 막기 위함. App Store/TestFlight 빌드는
 *   반드시 명시적으로 'production'을 보내야 한다.
 * - `flipApnsEnv`는 self-heal에서 1차 host와 반대 host로 retry할 때 사용. undefined는
 *   sandbox로 시작했으므로 production으로 뒤집는다.
 */

import { isValidApnsToken } from './apnsToken';
import { logPushFailure } from './pushFailureLog';
import type { ApnsEnv } from './types';
import type { SendPushResult } from './apns';

type Logger = (message: string, meta?: Record<string, unknown>) => void;

/**
 * #2176 (관측 전용, 축소 스펙) — 발사 직전 토큰 포맷 관측 컨텍스트.
 *
 * 08-06 로테이션 결함 RCA: `trip.token`이 UUID로 로테이션된 상태로 APNs에 발사돼도 아무도
 * 감지하지 못했다. 이 컨텍스트를 `sendWithEnvHeal`에 넘기면 실제 발사 토큰(`deviceToken`)이
 * 64-hex가 아닐 때 `push_failures`에 `invalid-token-format` 사유로 기록한다 — **발사 자체는
 * 막지 않는다** (동작 불변, 1단계는 관측만). 강제 차단은 production 관측 0건 확인 후 별도 이슈.
 */
export interface ApnsTokenObserveContext {
  /** 실제 APNs로 발사되는 토큰 (마스킹 없이 전체 값 — pushFailureLog가 내부에서 hash한다). */
  deviceToken: string;
  db: D1Database | undefined;
  tripToken: string;
}

/** 관측 기록 시 pushFailureLog에 남기는 pushKind. 실제 push 종류와 무관 — 포맷 결함 자체를 버킷팅. */
const TOKEN_FORMAT_OBSERVE_PUSH_KIND = 'apns-fire';

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
  observe?: ApnsTokenObserveContext,
): Promise<EnvHealResult> {
  // #2176 — 발사 전 토큰 포맷 관측 (기록만, 발사 흐름 차단 안 함). caller가 `observe`를
  // 넘기지 않으면 완전히 no-op — 기존 caller/테스트는 동작 무변경.
  if (observe !== undefined && !isValidApnsToken(observe.deviceToken)) {
    log('apns invalid token format observed (#2176 — fire not blocked)', {
      token: tokenForLog,
    });
    await logPushFailure(observe.db, {
      token: observe.deviceToken,
      tripToken: observe.tripToken,
      pushKind: TOKEN_FORMAT_OBSERVE_PUSH_KIND,
      apnsStatus: 0,
      apnsReason: 'invalid-token-format',
    });
  }
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
  // #1931 — race evidence 적재. Cloudflare Dashboard에서 `kind=apns AND reason=env-mismatch-race`
  // 쿼리로 cold start race window 발생 빈도(baseline 6/26 6건 + 6/27 1건 → target <1건/주)를
  // 1주 단위로 측정한다. 정정 자체는 기존 retry path가 처리하므로 본 라인은 측정 채널 추가만.
  log('apns env mismatch (race evidence)', {
    kind: 'apns',
    reason: 'env-mismatch-race',
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
