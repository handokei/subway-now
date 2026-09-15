/**
 * D1 trip_metrics 테이블 적재 helper (#1835, Phase 2).
 *
 * trip 종료 시 `cleanupTripWithLa` (liveActivity.ts) 에서 호출한다.
 * `env.DB` 미바인딩 시 graceful no-op.
 *
 * 적재 실패는 trip cleanup 흐름을 차단하지 않는다 (내부 try/catch로 swallow).
 */

import { hashTripToken } from './sentry';
import type { Trip } from './types';

/**
 * trip_metrics 에 trip 종료 기록을 적재한다.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param trip - 종료된 trip 객체.
 * @param reason - 종료 사유. undefined = 사용자 명시 DELETE (HTTP DELETE /trips/:token, reason
 *   미전달 시). `TripEndedReason`(server-side auto-end)뿐 아니라 device가 보고하는 자유
 *   문자열(예: 'lockless-trip-end', 'user-tap')도 받는다(#2268) — alert push 발사 여부와는
 *   무관한 순수 telemetry 값이라 push payload 타입(`TripEndedReason`)으로 제약하지 않는다.
 *   타입은 `string` 단독 — `TripEndedReason | string`은 리터럴이 string에 흡수돼 자동완성
 *   효과가 없다(Sonar maintainability). `TripEndedReason` 값도 문자열이라 그대로 대입 가능.
 * @param endedAt - 종료 epoch ms.
 */
export async function recordTripMetrics(
  db: D1Database | undefined,
  trip: Trip,
  reason: string | undefined,
  endedAt: number,
): Promise<void> {
  if (!db) return;
  try {
    const tokenHash = hashTripToken(trip.token);
    const { boardingPromptState, boardingLock } = trip;

    const lineList = extractLineList(trip);
    const chainComplete = isChainComplete(trip);
    // #2628 — trip_events(D1 SSoT)에서 직접 집계. INSERT 직전에 미리 구해 bind 인자 목록을
    // 동기 표현식으로 유지한다(가독성 — await를 .bind() 인자 중간에 섞지 않음).
    const firedCount = await countSentFireAttempts(db, tokenHash, trip.createdAt, endedAt);

    // #2268 — INSERT OR IGNORE + migration 0004의 (trip_token_hash, started_at) UNIQUE index.
    // DELETE /trips/:token이 getTrip→cleanupTripWithLa 사이 race하면 동일 trip 종료가
    // recordTripMetrics를 두 번 호출할 수 있다(evidence: 2026-08-10, 동일 trip_token_hash 2행,
    // 521ms차). D1(SQLite)의 UNIQUE 제약이 실제 원자성을 보장 — KV는 compare-and-swap이 없어
    // app-level "먼저 읽고 나만 지웠으면 진행" 가드로는 이 race를 완전히 닫을 수 없다. 두 번째
    // race 호출은 조용히 no-op(0 rows affected) — try/catch에 걸리지 않고 정상 흐름 유지.
    await db
      .prepare(
        `INSERT OR IGNORE INTO trip_metrics (
          trip_token_hash, started_at, ended_at, end_reason,
          origin_station, destination_station, line_list,
          fired_count, suppressed_count,
          boarding_prompt_displayed, boarding_prompt_responded,
          lock_attached, chain_complete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tokenHash,
        trip.createdAt,
        endedAt,
        reason ?? 'user-delete',
        extractOriginStation(trip),
        trip.destination ?? null,
        JSON.stringify(lineList),
        // #2628 — station-passed/transfer/destination alert push가 실제로 발사(outcome='sent')된
        // 횟수를 D1 trip_events(kind='cron-fire-attempt')에서 직접 집계. #2281의 trip 객체 카운터
        // (boardingPromptState/hopEndPromptState fireCount 합산)는 prompt 발사만 셌을 뿐 매역
        // alert 발사를 전혀 포함하지 않았고, D1이 이미 SSoT라 POST /trips 재등록으로 trip 객체가
        // 교체돼도 유실되지 않는다(trip.createdAt이 재등록 후에도 같은 세션에선 불변이라 집계
        // window가 흔들리지 않음).
        firedCount,
        0, // suppressed_count: 동상
        boardingPromptState?.fired ? 1 : 0,
        // #2628 — POST /trips/:token/boarding-confirm 응답 시 stamp되는 생애 플래그. 기존
        // 하드코딩 0("Phase 2 follow-up") 수리.
        trip.boardingPromptResponded ? 1 : 0,
        // #2628 — "현재 부착 상태"(boardingLock truthy)만이 아니라 "생애 중 한 번이라도
        // 부착됐는지"(lockEverAttached, trips.ts putTrip이 stamp)도 함께 본다. 종료 직전 lock을
        // 해제한 trip이 0으로 오기록되던 RCA를 차단 — 방어적으로 현재 부착 상태도 OR로 포함해
        // lockEverAttached 배선이 누락된 레거시 경로가 있어도 최소한 현재 상태는 반영한다.
        trip.lockEverAttached === true || boardingLock !== undefined ? 1 : 0,
        chainComplete ? 1 : 0,
      )
      .run();
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'd1TripMetrics write failed', err: String(e) }));
  }
}

/** trip route에서 노선 목록(중복 제거)을 추출한다. */
function extractLineList(trip: Trip): string[] {
  const { route } = trip;
  if (route.type === 'direct') return [route.line];
  if (route.type === 'transfer') return [route.fromLine, route.toLine];
  // multi-transfer
  const lines: string[] = [];
  for (const { fromLine, toLine } of route.transfers) {
    if (!lines.includes(fromLine)) lines.push(fromLine);
    if (!lines.includes(toLine)) lines.push(toLine);
  }
  return lines;
}

/** trip route의 출발 노선 첫 waypoint 이름을 원본 역으로 추정한다. */
function extractOriginStation(trip: Trip): string | null {
  // #2280 — device가 등록 시점에 stamp한 SSOT 출발역명을 1순위로 채택. 이 필드가 없는(구 client)
  // 경우에만 passedStations[0]로 fallback — waypoints는 남은 경유지 배열이라 종료 시점에는
  // 비어 있을 수 있고, passedStations 역시 advance 이벤트가 한 번도 없던 trip(짧은 trip/조기
  // 종료)에서는 영구 undefined라 origin_station null 회귀의 원인이었다.
  const { originStationName, passedStations } = trip;
  if (originStationName) return originStationName;
  if (passedStations && passedStations.length > 0) return passedStations[0];
  return null;
}

/**
 * #2628 — station-passed/transfer/destination alert push가 실제로 발사(outcome='sent')된 횟수를
 * D1 `trip_events`(kind='cron-fire-attempt', `scheduled.ts` `recordFireAttempt`)에서 직접
 * COUNT한다. D1이 append-only SSoT라 POST /trips 재등록으로 trip KV 객체가 교체돼도 유실되지
 * 않는다(#2281의 trip 객체 카운터 방식이 갖던 근본 결함).
 *
 * `trip.createdAt`~`endedAt` window로 한정 — 같은 token이 이후 완전히 새 trip(다른 세션)으로
 * 재등록되면 `createdAt`이 바뀌므로 이전 trip의 fire-attempt와 섞이지 않는다.
 *
 * 범위 밖(#2281 감사 표 그대로 승계): boarding-prompt/hop-end-prompt 자체의 발사 횟수는
 * `fired_count`에 포함하지 않는다(alert push와 별개 신호) — `boarding_prompt_displayed` 컬럼이
 * boarding-prompt 발사 여부를 이미 담당한다.
 *
 * DB 조회 실패는 swallow하고 0을 반환 — 상위 `recordTripMetrics`의 INSERT 흐름을 막지 않는다.
 */
async function countSentFireAttempts(
  db: D1Database,
  tokenHash: string,
  startedAt: number,
  endedAt: number,
): Promise<number> {
  try {
    const result = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM trip_events
         WHERE token_hash = ? AND kind = 'cron-fire-attempt' AND ts >= ? AND ts <= ?
           AND json_extract(meta, '$.outcome') = 'sent'`,
      )
      .bind(tokenHash, startedAt, endedAt)
      .first<{ count: number }>();
    return result?.count ?? 0;
  } catch (e) {
    console.warn(
      JSON.stringify({ msg: 'd1TripMetrics fired_count query failed', err: String(e) }),
    );
    return 0;
  }
}

/**
 * chain complete 판정.
 * boardingPrompt 발사 + lock 부착 + destination-arrived 종료가 모두 있으면 chain 완성으로 본다.
 * reason은 호출 직전 외부에서 알 수 있으나, trip 객체만으로 판정 가능한 범위 내에서 처리.
 * 세부 기준은 Phase 2 follow-up에서 acceptance와 함께 정제 예정.
 */
function isChainComplete(trip: Trip): boolean {
  return Boolean(trip.boardingLock && trip.boardingPromptState?.fired);
}
