import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildDeviceMetadata,
  forwardTripTelemetry,
  MIN_TRIP_DURATION_MS,
  type TelemetryForwardPayload,
} from '../telemetryForward';
import { TELEMETRY_FORWARD_RETRY_QUEUE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const TEST_URL = 'https://api.test/';

function basePayload(over: Partial<TelemetryForwardPayload> = {}): TelemetryForwardPayload {
  const tripStartedAt = 1_000_000;
  return {
    token: 'aabbccdd11223344',
    tripStartedAt,
    tripEndedAt: tripStartedAt + MIN_TRIP_DURATION_MS + 1,
    alarmLog: [{ ts: 1 }],
    fusionLog: [{ ts: 2 }],
    // #1706 — fusion picker tier 별 ring buffer. alarmLog ring 점령 회귀 차단 채널.
    fusionTierLog: [{ ts: 4, tier: 'gpsFallback' }],
    gpsDrops: [{ ts: 3 }],
    backendSsotSnapshot: { currentStationId: '강남' },
    deviceMetadata: { os: 'ios', appVersion: '1.2.3', locale: 'ko' },
    ...over,
  };
}

function setBackend(fetchResult?: { ok: boolean; status?: number } | Error): void {
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = TEST_URL;
  if (fetchResult instanceof Error) {
    (globalThis.fetch as jest.Mock).mockRejectedValue(fetchResult);
  } else if (fetchResult) {
    (globalThis.fetch as jest.Mock).mockResolvedValue(fetchResult);
  }
}

describe('forwardTripTelemetry', () => {
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true (no-url) + fetch 호출 안 함', async () => {
    const result = await forwardTripTelemetry(basePayload());
    expect(result).toEqual({ ok: false, skipped: true, skipReason: 'no-url' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token이면 skipped=true (no-token)', async () => {
    setBackend();
    const result = await forwardTripTelemetry(basePayload({ token: '' }));
    expect(result.skipReason).toBe('no-token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('30s 미만 trip은 skipped=true (trip-too-short)', async () => {
    setBackend();
    const ts = 1_000_000;
    const result = await forwardTripTelemetry(
      basePayload({ tripStartedAt: ts, tripEndedAt: ts + MIN_TRIP_DURATION_MS - 1 }),
    );
    expect(result.skipReason).toBe('trip-too-short');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('tripStartedAt <=0 이면 skipped=true (no-tripStart)', async () => {
    setBackend();
    const result = await forwardTripTelemetry(basePayload({ tripStartedAt: 0 }));
    expect(result.skipReason).toBe('no-tripStart');
  });

  it('payload 빈 (모든 buffer 비고 ssot null) 시 skipped=true (empty-payload)', async () => {
    setBackend();
    const result = await forwardTripTelemetry(
      basePayload({
        alarmLog: [],
        fusionLog: [],
        fusionTierLog: [],
        gpsDrops: [],
        backendSsotSnapshot: null,
      }),
    );
    expect(result.skipReason).toBe('empty-payload');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('#1706 — fusionTierLog만 단독 적재돼도 forward (empty-payload 아님)', async () => {
    setBackend({ ok: true, status: 200 });
    const result = await forwardTripTelemetry(
      basePayload({
        alarmLog: [],
        fusionLog: [],
        fusionTierLog: [{ ts: 1, tier: 'gpsFallback' }],
        gpsDrops: [],
        backendSsotSnapshot: null,
      }),
    );
    expect(result.ok).toBe(true);
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    // 별 채널로 분리됐는지 검증 — alarmLog ring과 같은 line에 섞이지 않는다.
    expect(body.fusionTierLog).toEqual([{ ts: 1, tier: 'gpsFallback' }]);
    expect(body.alarmLog).toEqual([]);
  });

  it('#1706 — alarmLog/fusionLog/fusionTierLog 동시 forward 시 별 line으로 분리', async () => {
    setBackend({ ok: true, status: 200 });
    await forwardTripTelemetry(
      basePayload({
        alarmLog: [{ ts: 10, source: 'silent-push-received' }],
        fusionLog: [{ ts: 20 }],
        fusionTierLog: [{ ts: 30, tier: 'backendSsotAccepts' }],
      }),
    );
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.alarmLog).toEqual([{ ts: 10, source: 'silent-push-received' }]);
    expect(body.fusionLog).toEqual([{ ts: 20 }]);
    expect(body.fusionTierLog).toEqual([{ ts: 30, tier: 'backendSsotAccepts' }]);
  });

  it('성공 시 ok=true + outbox 비움', async () => {
    setBackend({ ok: true, status: 200 });
    const result = await forwardTripTelemetry(basePayload());
    expect(result).toEqual({ ok: true, status: 200 });
    expect(await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY)).toBeNull();

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${TEST_URL}telemetry/alarm-log`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('aabbccdd11223344');
    expect(body.alarmLog.length).toBe(1);
    expect(body.deviceMetadata.os).toBe('ios');
  });

  it('실패 시 outbox에 enqueue', async () => {
    setBackend({ ok: false, status: 500 });
    const payload = basePayload();
    const result = await forwardTripTelemetry(payload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    const outboxRaw = await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY);
    expect(outboxRaw).not.toBeNull();
    const stored = JSON.parse(outboxRaw ?? '');
    expect(stored.payload.token).toBe(payload.token);
    expect(stored.payload.alarmLog.length).toBe(1);
  });

  it('fetch throw 시 ok=false + outbox 보존', async () => {
    setBackend(new Error('network'));
    const result = await forwardTripTelemetry(basePayload());
    expect(result).toEqual({ ok: false });
    expect(await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY)).not.toBeNull();
  });

  it('outbox에 직전 retry 항목이 있으면 신규 forward 전에 flush 시도', async () => {
    // 두 번째 호출(신규) 성공 + 첫 번째 호출(retry) 성공
    setBackend({ ok: true, status: 200 });
    const prev = basePayload({ tripStartedAt: 500_000, tripEndedAt: 600_000 });
    await AsyncStorage.setItem(
      TELEMETRY_FORWARD_RETRY_QUEUE_KEY,
      JSON.stringify({ payload: prev }),
    );

    const result = await forwardTripTelemetry(basePayload());
    expect(result.ok).toBe(true);
    // 1) outbox flush 2) 신규 forward
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(2);
    // 두 호출 모두 outbox clear 했어야 함 (마지막 성공이 최종 상태).
    expect(await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY)).toBeNull();
  });

  it('outbox flush 실패해도 신규 forward는 진행', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = TEST_URL;
    // 두 번 호출: 1번째(flush) 실패, 2번째(신규) 성공.
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const prev = basePayload({ tripStartedAt: 500_000, tripEndedAt: 600_000 });
    await AsyncStorage.setItem(
      TELEMETRY_FORWARD_RETRY_QUEUE_KEY,
      JSON.stringify({ payload: prev }),
    );

    const result = await forwardTripTelemetry(basePayload());
    expect(result.ok).toBe(true);
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(2);
    // 신규 forward 성공 시 outbox clear.
    expect(await AsyncStorage.getItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY)).toBeNull();
  });

  it('손상된 outbox JSON은 graceful skip (flush 시도 안 함)', async () => {
    setBackend({ ok: true, status: 200 });
    await AsyncStorage.setItem(TELEMETRY_FORWARD_RETRY_QUEUE_KEY, 'not-json{');
    const result = await forwardTripTelemetry(basePayload());
    expect(result.ok).toBe(true);
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('shape mismatch outbox는 무시', async () => {
    setBackend({ ok: true, status: 200 });
    await AsyncStorage.setItem(
      TELEMETRY_FORWARD_RETRY_QUEUE_KEY,
      JSON.stringify({ payload: { token: 5 } }),
    );
    const result = await forwardTripTelemetry(basePayload());
    expect(result.ok).toBe(true);
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });
});

describe('outbox storage error 흡수', () => {
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
    await AsyncStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it('writeOutbox 실패해도 caller 흐름은 계속 (graceful)', async () => {
    setBackend({ ok: false, status: 500 });
    const spy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockRejectedValue(new Error('storage full'));
    try {
      const result = await forwardTripTelemetry(basePayload());
      expect(result.ok).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('clearOutbox 실패해도 caller 흐름은 계속 (graceful)', async () => {
    setBackend({ ok: true, status: 200 });
    const spy = jest
      .spyOn(AsyncStorage, 'removeItem')
      .mockRejectedValue(new Error('storage'));
    try {
      const result = await forwardTripTelemetry(basePayload());
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('readOutbox JSON parse 실패는 graceful skip', async () => {
    setBackend({ ok: true, status: 200 });
    const spy = jest
      .spyOn(AsyncStorage, 'getItem')
      .mockRejectedValueOnce(new Error('read fail'));
    try {
      const result = await forwardTripTelemetry(basePayload());
      expect(result.ok).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('buildDeviceMetadata', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('수집 기본값 — os 항상 set, optional은 환경값 있으면 포함', () => {
    const meta = buildDeviceMetadata();
    expect(['ios', 'android', 'unknown']).toContain(meta.os);
  });

  it('expoConfig.version + i18n.language 둘 다 있으면 포함', () => {
    jest.isolateModules(() => {
      jest.doMock('expo-constants', () => ({
        __esModule: true,
        default: { expoConfig: { version: '9.9.9' } },
      }));
      jest.doMock('i18next', () => ({ __esModule: true, default: { language: 'ko' } }));
      const { buildDeviceMetadata: build } = require('../telemetryForward');
      const meta = build();
      expect(meta.appVersion).toBe('9.9.9');
      expect(meta.locale).toBe('ko');
    });
  });

  it('알 수 없는 OS는 unknown으로 fallback', () => {
    const { Platform } = require('react-native');
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const meta = buildDeviceMetadata();
      expect(meta.os).toBe('unknown');
    } finally {
      Platform.OS = originalOS;
    }
  });

  it('expoConfig 자체가 null이면 appVersion + locale 미포함', () => {
    jest.isolateModules(() => {
      jest.doMock('expo-constants', () => ({
        __esModule: true,
        default: { expoConfig: null },
      }));
      jest.doMock('i18next', () => ({ __esModule: true, default: { language: '' } }));
      const { buildDeviceMetadata: build } = require('../telemetryForward');
      const meta = build();
      expect(meta.appVersion).toBeUndefined();
      expect(meta.locale).toBeUndefined();
    });
  });

  it('expoConfig.version 부재 시 appVersion 미포함', () => {
    jest.isolateModules(() => {
      jest.doMock('expo-constants', () => ({
        __esModule: true,
        default: { expoConfig: {} },
      }));
      // i18n.language도 동시에 빈 값으로 → locale도 미포함 (한 번에 두 분기 커버).
      jest.doMock('i18next', () => ({
        __esModule: true,
        default: { language: '' },
      }));
      const { buildDeviceMetadata: build } = require('../telemetryForward');
      const meta = build();
      expect(meta.appVersion).toBeUndefined();
      expect(meta.locale).toBeUndefined();
    });
  });
});
