/**
 * D1 trip_metrics 테이블 적재 helper (#1835, Phase 2).
 *
 * trip 종료 시 `cleanupTripWithLa` (liveActivity.ts) 에서 호출한다.
 * `env.DB` 미바인딩 시 graceful no-op.
 *
 * 적재 실패는 trip cleanup 흐름을 차단하지 않는다 (내부 try/catch로 swallow).
 */

import { hashTripToken } from './sentry';
import type { Trip, TripEndedReason } from './types';

/**
 * trip_metrics 에 trip 종료 기록을 적재한다.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param trip - 종료된 trip 객체.
 * @param reason - 종료 사유. undefined = 사용자 명시 DELETE (HTTP DELETE /trips/:token).
 * @param endedAt - 종료 epoch ms.
 */
export async function recordTripMetrics(
  db: D1Database | undefined,
  trip: Trip,
  reason: TripEndedReason | undefined,
  endedAt: number,
): Promise<void> {
  if (!db) return;
  try {
    const tokenHash = hashTripToken(trip.token);
    const { boardingPromptState, boardingLock } = trip;

    const lineList = extractLineList(trip);
    const chainComplete = isChainComplete(trip);

    await db
      .prepare(
        `INSERT INTO trip_metrics (
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
        0, // fired_count: 현재 trip 객체에 누적 카운터 없음 — Phase 2 follow-up에서 추가
        0, // suppressed_count: 동상
        boardingPromptState?.fired ? 1 : 0,
        boardingPromptState?.fired && boardingPromptState.silencedUntil === undefined ? 0 : 0, // responded 여부: 현재 필드 없음, Phase 2 follow-up
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
  // waypoints는 남은 경유지 배열. 종료 시점에는 비어 있을 수 있어 passedStations 활용.
  const { passedStations } = trip;
  if (passedStations && passedStations.length > 0) return passedStations[0];
  return null;
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
