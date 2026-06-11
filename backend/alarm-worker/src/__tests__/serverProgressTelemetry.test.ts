import { describe, expect, it, vi } from 'vitest';
import {
  recordServerProgressUpload,
  validateServerProgressUpload,
  type ServerProgressUpload,
} from '../serverProgressTelemetry';
import { METRIC_KIND, MIN_SERVER_PROGRESS_RECEIVED_RATIO } from '../metrics';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    windowStart: 1_000,
    windowEnd: 2_000,
    attempts: 10,
    received: 9,
  };
}

describe('validateServerProgressUpload', () => {
  it('accepts a valid payload', () => {
    const result = validateServerProgressUpload(base());
    expect(result).not.toBeNull();
    expect(result?.attempts).toBe(10);
    expect(result?.received).toBe(9);
  });

  it.each([
    ['null', null],
    ['string', 'x'],
  ])('rejects non-object (%s)', (_label, value) => {
    expect(validateServerProgressUpload(value)).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validateServerProgressUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validateServerProgressUpload(noToken)).toBeNull();
  });

  it.each([
    ['windowStart', Number.NaN],
    ['windowStart', 'x'],
    ['windowEnd', Number.NaN],
    ['windowEnd', 'x'],
  ])('rejects non-finite %s (%p)', (field, value) => {
    expect(validateServerProgressUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects windowEnd < windowStart', () => {
    expect(
      validateServerProgressUpload({ ...base(), windowStart: 2_000, windowEnd: 1_000 }),
    ).toBeNull();
  });

  it.each([
    ['attempts', -1],
    ['attempts', 1.5],
    ['attempts', Number.NaN],
    ['attempts', 'x'],
    ['received', -1],
    ['received', 1.5],
  ])('rejects non-natural %s (%p)', (field, value) => {
    expect(validateServerProgressUpload({ ...base(), [field]: value })).toBeNull();
  });

  it('rejects received > attempts', () => {
    expect(
      validateServerProgressUpload({ ...base(), attempts: 2, received: 3 }),
    ).toBeNull();
  });

  it('accepts attempts=0, received=0 (idle window — caller decides whether to upload)', () => {
    const result = validateServerProgressUpload({ ...base(), attempts: 0, received: 0 });
    expect(result).not.toBeNull();
    expect(result?.attempts).toBe(0);
  });
});

describe('recordServerProgressUpload', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  it('writes hit + total data points for non-zero rate', () => {
    const writer = makeWriter();
    const payload: ServerProgressUpload = {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      attempts: 10,
      received: 9,
    };
    recordServerProgressUpload(writer, payload);
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(2);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain(`phase3:${METRIC_KIND.SERVER_PROGRESS_RECEIVED}:hit`);
    expect(labels).toContain(`phase3:${METRIC_KIND.SERVER_PROGRESS_RECEIVED}:total`);
  });

  it('skips zero-hit point (writes only total)', () => {
    const writer = makeWriter();
    recordServerProgressUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      attempts: 10,
      received: 0,
    });
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writer.writeDataPoint.mock.calls[0][0].blobs[0]).toBe(
      `phase3:${METRIC_KIND.SERVER_PROGRESS_RECEIVED}:total`,
    );
  });

  it('skips both points when attempts=0 (idle window — no noise)', () => {
    const writer = makeWriter();
    recordServerProgressUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      attempts: 0,
      received: 0,
    });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });

  it('uses 8-char token prefix for anonymous aggregate', () => {
    const writer = makeWriter();
    recordServerProgressUpload(writer, {
      token: 'aabbccdd11223344',
      windowStart: 0,
      windowEnd: 1_000,
      attempts: 1,
      received: 1,
    });
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[1]).toBe('aabbccdd');
    expect(first.indexes[0]).toBe('aabbccdd');
  });
});

describe('MIN_SERVER_PROGRESS_RECEIVED_RATIO (catalog SSOT)', () => {
  it('matches the B5 95% upgrade gate threshold (catalog default)', () => {
    expect(MIN_SERVER_PROGRESS_RECEIVED_RATIO).toBe(0.95);
  });

  it('is a valid ratio (0 < x <= 1)', () => {
    expect(MIN_SERVER_PROGRESS_RECEIVED_RATIO).toBeGreaterThan(0);
    expect(MIN_SERVER_PROGRESS_RECEIVED_RATIO).toBeLessThanOrEqual(1);
  });
});
