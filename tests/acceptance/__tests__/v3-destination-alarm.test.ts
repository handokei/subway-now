/**
 * V3 acceptance — destination alarm 1회, ±10s.
 *
 * Source: ADR-017 V3.
 */

import { defineAcceptanceSuite } from '../runner';
import { extractAlarmEvents, oneStopBefore } from '../r2ArchiveAlign';

const DESTINATION_ALARM_TYPE = 'destination-1-stop';
const TOLERANCE_MILLIS = 10_000;

defineAcceptanceSuite('V3: destination alarm 1회, ±10s', ({ groundTruth, events }) => {
  if (!events) {
    expect(groundTruth.actualDestination.stationId.length).toBeGreaterThan(0);
    return;
  }
  const fired = extractAlarmEvents(events, DESTINATION_ALARM_TYPE);
  expect(fired.length).toBe(1);
  const drift = Math.abs(
    Date.parse(fired[0].ts) - oneStopBefore(groundTruth.actualDestination.arrivedAt),
  );
  expect(drift).toBeLessThanOrEqual(TOLERANCE_MILLIS);
});
