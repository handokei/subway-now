import { describe, expect, it, vi } from 'vitest';
import {
  ALARM_LOG_FORWARD_KEY_PREFIX,
  MAX_ENTRIES_PER_BUCKET,
  buildNdjsonBody,
  buildR2Key,
  storeAlarmLogForward,
  validateAlarmLogForward,
  type AlarmLogForwardUpload,
} from '../alarmLogForward';

function validBody(): Record<string, unknown> {
  return {
    token: 'aabbccdd11223344',
    tripStartedAt: Date.UTC(2026, 5, 20, 12, 0, 0),
    tripEndedAt: Date.UTC(2026, 5, 20, 12, 30, 0),
    alarmLog: [{ ts: 1, source: 'fg' }],
    fusionLog: [{ ts: 2, kind: 'cycle' }],
    // #1706 — fusion picker tier 별 ring buffer. alarmLog ring과 분리.
    fusionTierLog: [{ ts: 5, tier: 'gpsFallback' }],
    gpsDrops: [{ ts: 3, accuracy: 250 }],
    backendSsotSnapshot: { currentStationId: '강남', motionState: 'moving' },
    deviceMetadata: { os: 'ios', appVersion: '1.2.3', locale: 'ko' },
  };
}

describe('validateAlarmLogForward', () => {
  it('accepts valid payload', () => {
    const out = validateAlarmLogForward(validBody());
    expect(out).not.toBeNull();
    expect(out?.token).toBe('aabbccdd11223344');
    expect(out?.alarmLog.length).toBe(1);
    // #1706 — 별 ring buffer entries 보존.
    expect(out?.fusionTierLog.length).toBe(1);
    expect(out?.deviceMetadata.os).toBe('ios');
    expect(out?.deviceMetadata.appVersion).toBe('1.2.3');
    expect(out?.deviceMetadata.locale).toBe('ko');
  });

  it('#1706 — fusionTierLog 미설정(구 device 호환) 시 기본 [] 채워 accept', () => {
    const body = validBody();
    delete (body as Record<string, unknown>).fusionTierLog;
    const out = validateAlarmLogForward(body);
    expect(out).not.toBeNull();
    expect(out?.fusionTierLog).toEqual([]);
  });

  it('#1706 — fusionTierLog 비배열이면 reject', () => {
    expect(
      validateAlarmLogForward({ ...validBody(), fusionTierLog: 'x' }),
    ).toBeNull();
    expect(
      validateAlarmLogForward({ ...validBody(), fusionTierLog: {} }),
    ).toBeNull();
  });

  it('#1706 — fusionTierLog cap 초과 시 reject', () => {
    const tooMany = Array.from({ length: MAX_ENTRIES_PER_BUCKET + 1 }, (_, i) => ({ i }));
    expect(
      validateAlarmLogForward({ ...validBody(), fusionTierLog: tooMany }),
    ).toBeNull();
  });

  it('normalizes null ssot snapshot', () => {
    const out = validateAlarmLogForward({ ...validBody(), backendSsotSnapshot: null });
    expect(out?.backendSsotSnapshot).toBeNull();
  });

  it('strips non-string optional deviceMetadata fields', () => {
    const out = validateAlarmLogForward({
      ...validBody(),
      deviceMetadata: { os: 'ios', appVersion: 123, locale: null },
    });
    expect(out?.deviceMetadata.appVersion).toBeUndefined();
    expect(out?.deviceMetadata.locale).toBeUndefined();
  });

  it('rejects non-object input', () => {
    expect(validateAlarmLogForward(null)).toBeNull();
    expect(validateAlarmLogForward('x')).toBeNull();
    expect(validateAlarmLogForward(42)).toBeNull();
  });

  it('rejects empty token', () => {
    expect(validateAlarmLogForward({ ...validBody(), token: '' })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), token: 42 })).toBeNull();
  });

  it('rejects invalid tripStartedAt', () => {
    expect(validateAlarmLogForward({ ...validBody(), tripStartedAt: 0 })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), tripStartedAt: 'x' })).toBeNull();
  });

  it('rejects tripEndedAt before tripStartedAt', () => {
    expect(
      validateAlarmLogForward({ ...validBody(), tripEndedAt: 0 }),
    ).toBeNull();
  });

  it('rejects non-array alarmLog/fusionLog/gpsDrops', () => {
    expect(validateAlarmLogForward({ ...validBody(), alarmLog: 'x' })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), fusionLog: {} })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), gpsDrops: 5 })).toBeNull();
  });

  it('rejects entries above cap', () => {
    const tooMany = Array.from({ length: MAX_ENTRIES_PER_BUCKET + 1 }, (_, i) => ({ i }));
    expect(validateAlarmLogForward({ ...validBody(), alarmLog: tooMany })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), fusionLog: tooMany })).toBeNull();
    expect(validateAlarmLogForward({ ...validBody(), gpsDrops: tooMany })).toBeNull();
  });

  it('rejects missing/invalid deviceMetadata', () => {
    expect(
      validateAlarmLogForward({ ...validBody(), deviceMetadata: null }),
    ).toBeNull();
    expect(
      validateAlarmLogForward({ ...validBody(), deviceMetadata: { os: 5 } }),
    ).toBeNull();
  });
});

describe('buildR2Key', () => {
  it('uses YYYY/MM/DD partition + tokenPrefix + tripStartedAt', () => {
    const u = validateAlarmLogForward(validBody())!;
    const key = buildR2Key(u);
    expect(key.startsWith(ALARM_LOG_FORWARD_KEY_PREFIX)).toBe(true);
    expect(key).toContain('2026/06/20/');
    expect(key).toContain('aabbccdd-');
    expect(key.endsWith('.ndjson')).toBe(true);
  });

  it('pads month/day with leading zero', () => {
    const u = validateAlarmLogForward({
      ...validBody(),
      tripStartedAt: Date.UTC(2026, 0, 5, 0, 0, 0),
      tripEndedAt: Date.UTC(2026, 0, 5, 0, 1, 0),
    })!;
    expect(buildR2Key(u)).toContain('2026/01/05/');
  });
});

describe('buildNdjsonBody', () => {
  it('#1706 — emits 7 lines: header + alarmLog + fusionLog + fusionTierLog + gpsDrops + ssot + deviceMetadata', () => {
    const u = validateAlarmLogForward(validBody())!;
    const body = buildNdjsonBody(u);
    const lines = body.split('\n');
    expect(lines).toHaveLength(7);
    const header = JSON.parse(lines[0]);
    expect(header.kind).toBe('header');
    expect(header.tokenPrefix).toBe('aabbccdd');
    expect(header.durationMs).toBe(u.tripEndedAt - u.tripStartedAt);
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual([
      'header',
      'alarmLog',
      'fusionLog',
      'fusionTierLog',
      'gpsDrops',
      'backendSsotSnapshot',
      'deviceMetadata',
    ]);
  });

  it('#1706 — fusionTierLog 라인이 entries로 device snapshot 보존', () => {
    const u = validateAlarmLogForward(validBody())!;
    const body = buildNdjsonBody(u);
    const lines = body.split('\n').map((l) => JSON.parse(l));
    const tierLine = lines.find((l) => l.kind === 'fusionTierLog');
    expect(tierLine).toBeDefined();
    expect(tierLine.entries).toEqual([{ ts: 5, tier: 'gpsFallback' }]);
  });
});

describe('storeAlarmLogForward', () => {
  it('puts ndjson with customMetadata + contentType', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put } as unknown as R2Bucket;
    const u = validateAlarmLogForward(validBody())!;
    const result = await storeAlarmLogForward(r2, u);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, options] = put.mock.calls[0];
    expect(typeof key).toBe('string');
    expect(key).toContain('aabbccdd-');
    expect(typeof body).toBe('string');
    expect(options.httpMetadata.contentType).toBe('application/x-ndjson');
    expect(options.customMetadata.tokenPrefix).toBe('aabbccdd');
    expect(options.customMetadata.deviceOs).toBe('ios');
    expect(options.customMetadata.tripStartedAt).toBe(String(u.tripStartedAt));
    expect(result.key).toBe(key);
    expect(result.size).toBe(body.length);
  });
});

// Type smoke — keep the union exported for downstream consumers.
const _typeCheck: AlarmLogForwardUpload | null = null;
void _typeCheck;
