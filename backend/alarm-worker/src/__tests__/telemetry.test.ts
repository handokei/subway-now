import { describe, expect, it, vi } from 'vitest';
import {
  tokenPrefix,
  validateTelemetryUpload,
  writeTelemetryDataPoints,
  type TelemetryUpload,
} from '../telemetry';

function base(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    since: 1_000,
    until: 2_000,
    received: 5,
    fired: 3,
    skipped: 2,
    skipReasons: {
      'gate-out-of-range': 1,
      'payload-missing-kind': 1,
    },
  };
}

describe('validateTelemetryUpload', () => {
  it('accepts a valid payload', () => {
    const result = validateTelemetryUpload(base());
    expect(result).not.toBeNull();
    expect(result?.received).toBe(5);
    expect(result?.skipReasons['gate-out-of-range']).toBe(1);
  });

  it('rejects non-object', () => {
    expect(validateTelemetryUpload(null)).toBeNull();
    expect(validateTelemetryUpload('x')).toBeNull();
  });

  it('rejects missing/empty token', () => {
    expect(validateTelemetryUpload({ ...base(), token: '' })).toBeNull();
    const noToken = base();
    delete noToken.token;
    expect(validateTelemetryUpload(noToken)).toBeNull();
  });

  it('rejects non-integer / negative counters', () => {
    expect(validateTelemetryUpload({ ...base(), received: -1 })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), received: 1.5 })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), received: NaN })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), received: 'x' })).toBeNull();
  });

  it('rejects when each counter field invalid', () => {
    expect(validateTelemetryUpload({ ...base(), since: -1 })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), until: -1 })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), fired: -1 })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), skipped: -1 })).toBeNull();
  });

  it('rejects when until < since', () => {
    expect(validateTelemetryUpload({ ...base(), since: 2000, until: 1000 })).toBeNull();
  });

  it('rejects when skipReasons is missing or wrong type', () => {
    const missing = base();
    delete missing.skipReasons;
    expect(validateTelemetryUpload(missing)).toBeNull();
    expect(validateTelemetryUpload({ ...base(), skipReasons: 'x' })).toBeNull();
    expect(validateTelemetryUpload({ ...base(), skipReasons: null })).toBeNull();
  });

  it('rejects invalid skipReasons value', () => {
    expect(
      validateTelemetryUpload({ ...base(), skipReasons: { 'gate-out-of-range': -1 } }),
    ).toBeNull();
    expect(
      validateTelemetryUpload({ ...base(), skipReasons: { 'gate-out-of-range': 1.5 } }),
    ).toBeNull();
  });

  it('drops unknown skipReason keys', () => {
    const result = validateTelemetryUpload({
      ...base(),
      skipReasons: { 'gate-out-of-range': 1, 'unknown-reason': 99 },
    });
    expect(result?.skipReasons['gate-out-of-range']).toBe(1);
    expect(result?.skipReasons['unknown-reason']).toBeUndefined();
  });

  it('preserves missing known reasons as absent (not zero)', () => {
    const result = validateTelemetryUpload({ ...base(), skipReasons: {} });
    expect(result?.skipReasons).toEqual({});
  });
});

describe('tokenPrefix', () => {
  it('returns first 8 chars', () => {
    expect(tokenPrefix('aabbccdd11223344')).toBe('aabbccdd');
  });

  it('returns whole string when shorter than 8', () => {
    expect(tokenPrefix('abc')).toBe('abc');
  });
});

describe('writeTelemetryDataPoints', () => {
  function makeWriter() {
    return { writeDataPoint: vi.fn() };
  }

  const payload: TelemetryUpload = {
    token: 'aabbccdd11223344',
    since: 0,
    until: 1,
    received: 5,
    fired: 3,
    skipped: 2,
    skipReasons: {
      'gate-out-of-range': 1,
      'payload-missing-kind': 1,
    },
  };

  it('writes one data point per non-zero counter', () => {
    const writer = makeWriter();
    writeTelemetryDataPoints(writer, payload);
    // received + fired + skipped + 2 reasons = 5
    expect(writer.writeDataPoint).toHaveBeenCalledTimes(5);
    const labels = writer.writeDataPoint.mock.calls.map((c) => c[0].blobs[0]);
    expect(labels).toContain('received');
    expect(labels).toContain('fired');
    expect(labels).toContain('skipped');
    expect(labels).toContain('skipped:gate-out-of-range');
    expect(labels).toContain('skipped:payload-missing-kind');
  });

  it('skips zero counters', () => {
    const writer = makeWriter();
    writeTelemetryDataPoints(writer, {
      ...payload,
      received: 0,
      fired: 0,
      skipped: 0,
      skipReasons: {},
    });
    expect(writer.writeDataPoint).not.toHaveBeenCalled();
  });

  it('includes token prefix in blobs and indexes', () => {
    const writer = makeWriter();
    writeTelemetryDataPoints(writer, payload);
    const first = writer.writeDataPoint.mock.calls[0][0];
    expect(first.blobs[1]).toBe('aabbccdd');
    expect(first.indexes[0]).toBe('aabbccdd');
    expect(first.doubles[0]).toBeGreaterThan(0);
  });
});
