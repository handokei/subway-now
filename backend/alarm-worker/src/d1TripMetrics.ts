/**
 * D1 trip_metrics 테이블 적재 helper (#1835, Phase 2).
 *
 * trip 종료 시 `cleanupTripWithLa` (liveActivity.ts) 에서 호출한다.
 * `env.DB` 미바인딩 시 graceful no-op.
 *
 * 적재 실패는 trip cleanup 흐름을 차단하지 않는다 (내부 try/catch로 swallow).
 */

import { hashTripToken } from './sentry';
import type { BoardingPromptState, Trip } from './types';

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
        // #2281 — hop-end/boarding prompt가 trip.hopEndPromptState / trip.boardingPromptState에
        // 이미 남기는 per-trip fireCount를 집계. 기존 컬럼(fired_count) 재사용 — 스키마 변경 없음.
        computeFiredCount(trip),
        0, // suppressed_count: 동상
        boardingPromptState?.fired ? 1 : 0,
        0, // boarding_prompt_responded: 현재 Trip 타입에 responded 필드 없음 — Phase 2 follow-up에서 추가
        boardingLock ? 1 : 0,
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
 * #2281 — trip 전체에서 실제 발사된 prompt 수를 집계한다.
 *
 * 대상: boarding-prompt(`trip.boardingPromptState`) + hop-end prompt(`trip.hopEndPromptState`,
 * leg별 dedup key로 여러 개 존재 가능) — 둘 다 사용자에게 응답을 요구하는 alert push이자, trip
 * 객체에 이미 per-trip 발사 상태(`fireCount`/`fired`)를 갖고 있어 새 스키마 없이 집계 가능하다.
 *
 * 범위 밖(전수 감사, PR 본문 표 참조): intermediate/transfer/destination 알림, reschedule,
 * lockless-intermediate, sleep-alarm companion, vanish release/fallback, train-reconfirm push는
 * cron 단위(`ScheduledStats`) 집계만 있고 trip 객체에 영속 상태가 없다 — 포함하려면 Trip 스키마에
 * 새 필드를 추가해야 해 이번 최소 변경 범위를 벗어난다(follow-up 후보).
 */
function computeFiredCount(trip: Trip): number {
  const boardingFired = countPromptFires(trip.boardingPromptState);
  const hopEndFired = Object.values(trip.hopEndPromptState ?? {}).reduce(
    (sum, state) => sum + countPromptFires(state),
    0,
  );
  return boardingFired + hopEndFired;
}

/** 단일 `BoardingPromptState`의 발사 횟수. `fireCount`(반복 발사 지원) 우선, 없으면 `fired` boolean. */
function countPromptFires(state: BoardingPromptState | undefined): number {
  if (state?.fireCount !== undefined) return state.fireCount;
  return state?.fired ? 1 : 0;
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
