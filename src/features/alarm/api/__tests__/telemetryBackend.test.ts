import {
  uploadPrescheduledTelemetry,
  uploadRecallTelemetry,
  uploadSilentPushTelemetry,
} from '../telemetryBackend';
import type { SilentPushTelemetryPayload } from '../../utils/telemetryAggregation';
import type { TripRecallResult } from '../../utils/recallMetrics';
import type { PrescheduledMetricsResult } from '../../utils/prescheduledMetrics';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;

const PAYLOAD: SilentPushTelemetryPayload = {
  since: 0,
  until: 1_000,
  received: 3,
  fired: 2,
  skipped: 1,
  skipReasons: { 'gate-out-of-range': 1 },
};

describe('uploadSilentPushTelemetry', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await uploadSilentPushTelemetry('token', PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token도 skipped=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadSilentPushTelemetry('', PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true, body 직렬화 확인', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/silent-push');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tok');
    expect(body.received).toBe(3);
    expect(body.skipReasons).toEqual({ 'gate-out-of-range': 1 });
  });

  it('!res.ok 응답 시 ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('fetch throw 시 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const result = await uploadSilentPushTelemetry('tok', PAYLOAD);
    expect(result).toEqual({ ok: false });
  });

  it('타임아웃 발동 시 abort → ok=false', async () => {
    jest.useFakeTimers();
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const promise = uploadSilentPushTelemetry('tok', PAYLOAD);
    await jest.advanceTimersByTimeAsync(6000);
    const result = await promise;
    expect(result).toEqual({ ok: false });
    jest.useRealTimers();
  });
});

const RECALL_PAYLOAD: TripRecallResult = {
  tripStart: 0,
  tripEnd: 1_000,
  expectedStops: 3,
  firedStops: 2,
  recallPct: 67,
  gateSuppressionCounts: { 'movement-static-speed': 1 },
};

describe('uploadRecallTelemetry', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await uploadRecallTelemetry('token', RECALL_PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token도 skipped=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadRecallTelemetry('', RECALL_PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true, body 직렬화 확인', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadRecallTelemetry('tok', RECALL_PAYLOAD);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/recall');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tok');
    expect(body.expectedStops).toBe(3);
    expect(body.firedStops).toBe(2);
    expect(body.recallPct).toBe(67);
    expect(body.gateSuppressionCounts).toEqual({ 'movement-static-speed': 1 });
  });

  it('!res.ok 응답 시 ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const result = await uploadRecallTelemetry('tok', RECALL_PAYLOAD);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('fetch throw 시 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const result = await uploadRecallTelemetry('tok', RECALL_PAYLOAD);
    expect(result).toEqual({ ok: false });
  });
});

const PRESCHEDULED_PAYLOAD: PrescheduledMetricsResult = {
  tripStart: 0,
  tripEnd: 1_000,
  scheduledCount: 5,
  firedCount: 4,
  stationAccurateCount: 3,
  fireDeltaSamplesMs: [10, -5, 0, 100],
};

describe('uploadPrescheduledTelemetry', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('URL 미설정이면 skipped=true', async () => {
    const result = await uploadPrescheduledTelemetry('token', PRESCHEDULED_PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('빈 token도 skipped=true', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    const result = await uploadPrescheduledTelemetry('', PRESCHEDULED_PAYLOAD);
    expect(result).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 응답 시 ok=true, body 직렬화 확인', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadPrescheduledTelemetry('tok', PRESCHEDULED_PAYLOAD);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test/telemetry/prescheduled');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tok');
    expect(body.scheduledCount).toBe(5);
    expect(body.firedCount).toBe(4);
    expect(body.stationAccurateCount).toBe(3);
    expect(body.fireDeltaSamplesMs).toEqual([10, -5, 0, 100]);
  });

  it('!res.ok 응답 시 ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const result = await uploadPrescheduledTelemetry('tok', PRESCHEDULED_PAYLOAD);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('fetch throw 시 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const result = await uploadPrescheduledTelemetry('tok', PRESCHEDULED_PAYLOAD);
    expect(result).toEqual({ ok: false });
  });

  // #986 — missContext optional 인자.
  it('missContext 미전달 시 body에 missContext 필드 미포함', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    await uploadPrescheduledTelemetry('tok', PRESCHEDULED_PAYLOAD);
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect('missContext' in body).toBe(false);
  });

  it('missContext 전달 시 body에 그대로 포함', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const missContext = {
      lockedTrainCode: '5050',
      lockedAt: 50,
      missedIdentifiers: ['tba:early:강남'],
    };
    await uploadPrescheduledTelemetry('tok', PRESCHEDULED_PAYLOAD, missContext);
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.missContext).toEqual(missContext);
  });
});
