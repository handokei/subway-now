/**
 * X3 acceptance — stale fire 0건.
 *
 * Source: ADR-017 X3.
 *
 * "stale fire" 정의: alarm 발사 시각이 ground truth 도착 시각보다 30s 이상 늦은 경우.
 * 모든 알람 종류(transfer/destination/...)에 대해 검사.
 */

import { defineAcceptanceSuite } from '../runner';
import { extractAlarmEvents } from '../r2ArchiveAlign';

const STALE_THRESHOLD_MILLIS = 30_000;

defineAcceptanceSuite('X3: stale fire 0건', ({ groundTruth, events }) => {
  if (!events) {
    expect(groundTruth.tripEndedAt).toBeTruthy();
    return;
  }
  const fired = extractAlarmEvents(events);
  const referenceArrivals: number[] = [
    ...groundTruth.actualStations.map((s) => Date.parse(s.arrivedAt)),
    ...groundTruth.actualTransfers.map((t) => Date.parse(t.arrivedAt)),
    Date.parse(groundTruth.actualDestination.arrivedAt),
  ];
  const latestArrival = Math.max(...referenceArrivals);
  fired.forEach((alarm) => {
    const drift = Date.parse(alarm.ts) - latestArrival;
    expect(drift).toBeLessThanOrEqual(STALE_THRESHOLD_MILLIS);
  });
});
