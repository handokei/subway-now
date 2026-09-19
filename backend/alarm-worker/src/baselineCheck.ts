/**
 * Baseline check aggregator (#1621 Phase C).
 *
 * 배경
 * ====
 * 사용자 framework: "측정을 할 수 있는 기본을 만들어 놓고 측정". V1 회복(Stage 1/2/3 누적)으로
 * "현재 위치 정확 + backend가 trainCode 알고 silent 알림 도달"이 baseline 정의. 본 모듈은
 * 사용자 1 trip 시 즉시 pass/fail을 산출 — 자동 baseline 작동 verify.
 *
 * 측정 신호
 * =========
 *  - `tripActive`: KV `trip:{token}` 존재 여부 (활성 trip 여부)
 *  - `silentPushFired`: KV `pending:` prefix 카운트 (in-flight push, 60s TTL)
 *  - `silentPushReceived`: KV `received:` prefix 1h 윈도우 ack 카운트
 *  - `v1Mismatch`: R2 alarm-log 1h 윈도우 'v1-mismatch' reason 카운트
 *
 * pass 조건:
 *  - `silentPushFired > 0` (baseline 알림 path 작동)
 *  - `v1Mismatch === 0` (현재역 정확)
 *
 * 둘 중 하나라도 미충족 → fail (운영자가 RCA endpoint로 reason 분포 탐색).
 *
 * R2 cost: alarmLogStats와 동일 (1h 윈도우, 50 trip cap).
 */

import { computePushAckStats } from './pushAckStats';
import { computeAlarmLogStats } from './alarmLogStats';
import { getTrip } from './trips';

export interface BaselineSignals {
  tripActive: boolean;
  silentPushFired: number;
  silentPushReceived: number;
  v1Mismatch: number;
}

export interface BaselineCheckResponse {
  baseline: 'pass' | 'fail';
  signals: BaselineSignals;
}

/**
 * baseline 작동 신호 집계 + pass/fail 산출.
 *
 * @param kv TRIPS KV namespace
 * @param r2 TELEMETRY_R2 bucket (V1 mismatch source)
 * @param token 사용자 trip token (활성 trip 신호 source)
 * @param now epoch ms
 */
export async function computeBaselineCheck(
  kv: KVNamespace,
  r2: R2Bucket,
  token: string,
  now: number,
): Promise<BaselineCheckResponse> {
  const [trip, pushStats, alarmStats] = await Promise.all([
    getTrip(kv, token),
    computePushAckStats(kv, now),
    computeAlarmLogStats(r2, now, 1),
  ]);

  const signals: BaselineSignals = {
    tripActive: trip !== null,
    // pending count는 in-flight push 수 — 본 endpoint는 fired 인디케이터로 사용.
    // received는 ack 도달, fired는 backend 발사 → 운영자가 둘 다 본다.
    silentPushFired: pushStats.pending + pushStats.received,
    silentPushReceived: pushStats.received,
    v1Mismatch: alarmStats.reasons['v1-mismatch'] ?? 0,
  };

  const baseline: 'pass' | 'fail' =
    signals.silentPushFired > 0 && signals.v1Mismatch === 0 ? 'pass' : 'fail';

  return { baseline, signals };
}
