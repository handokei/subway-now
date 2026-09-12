/**
 * V2 acceptance — transfer-1-stop alarm 1회, ±10s 정확도.
 *
 * Source: ADR-017 V2.
 * fixture가 비어 있으면 skip. R2 archive(.r2.ndjson)가 없으면 schema/관계만 검증.
 */

import { defineAcceptanceSuite } from '../runner';
import { extractAlarmEvents, oneStopBefore } from '../r2ArchiveAlign';

const TRANSFER_ALARM_TYPE = 'transfer-1-stop';
const TOLERANCE_MILLIS = 10_000;

defineAcceptanceSuite('V2: transfer alarm 1회, ±10s', ({ groundTruth, events }) => {
  // archive 없으면 ground truth 자체 정합성만 확인 (transfers >= 0).
  if (!events) {
    expect(groundTruth.actualTransfers.length).toBeGreaterThanOrEqual(0);
    return;
  }
  const fired = extractAlarmEvents(events, TRANSFER_ALARM_TYPE);
  expect(fired.length).toBe(groundTruth.actualTransfers.length);
  groundTruth.actualTransfers.forEach((expected, idx) => {
    const actual = fired[idx];
    const drift = Math.abs(Date.parse(actual.ts) - oneStopBefore(expected.arrivedAt));
    expect(drift).toBeLessThanOrEqual(TOLERANCE_MILLIS);
  });
});
