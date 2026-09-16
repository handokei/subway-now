/**
 * X6 acceptance — 도착 후 발사된 late alarm 0건.
 *
 * Source: ADR-017 X6.
 *
 * Late = alarm 발사 시각이 해당 target 도착 시각 이후.
 *   transfer-1-stop은 환승 도착 시각, destination-1-stop은 최종 도착 시각 기준.
 */

import { defineAcceptanceSuite } from '../runner';
import { extractAlarmEvents } from '../r2ArchiveAlign';

defineAcceptanceSuite('X6: 도착 후 fire 0건', ({ groundTruth, events }) => {
  if (!events) {
    expect(groundTruth.actualDestination.arrivedAt).toBeTruthy();
    return;
  }
  const transferAlarms = extractAlarmEvents(events, 'transfer-1-stop');
  transferAlarms.forEach((alarm, idx) => {
    const target = groundTruth.actualTransfers[idx];
    if (!target) return;
    expect(Date.parse(alarm.ts)).toBeLessThan(Date.parse(target.arrivedAt));
  });
  const destinationAlarms = extractAlarmEvents(events, 'destination-1-stop');
  destinationAlarms.forEach((alarm) => {
    expect(Date.parse(alarm.ts)).toBeLessThan(
      Date.parse(groundTruth.actualDestination.arrivedAt),
    );
  });
});
