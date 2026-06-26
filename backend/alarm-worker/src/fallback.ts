/**
 * Alert push fallback 발사 (#572 P2c).
 *
 * silent push가 60s 안에 디바이스 ACK되지 않으면 alert push로 fallback 발사한다.
 * cron 1회 실행 = 한 trip을 처리하는 scheduled.ts의 한 사이클에 이어 runFallbackPushes를 호출.
 *
 * #1894 (2026-06-26 RC-20) — 30s → 60s 완화.
 *   iOS는 silent push 처리 시간을 약 30s 이내로 강제하며, BG suspended 상태에서 task 시작
 *   직전 OS schedule 지연 + ACK fetch 네트워크 round-trip을 합치면 ageMs=63s 케이스가 관찰됨
 *   (T1 trip 1.5h에 1건, ageMs=63319ms). 30s 임계는 정상 처리 push까지 false fallback을
 *   유발해 사용자가 "silent + alert" 중복 알람을 받게 한다. silent push는 backend SSoT
 *   forward 단일 채널(`lesson_silent_push_is_ssot_forward_channel`)이라 false fallback이
 *   fusion tier 채택 0건과 cascade될 위험도 있다. iOS 처리 시간 상한(약 30s) + 네트워크
 *   round-trip 여유(약 30s)를 더한 60s가 정상 trip의 ACK latency를 모두 흡수한다.
 *
 * 60s 임계는 sentAt 시각 기준 — cron 자체는 1분 단위라 첫 폴링까지 최대 60s 지연 발생 가능.
 * 사용자 입장에선 알람 못 받는 것보단 늦게라도 받는 게 낫다는 절충(최대 약 2분).
 *
 * 발사 후 entry는 즉시 삭제 — 다음 cron에서 재발사 방지 (KV TTL 60s에 의존하지 않음).
 * 발사 실패도 entry 삭제 — 재시도 폭주 방지 (다음 silent push 사이클에서 자연 회복).
 */

import { sendAlertPush, type ApnsConfig, type SendPushResult } from './apns';
import { buildAlertContent } from './alertContent';
import { listPending, removePending, type PendingPush } from './pendingPushes';
import type { ApnsEnv, Env } from './types';

/**
 * silent push 발사 시점에서 60s 이상 지나면 fallback 후보 (#1894 / 2026-06-26 RC-20).
 *
 * 30_000ms 시절 false fallback 회귀: iOS BG silent push 처리 약 30s + ACK round-trip ≥ 임계 → alert 중복 발사.
 * 60_000ms 로 완화해 정상 trip의 ACK latency를 모두 흡수.
 */
export const FALLBACK_THRESHOLD_MS = 60_000;

export interface FallbackDeps {
  apnsConfig: ApnsConfig;
  /** APNs host 매핑. trip의 apnsEnv를 모르는 fallback 경로는 sandbox로 보낸다 (이미 token 검증된 entry). */
  apnsHosts: Record<ApnsEnv, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface FallbackStats {
  scanned: number;
  pushed: number;
  errors: number;
  /** 임계 미달로 다음 cron까지 미룬 수. 운영 가시성용. */
  deferred: number;
}

/**
 * PENDING_PUSHES KV를 스캔하며 30s 임계 초과 entry를 alert로 fallback 발사한다.
 * scheduled.ts와 분리 — 동일 cron에서 실행되어도 모듈 책임이 명확.
 */
export async function runFallbackPushes(env: Env, deps: FallbackDeps): Promise<FallbackStats> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => undefined);
  const stats: FallbackStats = { scanned: 0, pushed: 0, errors: 0, deferred: 0 };

  for await (const entry of listPending(env.PENDING_PUSHES)) {
    stats.scanned += 1;
    if (now - entry.sentAt < FALLBACK_THRESHOLD_MS) {
      stats.deferred += 1;
      continue;
    }

    log('alert fallback fire', {
      pushId: entry.pushId,
      station: entry.stationName,
      ageMs: Math.max(0, now - entry.sentAt),
    });
    const result = await sendOneFallback(entry, deps);
    if (result.ok) {
      stats.pushed += 1;
      await removePending(env.PENDING_PUSHES, entry.pushId);
    } else {
      stats.errors += 1;
      log('alert fallback failed', {
        pushId: entry.pushId,
        status: result.status,
        reason: result.reason,
      });
      // 영구 실패만 즉시 삭제 — transient 실패는 entry 유지하고 KV TTL(60s)이 자연 정리.
      // 다음 cron에서 1회 더 시도 기회를 보존 (사용자 알람 손실 최소화).
      if (isUnrecoverableAlertError(result.status, result.reason)) {
        await removePending(env.PENDING_PUSHES, entry.pushId);
      }
    }
  }

  log('fallback run complete', { ...stats });
  return stats;
}

/**
 * 한 pending entry를 alert로 발사한다.
 * intermediate kind는 phase 무관 단일 본문 — alertContent의 discriminated union이 강제.
 */
async function sendOneFallback(
  entry: PendingPush,
  deps: FallbackDeps,
): Promise<SendPushResult> {
  const content =
    entry.kind === 'intermediate'
      ? buildAlertContent({ kind: 'intermediate', stationName: entry.stationName })
      : buildAlertContent({
          kind: entry.kind,
          phase: entry.phase,
          stationName: entry.stationName,
        });
  // #566 머지 직후 KV에 남아있던 구 entry는 apnsEnv 필드가 없을 수 있다.
  // scheduled.ts의 `?? 'sandbox'` 패턴과 정합 — 잘못된 host 발사로 entry가 통째로 소실되는 것을 막는다.
  const env = entry.apnsEnv ?? 'sandbox';
  return sendAlertPush({
    deviceToken: entry.token,
    title: content.title,
    body: content.body,
    pushId: entry.pushId,
    config: deps.apnsConfig,
    host: deps.apnsHosts[env],
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * Alert push 영구 실패 분류 — transient 에러는 entry 유지로 다음 cron에서 재시도 보존.
 * scheduled.ts의 `isUnrecoverableApnsError`와 같은 의도지만 alert 경로에서는 self-heal이 없어
 * BadDeviceToken도 영구로 본다 (silent이 self-heal 후 putPending한 entry이므로 host는 검증됨,
 * BadDeviceToken이 떨어진다면 토큰 자체가 무효).
 */
function isUnrecoverableAlertError(status: number, reason: string | undefined): boolean {
  if (status === 410) return true; // Unregistered
  if (status === 400 && reason === 'BadDeviceToken') return true;
  if (status === 400 && reason === 'PayloadTooLarge') return true;
  return false;
}
