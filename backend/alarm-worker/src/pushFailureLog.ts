/**
 * D1 push_failures 테이블 helper (#2177).
 *
 * 배경: 08-06 RCA에서 push-unrecoverable의 정확한 APNs 코드(410 vs 400)를 확증하지 못했다.
 * push 실패는 console log에만 남고(`persist=false`, #2055) D1 미기록이라 wrangler tail 실시간
 * 관측 외 사후 진단 수단이 없었다. 본 모듈은 push 발사 **최종** 실패(성공/재시도 중간 실패 제외)를
 * D1에 적재해 사후 SELECT로 사유를 확정할 수 있게 한다.
 *
 * `backend_errors`(#1835)를 재사용하지 않고 `push_failures`를 신설한 이유: backend_errors는
 * endpoint/error_type/context(JSON) 형태라 apnsStatus/apnsReason별 GROUP BY 집계(obs-metrics
 * top 사유)가 매 쿼리 json_extract를 요구해 부적합. push 실패는 구조화 컬럼이 핵심 요구.
 *
 * `env.DB` 미바인딩 시 graceful no-op. 적재 실패는 push 발사 흐름을 차단하지 않는다(swallow).
 */

import { hashTripToken } from './sentry';
import type { ApnsEnv } from './types';

export interface PushFailureInput {
  /** APNs device token — 원본 노출 금지, FNV-1a hash만 저장. */
  token: string;
  /** trip 식별 토큰. 현재 시스템에서는 device token과 동일 값(`trip.token`)이지만 스키마상 분리. */
  tripToken?: string;
  /** push 종류 (예: 'transfer' | 'destination' | 'intermediate' | 'reschedule' | 'boarding-prompt' 등). */
  pushKind: string;
  apnsStatus: number;
  apnsReason?: string;
  apnsEnv?: ApnsEnv;
  /** 양쪽 host(sandbox/production) 모두 BadDeviceToken — 토큰 자체 무효 신호. */
  envMismatchExhausted?: boolean;
}

/**
 * push_failures 테이블에 최종 실패 1건을 기록한다.
 *
 * 호출자 책임: 성공은 호출하지 않는다 + 429/5xx transient 재시도 중간 실패가 아니라 재시도가
 * 더는 없다고 판정된 시점(최종 실패)에만 호출한다 — CF 무료 D1 quota 보호.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param input - 실패 메타데이터.
 */
export async function logPushFailure(
  db: D1Database | undefined,
  input: PushFailureInput,
): Promise<void> {
  if (!db) return;
  try {
    const tokenHash = hashTripToken(input.token);
    const tripTokenHash = input.tripToken !== undefined ? hashTripToken(input.tripToken) : tokenHash;
    await db
      .prepare(
        'INSERT INTO push_failures (ts, token_hash, trip_token_hash, push_kind, apns_status, apns_reason, apns_env, env_mismatch_exhausted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        Date.now(),
        tokenHash,
        tripTokenHash,
        input.pushKind,
        input.apnsStatus,
        input.apnsReason ?? null,
        input.apnsEnv ?? null,
        input.envMismatchExhausted === true ? 1 : 0,
      )
      .run();
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'pushFailureLog write failed', err: String(e) }));
  }
}

export interface PushFailureReasonBucket {
  /** `${apnsStatus}:${apnsReason ?? 'unknown'}` 형태 식별자. */
  reason: string;
  count: number;
}

export interface PushFailureMetrics {
  /** 최근 24h 최종 실패 총 건수. */
  total24h: number;
  /** 사유별 건수 내림차순 상위 N (기본 5). */
  topReasons: PushFailureReasonBucket[];
}

const TOP_REASONS_LIMIT = 5;

/** obs-metrics 미제공/DB 미바인딩 시 사용하는 zero 기본값. */
export const EMPTY_PUSH_FAILURE_METRICS: PushFailureMetrics = { total24h: 0, topReasons: [] };

/**
 * 최근 24h push_failures를 사유(apns_status:apns_reason)별로 집계한다.
 *
 * @param db - D1 binding. undefined 시 zero 기본값.
 * @param now - 현재 epoch ms. 24h 윈도우 시작점 산출용.
 */
export async function computePushFailureMetrics(
  db: D1Database | undefined,
  now: number,
): Promise<PushFailureMetrics> {
  if (!db) return EMPTY_PUSH_FAILURE_METRICS;
  try {
    const since = now - 24 * 60 * 60 * 1000;
    const totalResult = await db
      .prepare('SELECT COUNT(*) AS count FROM push_failures WHERE ts >= ?')
      .bind(since)
      .first<{ count: number }>();
    const total24h = totalResult?.count ?? 0;

    const reasonsResult = await db
      .prepare(
        `SELECT apns_status AS status, apns_reason AS reason, COUNT(*) AS count
         FROM push_failures
         WHERE ts >= ?
         GROUP BY apns_status, apns_reason
         ORDER BY count DESC
         LIMIT ?`,
      )
      .bind(since, TOP_REASONS_LIMIT)
      .all<{ status: number; reason: string | null; count: number }>();

    const rows = reasonsResult.results ?? [];
    const topReasons = rows.map((row) => ({
      reason: `${row.status}:${row.reason ?? 'unknown'}`,
      count: row.count,
    }));
    return { total24h, topReasons };
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'pushFailureLog read failed', err: String(e) }));
    return EMPTY_PUSH_FAILURE_METRICS;
  }
}
