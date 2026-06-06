/**
 * computeAndUploadTripRecall 통합 테스트 (#919).
 * - alarmLog 읽기 → recall 계산 → backend upload 의 wiring 검증.
 * - 동작 변경 없음: APNs token 없거나 recall 신호 0이면 graceful skip.
 */

const mockGetAlarmLog = jest.fn();
const mockUploadRecallTelemetry = jest.fn();
const mockUploadPrescheduledTelemetry = jest.fn();
const mockGetItem = jest.fn();
const mockComputePrescheduledMetrics = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
  },
}));

jest.mock('../alarmLog', () => ({
  getAlarmLog: (...args: unknown[]) => mockGetAlarmLog(...args),
}));

jest.mock('../../api/telemetryBackend', () => ({
  uploadRecallTelemetry: (...args: unknown[]) => mockUploadRecallTelemetry(...args),
  uploadPrescheduledTelemetry: (...args: unknown[]) =>
    mockUploadPrescheduledTelemetry(...args),
}));

jest.mock('../prescheduledMetrics', () => ({
  computePrescheduledMetrics: (...args: unknown[]) => mockComputePrescheduledMetrics(...args),
  isEmptyPrescheduledMetrics: (m: { scheduledCount: number }) => m.scheduledCount === 0,
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// import은 mock 등록 후.
import {
  computeAndUploadTripPrescheduled,
  computeAndUploadTripRecall,
} from '../alarmLogTelemetry';
import type { AlarmLogEntry } from '../alarmLog';

const fixedEntry = (
  partial: Partial<AlarmLogEntry> & Pick<AlarmLogEntry, 'ts' | 'source' | 'outcome'>,
): AlarmLogEntry => ({ ...partial });

const TRIP = {
  routeStops: ['A', 'B'],
  tripStart: 0,
  tripEnd: 1000,
};

describe('computeAndUploadTripRecall', () => {
  beforeEach(() => {
    mockGetAlarmLog.mockReset();
    mockUploadRecallTelemetry.mockReset();
    mockGetItem.mockReset();
  });

  it('APNs token 없으면 upload 호출 안 함 (graceful skip)', async () => {
    mockGetItem.mockResolvedValue(null);
    mockGetAlarmLog.mockResolvedValue([]);

    const result = await computeAndUploadTripRecall(TRIP);

    expect(mockUploadRecallTelemetry).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBe('no-token');
  });

  it('recall 신호 0이면 upload 호출 안 함 (분모/분포 모두 비어있음)', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([]);

    const result = await computeAndUploadTripRecall({
      routeStops: [],
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(mockUploadRecallTelemetry).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBe('empty');
  });

  it('정상 흐름 — alarmLog 읽고 recall 계산해서 upload', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([
      fixedEntry({ ts: 100, source: 'fg-evaluated', outcome: 'fired', kind: 'station-passed', stationName: 'A' }),
    ]);
    mockUploadRecallTelemetry.mockResolvedValue({ ok: true, status: 200 });

    const result = await computeAndUploadTripRecall(TRIP);

    expect(mockUploadRecallTelemetry).toHaveBeenCalledTimes(1);
    const [token, payload] = mockUploadRecallTelemetry.mock.calls[0];
    expect(token).toBe('apns-token');
    expect(payload.expectedStops).toBe(2);
    expect(payload.firedStops).toBe(1);
    expect(payload.recallPct).toBe(50);
    expect(result.uploaded).toBe(true);
  });

  it('upload 실패해도 호출자에게 throw 안 함 (graceful)', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([
      fixedEntry({ ts: 100, source: 'fg-evaluated', outcome: 'fired', kind: 'station-passed', stationName: 'A' }),
    ]);
    mockUploadRecallTelemetry.mockResolvedValue({ ok: false, status: 500 });

    const result = await computeAndUploadTripRecall(TRIP);

    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBeUndefined();
  });

  it('alarmLog read 실패해도 호출자에게 throw 안 함 (graceful)', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockRejectedValue(new Error('storage fail'));

    const result = await computeAndUploadTripRecall(TRIP);

    expect(mockUploadRecallTelemetry).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBe('error');
  });

  it('tripEnd 미지정 시 Date.now() 사용', async () => {
    const NOW = 999_999;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([
      fixedEntry({ ts: 100, source: 'fg-evaluated', outcome: 'fired', kind: 'station-passed', stationName: 'A' }),
    ]);
    mockUploadRecallTelemetry.mockResolvedValue({ ok: true, status: 200 });

    const result = await computeAndUploadTripRecall({
      routeStops: ['A'],
      tripStart: 0,
      // tripEnd 의도적 생략
    });

    expect(result.uploaded).toBe(true);
    const [, payload] = mockUploadRecallTelemetry.mock.calls[0];
    expect(payload.tripEnd).toBe(NOW);
    (Date.now as jest.Mock).mockRestore();
  });

  it('AsyncStorage getItem 실패해도 graceful skip', async () => {
    mockGetItem.mockRejectedValue(new Error('storage fail'));

    const result = await computeAndUploadTripRecall(TRIP);

    expect(mockUploadRecallTelemetry).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBe('error');
  });
});

describe('computeAndUploadTripPrescheduled', () => {
  beforeEach(() => {
    mockGetAlarmLog.mockReset();
    mockUploadPrescheduledTelemetry.mockReset();
    mockGetItem.mockReset();
    mockComputePrescheduledMetrics.mockReset();
  });

  it('APNs token 없으면 upload 호출 안 함 (graceful skip)', async () => {
    mockGetItem.mockResolvedValue(null);

    const result = await computeAndUploadTripPrescheduled({ tripStart: 0 });

    expect(mockUploadPrescheduledTelemetry).not.toHaveBeenCalled();
    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBe('no-token');
  });

  it('ledger 비어있어 scheduledCount=0이면 upload 호출 안 함 (empty)', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([]);
    mockComputePrescheduledMetrics.mockResolvedValue({
      tripStart: 0,
      tripEnd: 1000,
      scheduledCount: 0,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });

    const result = await computeAndUploadTripPrescheduled({ tripStart: 0 });

    expect(mockUploadPrescheduledTelemetry).not.toHaveBeenCalled();
    expect(result.skipped).toBe('empty');
  });

  it('정상 흐름 — alarmLog fired stationName 집합 + ledger 계산 → upload', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([
      fixedEntry({
        ts: 100,
        source: 'fg-evaluated',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: 'A',
      }),
      fixedEntry({
        ts: 200,
        source: 'bg-scheduled',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: 'B',
      }),
    ]);
    mockComputePrescheduledMetrics.mockResolvedValue({
      tripStart: 0,
      tripEnd: 1000,
      scheduledCount: 3,
      firedCount: 2,
      stationAccurateCount: 2,
      fireDeltaSamplesMs: [5, 10],
    });
    mockUploadPrescheduledTelemetry.mockResolvedValue({ ok: true, status: 200 });

    const result = await computeAndUploadTripPrescheduled({ tripStart: 0 });

    expect(mockUploadPrescheduledTelemetry).toHaveBeenCalledTimes(1);
    const [, metrics] = mockUploadPrescheduledTelemetry.mock.calls[0];
    expect(metrics.scheduledCount).toBe(3);
    expect(result.uploaded).toBe(true);

    // computePrescheduledMetrics이 firedStationNames Set으로 호출됐는지 확인
    const callArg = mockComputePrescheduledMetrics.mock.calls[0][0];
    expect(callArg.firedStationNames.has('A')).toBe(true);
    expect(callArg.firedStationNames.has('B')).toBe(true);
  });

  it('윈도우 밖 fired/suppressed entry는 firedStationNames에 포함 안 함', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([
      // tripStart=0 이하 (exclusive) → 제외
      fixedEntry({
        ts: 0,
        source: 'fg-evaluated',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: 'OutBefore',
      }),
      // tripEnd 이후 → 제외
      fixedEntry({
        ts: 5000,
        source: 'fg-evaluated',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: 'OutAfter',
      }),
      // outcome=suppressed → 제외
      fixedEntry({
        ts: 100,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        kind: 'station-passed',
        stationName: 'Suppressed',
      }),
      // stationName 없음 → 제외
      fixedEntry({ ts: 200, source: 'fg-evaluated', outcome: 'fired' }),
      // 정상
      fixedEntry({
        ts: 300,
        source: 'fg-evaluated',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: 'In',
      }),
    ]);
    mockComputePrescheduledMetrics.mockResolvedValue({
      tripStart: 0,
      tripEnd: 1000,
      scheduledCount: 1,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    mockUploadPrescheduledTelemetry.mockResolvedValue({ ok: true, status: 200 });

    await computeAndUploadTripPrescheduled({ tripStart: 0, tripEnd: 1000 });

    const callArg = mockComputePrescheduledMetrics.mock.calls[0][0];
    expect([...callArg.firedStationNames]).toEqual(['In']);
  });

  it('upload 실패해도 throw 안 함', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([]);
    mockComputePrescheduledMetrics.mockResolvedValue({
      tripStart: 0,
      tripEnd: 1000,
      scheduledCount: 1,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    mockUploadPrescheduledTelemetry.mockResolvedValue({ ok: false, status: 500 });

    const result = await computeAndUploadTripPrescheduled({ tripStart: 0 });

    expect(result.uploaded).toBe(false);
    expect(result.skipped).toBeUndefined();
  });

  it('alarmLog read 실패 시 graceful error', async () => {
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockRejectedValue(new Error('fail'));

    const result = await computeAndUploadTripPrescheduled({ tripStart: 0 });

    expect(mockUploadPrescheduledTelemetry).not.toHaveBeenCalled();
    expect(result.skipped).toBe('error');
  });

  it('tripEnd 미지정 시 Date.now() 사용', async () => {
    const NOW = 999_999;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockGetItem.mockResolvedValue('apns-token');
    mockGetAlarmLog.mockResolvedValue([]);
    mockComputePrescheduledMetrics.mockResolvedValue({
      tripStart: 0,
      tripEnd: NOW,
      scheduledCount: 1,
      firedCount: 0,
      stationAccurateCount: 0,
      fireDeltaSamplesMs: [],
    });
    mockUploadPrescheduledTelemetry.mockResolvedValue({ ok: true, status: 200 });

    await computeAndUploadTripPrescheduled({ tripStart: 0 });

    const callArg = mockComputePrescheduledMetrics.mock.calls[0][0];
    expect(callArg.tripEnd).toBe(NOW);
    (Date.now as jest.Mock).mockRestore();
  });
});
