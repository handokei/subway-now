/**
 * Cloudflare Analytics Engine writer — Phase 0 측정 인프라 (Epic #1576 / P0-1 #1577).
 *
 * V/X acceptance (ADR-017 / ADR-016)를 SQL로 직접 검증하기 위해 advance / fire / suppress /
 * motion-transition / position-upload / trip-mutation 6 event를 시계열 적재한다.
 *
 * Binding은 `wrangler.toml`의 `[[analytics_engine_datasets]]`로 주입 (binding=`TRIP_METRICS`,
 * dataset=`trip_metrics`). 미바인딩 시 `writeMetric`은 graceful no-op — 개발/테스트 환경 호환.
 *
 * `writeDataPoint`는 fire-and-forget이라 `await`/`ctx.waitUntil` 불필요 (기존 TELEMETRY 패턴 동일).
 */

import type { AnalyticsEngineWriter, Env } from './types';

/**
 * 6 event type — `eventType` blob dimension으로 적재.
 *
 *  - `advance`          : `advanceTripPosition`이 SSoT를 advance (게이트 통과)
 *  - `fire`             : station-passed / transfer-imminent silent push 발사 성공
 *  - `suppress`         : advance blocked / fire dedup / cross-station dedup
 *  - `motion-transition`: SSoT motionState 전환 (moving ↔ stationary ↔ unknown)
 *  - `position-upload`  : POST `/position` 수신 (V8a 적재 카운터)
 *  - `trip-mutation`    : POST `/trips` 수신 (V8b 적재 카운터)
 */
export type TripMetricEventType =
  | 'advance'
  | 'fire'
  | 'suppress'
  | 'motion-transition'
  | 'position-upload'
  | 'trip-mutation';

/**
 * 적재 event shape. `tripToken`은 index, dimensions는 blob, metrics는 double로 매핑된다.
 * Token은 dedup/그룹핑용 — privacy를 위해 적재 시 8자 prefix만 forward 한다.
 */
export interface TripMetricEvent {
  eventType: TripMetricEventType;
  tripToken: string;
  /** advance/fire/suppress 대상 station identifier (id 또는 표시명). */
  stationId?: string;
  /** suppress reason / fire kind / advance evidence type 등. */
  reason?: string;
  /** ADR-015 환경 vote 결과 (advance/suppress 입력 컨텍스트). */
  environment?: 'surface' | 'underground' | 'hybrid' | 'unknown';
  /** SSoT `lastAdvanceAt`에서 본 event까지 경과 ms (X3 stale fire 검증). */
  staleMs?: number;
  /** waypoint hop index (V/X hop-level 집계용). */
  hopIndex?: number;
  /** consensus / motion confidence 0~1 (event 결정 근거 강도). */
  motionConfidence?: number;
}

/**
 * Analytics Engine 적재 helper. binding 미바인딩 시 no-op.
 *
 * Token은 prefix만 forward — full token은 적재하지 않는다 (telemetry 모듈과 동일 정책).
 */
export function writeMetric(env: Env, event: TripMetricEvent): void {
  const writer: AnalyticsEngineWriter | undefined = env.TRIP_METRICS;
  if (!writer) return;

  const blobs: string[] = [event.eventType];
  if (event.stationId !== undefined) blobs.push(`station:${event.stationId}`);
  if (event.reason !== undefined) blobs.push(`reason:${event.reason}`);
  if (event.environment !== undefined) blobs.push(`env:${event.environment}`);

  const doubles: number[] = [];
  if (event.staleMs !== undefined) doubles.push(event.staleMs);
  if (event.hopIndex !== undefined) doubles.push(event.hopIndex);
  if (event.motionConfidence !== undefined) doubles.push(event.motionConfidence);

  // tokenPrefix(8자)만 index로 — 같은 trip의 event 집계는 가능, full token은 노출 안 함.
  const tokenIndex = event.tripToken.slice(0, 8);

  writer.writeDataPoint({
    blobs,
    doubles,
    indexes: [tokenIndex],
  });
}
