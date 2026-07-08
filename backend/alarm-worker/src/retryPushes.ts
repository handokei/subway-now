/**
 * #1721 — silent push 전송 실패(429 / 5xx) 영구 lost 차단.
 *
 * 6/23 13:44 backend log evidence:
 *   - 13:44:17 `apns env mismatch — retry with opposite host` (sandbox correction)
 *   - 13:44:17 `apns env corrected to sandbox`
 *
 * `sendWithEnvHeal`은 1차(current env) + opposite env 1회 retry 까지만 시도한다. 두 env 모두
 * transient 실패(429 Too Many Requests / 500-599 server error)면 push가 영구 lost. 한편 401/403
 * 같은 영구 실패 또는 410 Unregistered는 별 cleanup path가 처리한다.
 *
 * 본 모듈은 PENDING_PUSHES KV에 `retry-push:<pushId>` prefix entry를 stamp해 다음 cron cycle 에서
 * exponential backoff (60s / 120s / 240s) 후 재발사를 시도한다. 별도 KV namespace 생성을 피하고
 * 기존 binding 을 prefix 로 재사용한다 (운영 manual step 0).
 *
 * 책임 분리:
 *   - `pendingPushes.ts` (`pending:` prefix): silent push 발사 직후 ACK 추적 (60s 미ACK alert fallback; #1894 30s→60s 완화).
 *   - `retryPushes.ts`   (`retry-push:` prefix): silent push 발사 자체 실패 시 transient retry 큐.
 *
 * 두 prefix 는 disjoint — 같은 pushId 가 두 큐에 동시 등록되지 않는다 (발사 성공 → pending, 실패 → retry).
 */

import {
  isRetryableApnsError,
  RETRY_BACKOFF_SCHEDULE_MS,
  computeNextRetryAt,
  sendWithEnvHeal,
} from './apnsHost';
import { sendSilentPush, type ApnsConfig, type SilentPushPayload } from './apns';
import type { ArchFlagValue } from './archFlag';
import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC as SHARED_CRON_TTL } from './kvConsistency';
import type { ApnsEnv, Env } from './types';

const RETRY_PREFIX = 'retry-push:';

/**
 * cron read의 KV cacheTtl. pendingPushes.ts와 동일 정책 — putRetryPush 직후 같은 cron 사이클이
 * (또는 다음 cycle) entry 를 못 보는 stale read 방지. Cloudflare KV 최소 30s.
 */
const CRON_READ_CACHE_TTL_SEC = SHARED_CRON_TTL;

/**
 * 전체 KV TTL — 모든 backoff 단계를 cover 하고 buffer 60s. attempt 4 도달 시 remove 호출이
 * idempotent 하므로 TTL 만료 자연 정리도 안전.
 */
export const RETRY_PUSH_TTL_SEC = Math.ceil(
  RETRY_BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0) / 1000,
) + 60;

/**
 * Retry queue entry. silent push payload + 발사 컨텍스트(token, apnsEnv) + retry meta.
 *
 * payload 전체를 직렬화해 다음 cron 이 원본 push 를 재구성할 수 있게 한다 — caller (`fireArvlCdStationPush`
 * 등)가 같은 payload 를 다시 빌드할 필요가 없다.
 */
export interface RetryPush {
  pushId: string;
  /** APNs device token. */
  token: string;
  /** silent push payload 전체 (재발사용). */
  payload: SilentPushPayload;
  /** apnsEnv snapshot. retry 시점에 trip.apnsEnv 가 corrected 되었을 수 있으나, queue 시점 값으로 1차 시도. */
  apnsEnv: ApnsEnv;
  /** 시도 횟수 (0 = 첫 enqueue 직후, 1 = 첫 retry 후, …). RETRY_BACKOFF_SCHEDULE_MS.length 도달 시 폐기. */
  attemptCount: number;
  /** 다음 시도 시각 (epoch ms). cron 이 now >= nextAttemptAt 일 때만 처리. */
  nextAttemptAt: number;
  /** 원본 발사 시도 시각 (관측용). */
  originalSentAt: number;
  /** 마지막 실패 status — RCA 용. */
  lastErrorStatus: number;
  /** 마지막 실패 reason (있을 때). */
  lastErrorReason?: string;
}

export function retryPushKey(pushId: string): string {
  return `${RETRY_PREFIX}${pushId}`;
}

/**
 * #1995 (ADR-022 Phase 1-2) — archFlag=on 시 재발사 대상 kind 필터.
 *
 * 반복 알림 조사 코멘트 case 4: silent push 발사 실패 시 backend 재발사가 station-passed /
 * transfer / intermediate 알림까지 모두 반복 발사해 사용자에게 "이미 지난 알림"이 반복 노출됨.
 * 신규 아키텍처 (ADR-022) 는 destination(하차) 알림만 사용자에게 필수 재발사 가치가 있다고
 * 판단해 retry queue 적재 자체를 destination 으로 제한한다.
 *
 * flag=off (default) 시 이 함수는 항상 true 반환 — 기존 동작 100% 유지.
 * flag=on 시 kind !== 'destination' 이면 false → enqueueRetryIfTransient 가 no-op.
 */
export function shouldRetryForKind(
  archFlag: ArchFlagValue | undefined,
  kind: SilentPushPayload['kind'],
): boolean {
  if (archFlag !== 'on') return true;
  return kind === 'destination';
}

/**
 * 발사 실패가 retryable 인지 검사 + retry queue 등록. status 가 retryable 이 아니거나 KV 미바인딩이면 no-op.
 *
 * `attemptCount` 미지정 시 0 (첫 enqueue). 호출자가 fire path 실패 직후 한 번 호출하면 충분 —
 * 다음 cron `runRetryPushes` 가 backoff 후 재발사 + 추가 실패 시 attemptCount 증가 + 재 enqueue.
 *
 * #1995 (ADR-022 Phase 1-2) — `archFlag` 파라미터 (optional). flag=on 시 payload.kind !==
 * 'destination' 이면 no-op. 미전달 (legacy caller / retry loop 자기 재 enqueue) 시 undefined
 * 로 처리 → 기존 동작 100% 유지.
 */
export async function enqueueRetryIfTransient(
  kv: KVNamespace | undefined,
  input: {
    pushId: string;
    token: string;
    payload: SilentPushPayload;
    apnsEnv: ApnsEnv;
    status: number;
    reason?: string;
    now: number;
    attemptCount?: number;
    originalSentAt?: number;
  },
  archFlag?: ArchFlagValue,
): Promise<boolean> {
  if (!kv) return false;
  if (!isRetryableApnsError(input.status)) return false;
  if (!shouldRetryForKind(archFlag, input.payload.kind)) return false;
  const attemptCount = input.attemptCount ?? 0;
  const nextAttemptAt = computeNextRetryAt(attemptCount, input.now);
  if (nextAttemptAt === null) return false; // 영구 폐기 — caller 가 별도 cleanup
  const entry: RetryPush = {
    pushId: input.pushId,
    token: input.token,
    payload: input.payload,
    apnsEnv: input.apnsEnv,
    attemptCount,
    nextAttemptAt,
    originalSentAt: input.originalSentAt ?? input.now,
    lastErrorStatus: input.status,
    ...(input.reason !== undefined ? { lastErrorReason: input.reason } : {}),
  };
  await kv.put(retryPushKey(input.pushId), JSON.stringify(entry), {
    expirationTtl: RETRY_PUSH_TTL_SEC,
  });
  return true;
}

export async function removeRetryPush(
  kv: KVNamespace | undefined,
  pushId: string,
): Promise<void> {
  if (!kv) return;
  await kv.delete(retryPushKey(pushId));
}

/**
 * cron 시점 모든 retry-push entry enumerate. listPending 과 동일 패턴 (prefix scan + cursor).
 * 손상된 JSON 은 skip (TTL 자연 정리).
 */
export async function* listRetryPushes(
  kv: KVNamespace | undefined,
): AsyncGenerator<RetryPush> {
  if (!kv) return;
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: RETRY_PREFIX, cursor });
    for (const key of result.keys) {
      assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
      if (!raw) continue;
      try {
        yield JSON.parse(raw) as RetryPush;
      } catch {
        // 손상된 entry 는 skip — 만료로 자연 정리.
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

type Logger = (message: string, meta?: Record<string, unknown>) => void;

export interface RetryPushDeps {
  apnsConfig: ApnsConfig;
  apnsHosts: Record<ApnsEnv, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
  /**
   * #1995 (ADR-022 Phase 1-2) — archFlag=on 시 재실패 재 enqueue 도 destination 만 유지.
   * 미전달 시 undefined 로 처리되어 기존 동작 100% 유지.
   */
  archFlag?: ArchFlagValue;
}

export interface RetryPushStats {
  scanned: number;
  /** nextAttemptAt 미도달로 skip — 다음 cron tick 까지 deferred. */
  deferred: number;
  /** 재발사 성공 — entry 삭제. */
  resent: number;
  /** transient 실패 → backoff 재 enqueue. */
  rescheduled: number;
  /** unrecoverable 또는 attempt 소진 → 영구 폐기 (entry 삭제). */
  exhausted: number;
}

/**
 * `retry-push:` 큐를 스캔하며 backoff 만기 entry 를 재발사한다. cron 1 cycle 당 1회 호출.
 *
 * 처리 흐름:
 *   1. `now < nextAttemptAt` → deferred + skip.
 *   2. `sendWithEnvHeal` 로 양 env 재시도. envHeal 자체가 mismatch 보정 1회 + opposite 1회.
 *   3. 성공 → `removeRetryPush` + resent++.
 *   4. 실패가 retryable + attemptCount < 한계 → 다음 backoff 로 재 enqueue (attemptCount + 1).
 *   5. 실패가 unrecoverable 또는 attempt 한계 도달 → `removeRetryPush` + exhausted++. caller 의
 *      별 cleanup (410 → cleanupTripWithLa) 는 본 큐 책임 외 — 원본 발사 사이트가 이미 처리.
 */
export async function runRetryPushes(env: Env, deps: RetryPushDeps): Promise<RetryPushStats> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => undefined);
  const stats: RetryPushStats = { scanned: 0, deferred: 0, resent: 0, rescheduled: 0, exhausted: 0 };
  for await (const entry of listRetryPushes(env.PENDING_PUSHES)) {
    stats.scanned += 1;
    if (now < entry.nextAttemptAt) {
      stats.deferred += 1;
      continue;
    }
    log('retry-push attempt', {
      pushId: entry.pushId,
      attempt: entry.attemptCount + 1,
      ageMs: now - entry.originalSentAt,
    });
    const heal = await sendWithEnvHeal(
      (host) =>
        sendSilentPush({
          deviceToken: entry.token,
          payload: { ...entry.payload, sentAt: now },
          config: deps.apnsConfig,
          host,
          fetchImpl: deps.fetchImpl,
          now,
        }),
      entry.apnsEnv,
      deps.apnsHosts,
      log,
      entry.token.slice(0, 8),
    );
    if (heal.result.ok) {
      stats.resent += 1;
      await removeRetryPush(env.PENDING_PUSHES, entry.pushId);
      continue;
    }
    // 실패. retryable 이면 다음 backoff 로 재 enqueue, 아니면 폐기.
    // #1995 (ADR-022 Phase 1-2) — flag=on 시 destination 만 재 enqueue.
    const nextAttempt = entry.attemptCount + 1;
    const rescheduled = await enqueueRetryIfTransient(
      env.PENDING_PUSHES,
      {
        pushId: entry.pushId,
        token: entry.token,
        payload: entry.payload,
        apnsEnv: heal.correctedEnv ?? entry.apnsEnv,
        status: heal.result.status,
        reason: heal.result.reason,
        now,
        attemptCount: nextAttempt,
        originalSentAt: entry.originalSentAt,
      },
      deps.archFlag,
    );
    if (rescheduled) {
      stats.rescheduled += 1;
      log('retry-push rescheduled', {
        pushId: entry.pushId,
        nextAttempt,
        status: heal.result.status,
        reason: heal.result.reason,
      });
    } else {
      stats.exhausted += 1;
      await removeRetryPush(env.PENDING_PUSHES, entry.pushId);
      log('retry-push exhausted', {
        pushId: entry.pushId,
        attempt: nextAttempt,
        status: heal.result.status,
        reason: heal.result.reason,
      });
    }
  }
  // #2054 — idle skip. scanned=0 (retry queue empty) 시 로그 억제. Cloudflare Workers Logs
  // cap(2000/cycle 5 로그) 소진 방지. 활성 retry 있을 땐 기존대로 상세 log.
  if (stats.scanned > 0) {
    log('retry-push run complete', { ...stats });
  }
  return stats;
}
