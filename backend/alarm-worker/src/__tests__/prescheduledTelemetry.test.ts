import { describe, expect, it, vi } from 'vitest';
import {
  recordPrescheduledUpload,
  validatePrescheduledUpload,
  type PrescheduledUpload,
} from '../prescheduledTelemetry';
import { METRIC_KIND } from '../metrics';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    tripStart: 1_000,
    tripEnd: 2_000,
    scheduledCount: 5,
    firedCount: 4,
    stationAccurateCount: 3,
    fireDeltaSamplesMs: [10, -5, 0, 100],
  };
}

describe('validatePrescheduledUpload', () => {
  it('accepts valid payload', () => {
    const result = validatePrescheduledUpload(base());
    expect(result).not.toBeNull();
    expect(result?.scheduledCount).toBe(5);
    expect(result?.firedCount).toBe(4);
    expect(result?.stationAccurateCount).toBe(3);
    expect(result?.fireDeltaSamplesMs).toEqual([10, -5, 0, 100]);
  });

  it('rejects non-object', () => {
    expect(validatePrescheduledUpload(null)).toBeNull();
    expect(validatePrescheduledUpload('x')).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validatePrescheduledUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validatePrescheduledUpload(noToken)).toBeNull();
  });

  it.each([
    ['tripStart', Number.NaN],
    ['tripStart', 'x'],
    ['tripEnd', Number.NaN],
    ['tripEnd', 'x'],
  ])('rejects non-finite %s (%p)', (field, value) => {
    expect(validatePrescheduledUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects tripEnd < tripStart', () => {
    expect(
      validatePrescheduledUpload({ ...base(), tripStart: 2_000, tripEnd: 1_000 }),
    ).toBeNull();
  });

  it.each([
    ['scheduledCount', -1],
    ['scheduledCount', 1.5],
    ['firedCount', -1],
    ['stationAccurateCount', -1],
  ])('rejects non-natural %s (%p)', (field, value) => {
    expect(validatePrescheduledUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects firedCount > scheduledCount', () => {
    expect(
      validatePrescheduledUpload({
        ...base(),
        scheduledCount: 2,
        firedCount: 3,
        stationAccurateCount: 2,
        fireDeltaSamplesMs: [1, 2, 3],
      }),
    ).toBeNull();
  });

  it('rejects stationAccurateCount > firedCount', () => {
    expect(
      validatePrescheduledUpload({
        ...base(),
        scheduledCount: 5,
        firedCount: 2,
        stationAccurateCount: 3,
        fireDeltaSamplesMs: [1, 2],
      }),
    ).toBeNull();
  });

  it('rejects non-array fireDeltaSamplesMs', () => {
    expect(
      validatePrescheduledUpload({ ...base(), fireDeltaSamplesMs: 'x' }),
    ).toBeNull();
  });

  it('rejects non-finite sample in array', () => {
    expect(
      validatePrescheduledUpload({ ...base(), fireDeltaSamplesMs: [1, Number.NaN, 2] }),
    ).toBeNull();
    expect(
      validatePrescheduledUpload({ ...base(), fireDeltaSamplesMs: [1, 'x', 2] }),
    ).toBeNull();
  });

  it('rejects sample length != firedCount', () => {
    expect(
      validatePrescheduledUpload({
        ...base(),
        firedCount: 4,
        fireDeltaSamplesMs: [1, 2, 3], // length=3, firedCount=4
      }),
    ).toBeNull();
  });

  it('accepts empty samples when firedCount=0', () => {
    const result = validatePrescheduledUpload({
      ...base(),
      scheduledCount: 5,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    expect(result).not.toBeNull();
    expect(result?.firedCount).toBe(0);
  });

  it('accepts scheduledCount=0 corner case', () => {
    const result = validatePrescheduledUpload({
      ...base(),
      scheduledCount: 0,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    expect(result?.scheduledCount).toBe(0);
  });
});

function makeWriter() {
  return { writeDataPoint: vi.fn() };
}

describe('recordPrescheduledUpload', () => {
  const payload: PrescheduledUpload = {
    token: 'aabbccdd11223344',
    tripStart: 0,
    tripEnd: 1_000,
    scheduledCount: 10,
    firedCount: 8,
    stationAccurateCount: 7,
    fireDeltaSamplesMs: [5, 10, 15, 20, 25, 30, 35, 40],
  };

  it('writes miss rate + accuracy rate + histogram metrics', () => {
    const writer = makeWriter();
    recordPrescheduledUpload(writer, payload);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0] as string);
    // miss rate: hit=2, total=10
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_MISS_RATE}:hit`);
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_MISS_RATE}:total`);
    // accuracy rate: hit=7, total=8
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_STATION_ACCURACY}:hit`);
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_STATION_ACCURACY}:total`);
    // histogram: count, mean, p95
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS}:count`);
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS}:mean`);
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS}:p95`);
  });

  it('skips accuracy rate when firedCount=0', () => {
    const writer = makeWriter();
    recordPrescheduledUpload(writer, {
      ...payload,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0] as string);
    expect(labels).not.toContain(`phase3:${METRIC_KIND.PRESCHEDULED_STATION_ACCURACY}:hit`);
    expect(labels).not.toContain(`phase3:${METRIC_KIND.PRESCHEDULED_STATION_ACCURACY}:total`);
    // miss rate (scheduledCount=10-0=10 missed) 그대로
    expect(labels).toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_MISS_RATE}:hit`);
  });

  it('skips histogram when samples empty', () => {
    const writer = makeWriter();
    recordPrescheduledUpload(writer, {
      ...payload,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0] as string);
    expect(labels).not.toContain(`phase3:${METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS}:count`);
  });

  it('uses 8-char token prefix in blob2/indexes', () => {
    const writer = makeWriter();
    recordPrescheduledUpload(writer, payload);
    const anyCall = writer.writeDataPoint.mock.calls[0][0];
    expect(anyCall.blobs[1]).toBe('aabbccdd');
    expect(anyCall.indexes[0]).toBe('aabbccdd');
  });

  it('skips writes entirely when scheduledCount=0 + firedCount=0', () => {
    const writer = makeWriter();
    recordPrescheduledUpload(writer, {
      ...payload,
      scheduledCount: 0,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    // 0 hit + 0 total miss rate → writeMetricDataPoints가 0값을 skip → 적재 0건
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });
});

describe('catalog SSOT', () => {
  it('exposes prescheduled metric kinds', () => {
    expect(METRIC_KIND.PRESCHEDULED_FIRE_MISS_RATE).toBe('prescheduledFireMissRate');
    expect(METRIC_KIND.PRESCHEDULED_STATION_ACCURACY).toBe('prescheduledStationAccuracy');
    expect(METRIC_KIND.PRESCHEDULED_FIRE_DELTA_MS).toBe('prescheduledFireDeltaMs');
  });
});
