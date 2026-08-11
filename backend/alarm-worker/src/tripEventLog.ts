/**
 * D1 trip_events append-only 로그 helper (#2283).
 *
 * 배경: `/boarding-lock/sync`(index.ts) · `/position`(index.ts)은 KV trip 객체를 in-place
 * mutate만 한다. trip이 user-delete(HTTP DELETE /trips/:token)되면 KV 객체 + position series까지
 * 삭제되어, "환승 swap sync가 도달했는지 / advance가 발생했는지"를 사후 재구성할 방법이 없었다
 * (2026-08-11 RCA blind spot — 08-11 A′ 검증 판정 불가의 직접 원인).
 *
 * 본 모듈은 kind 최소 집합(sync-received / advance / hydrate-issued / trip-end)을 D1
 * `trip_events`에 append-only로 기록한다. trip 삭제와 독립 — token_hash만으로 타임라인을
 * wrangler d1 SELECT로 재구성할 수 있다(진단 용도가 acceptance).
 *
 * Free plan quota 보호: KV write는 하지 않는다(#2073 lesson — cron이 사용자 0명에도 KV quota
 * 소진). D1 write만 사용하며 이벤트당 정확히 1 insert. `cleanupTripEvents`가 보존 기간(7일)
 * 초과분을 주기적으로 삭제한다.
 *
 * `env.DB` 미바인딩 시 graceful no-op. 적재 실패는 호출 흐름을 차단하지 않는다(swallow) —
 * d1ErrorLog.ts / d1TripMetrics.ts와 동일 패턴.
 */

/** trip_events.kind 최소 집합. 데이터 주도 확장 시 이 유니온에 추가한다. */
export type TripEventKind = 'sync-received' | 'advance' | 'hydrate-issued' | 'trip-end';

export interface TripEventInput {
  /** trip token의 해시(hashTripToken 결과). 원본 token은 D1에 남기지 않는다. */
  tokenHash: string;
  kind: TripEventKind;
  station?: string;
  line?: string;
  meta?: object;
}

/**
 * trip_events에 이벤트 1건을 append한다.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param input - 이벤트 메타데이터.
 * @param now - 적재 시각(epoch ms). 기본값 Date.now() — 테스트에서 고정값 주입 가능.
 */
export async function recordTripEvent(
  db: D1Database | undefined,
  input: TripEventInput,
  now: number = Date.now(),
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        'INSERT INTO trip_events (token_hash, ts, kind, station, line, meta) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        input.tokenHash,
        now,
        input.kind,
        input.station ?? null,
        input.line ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      )
      .run();
  } catch (e) {
    console.warn(
      JSON.stringify({ msg: 'tripEventLog write failed', kind: input.kind, err: String(e) }),
    );
  }
}

/** 보존 기간(ms). 7일 초과분은 cron cleanup이 삭제한다. */
export const TRIP_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 보존 기간(`TRIP_EVENT_RETENTION_MS`)을 초과한 trip_events 행을 삭제한다.
 *
 * 호출자(scheduled.ts)가 호출 빈도를 throttle한다 — 매 cron tick(1분)마다 부르면 D1 write
 * quota를 불필요하게 소진하므로, 시간 기반(예: 시 단위 1회) 게이트를 호출자 쪽에 둔다.
 *
 * @returns 삭제된 행 수. DB 미바인딩/실패 시 0.
 */
export async function cleanupTripEvents(
  db: D1Database | undefined,
  now: number = Date.now(),
): Promise<number> {
  if (!db) return 0;
  try {
    const cutoff = now - TRIP_EVENT_RETENTION_MS;
    const result = await db.prepare('DELETE FROM trip_events WHERE ts < ?').bind(cutoff).run();
    return result.meta?.changes ?? 0;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'tripEventLog cleanup failed', err: String(e) }));
    return 0;
  }
}
