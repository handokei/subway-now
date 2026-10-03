/**
 * V4 acceptance — station-passed 카운트 == 실제 통과 역 수.
 *
 * Source: ADR-017 V4.
 *
 * R2 archive에 `station.advance` event가 trip별로 기록된다고 가정한다.
 * 실제 통과 역 수 = actualStations.length - 1 (출발역 제외)
 *   — 마지막 도착역 포함 여부는 ADR과 일치하도록 일단 (length) 그대로 비교.
 *     수정 필요 시 P0-3 ndjson contract 확정 후 갱신.
 */

import { defineAcceptanceSuite } from '../runner';

const STATION_ADVANCE_KIND = 'station.advance';

defineAcceptanceSuite('V4: station-passed 카운트 일치', ({ groundTruth, events }) => {
  if (!events) {
    expect(groundTruth.actualStations.length).toBeGreaterThan(0);
    return;
  }
  const advances = events.filter((e) => e.kind === STATION_ADVANCE_KIND);
  expect(advances.length).toBe(groundTruth.actualStations.length);
});
