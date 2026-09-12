/**
 * triggerTripEndRecall — trip-end recall trigger 통합 테스트 (#919).
 *
 * AsyncStorage / computeAndUploadTripRecall / computeRouteArc / getTripStartedAt 을 mock하여
 * trigger의 순서 + idempotency + graceful 분기를 검증한다.
 */

const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockComputeAndUploadTripRecall = jest.fn();
const mockComputeAndUploadTripPrescheduled = jest.fn();
const mockComputeRouteArc = jest.fn();
const mockGetTripStartedAt = jest.fn();
const mockFlushRegressionCounters = jest.fn();
const mockUploadSignalDump = jest.fn();
const mockGetCurrentTripCorrIdSync = jest.fn();
const mockGetCurrentTripCorrId = jest.fn();
const mockGetRawSignalEntries = jest.fn();
const mockForwardTripTelemetry = jest.fn();
const mockBuildDeviceMetadata = jest.fn();
const mockGetAlarmLog = jest.fn();
// #1706 — fusion picker tier 별 ring buffer reader mock.
const mockGetFusionTierLog = jest.fn();
const mockGetFusionDebugEntries = jest.fn();
const mockGetGpsDropEntries = jest.fn();
const mockReadBackendSsotMirror = jest.fn();
// #1972 — lockless trip-end stamp dependencies.
const mockLogLocklessTripEnd = jest.fn();
const mockCountFiredAlarms = jest.fn();
const mockBoardingLockGetState = jest.fn();
const mockUserIntentGetState = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: (...args: unknown[]) => mockSetItem(...args),
  },
}));

jest.mock('../alarmLogTelemetry', () => ({
  computeAndUploadTripRecall: (...args: unknown[]) => mockComputeAndUploadTripRecall(...args),
  computeAndUploadTripPrescheduled: (...args: unknown[]) =>
    mockComputeAndUploadTripPrescheduled(...args),
}));

jest.mock('../../../route/utils/routeProgress', () => ({
  computeRouteArc: (...args: unknown[]) => mockComputeRouteArc(...args),
}));

jest.mock('../tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../../../shared/utils/regressionMetrics', () => ({
  flushRegressionCounters: (...args: unknown[]) => mockFlushRegressionCounters(...args),
}));

jest.mock('../../api/signalDumpBackend', () => ({
  uploadSignalDump: (...args: unknown[]) => mockUploadSignalDump(...args),
}));

jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: (...args: unknown[]) => mockGetCurrentTripCorrIdSync(...args),
  getCurrentTripCorrId: (...args: unknown[]) => mockGetCurrentTripCorrId(...args),
}));

jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  getRawSignalEntries: (...args: unknown[]) => mockGetRawSignalEntries(...args),
}));

jest.mock('../../api/telemetryForward', () => ({
  forwardTripTelemetry: (...args: unknown[]) => mockForwardTripTelemetry(...args),
  buildDeviceMetadata: (...args: unknown[]) => mockBuildDeviceMetadata(...args),
}));

jest.mock('../alarmLog', () => ({
  getAlarmLog: (...args: unknown[]) => mockGetAlarmLog(...args),
  // #1706 — 별 ring reader. test가 명시적으로 entries 주입.
  getFusionTierLog: (...args: unknown[]) => mockGetFusionTierLog(...args),
  // #1972 — lockless trip 분기 stamp + fire counter.
  logLocklessTripEnd: (...args: unknown[]) => mockLogLocklessTripEnd(...args),
  countFiredAlarms: (...args: unknown[]) => mockCountFiredAlarms(...args),
}));

jest.mock('../../store/useBoardingLockStore', () => ({
  useBoardingLockStore: {
    getState: () => mockBoardingLockGetState(),
  },
}));

jest.mock('../../store/useUserIntentStore', () => ({
  useUserIntentStore: {
    getState: () => mockUserIntentGetState(),
  },
}));

jest.mock('../../../nearest-station/utils/fusionDebugBuffer', () => ({
  getFusionDebugEntries: (...args: unknown[]) => mockGetFusionDebugEntries(...args),
}));

jest.mock('../../../nearest-station/utils/gpsDropBuffer', () => ({
  getGpsDropEntries: (...args: unknown[]) => mockGetGpsDropEntries(...args),
}));

jest.mock('../backendSsotMirror', () => ({
  readBackendSsotMirror: (...args: unknown[]) => mockReadBackendSsotMirror(...args),
}));

import {
  triggerTripEndRecall,
  _resetTripEndRecallGuardForTests,
} from '../triggerTripEndRecall';
import {
  APNS_TOKEN_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
  TRIP_ORIGIN_KEY,
  LAST_UPLOADED_RECALL_TRIP_START_KEY,
  LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY,
} from '../../../../shared/constants/storageKeys';

const ROUTE_JSON = JSON.stringify({ type: 'direct', line: '2', stops: 3, travelSeconds: 300 });
const ORIGIN_JSON = JSON.stringify({ id: 'o', name: 'Origin', line: '2', lat: 0, lng: 0 });
const DEST_JSON = JSON.stringify({ id: 'd', name: 'Dest', line: '2', lat: 0, lng: 0 });

function setStorage(map: Record<string, string | null>): void {
  mockGetItem.mockImplementation((key: string) =>
    Promise.resolve(map[key] !== undefined ? map[key] : null),
  );
}

const ROUTE_ARC_STATIONS = [
  { id: 'o', name: 'Origin', line: '2', lat: 0, lng: 0 },
  { id: 'm', name: 'Mid', line: '2', lat: 0, lng: 0 },
  { id: 'd', name: 'Dest', line: '2', lat: 0, lng: 0 },
];

function setupHappyPath(): void {
  mockGetTripStartedAt.mockResolvedValue(100);
  setStorage({
    [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
    [ROUTE_KEY]: ROUTE_JSON,
    [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
    [DESTINATION_KEY]: DEST_JSON,
    [APNS_TOKEN_KEY]: 'apns-token-xyz',
  });
  mockComputeRouteArc.mockReturnValue({
    stations: ROUTE_ARC_STATIONS,
    arcM: [0, 1, 2],
    totalLengthM: 2,
  });
  mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
  mockSetItem.mockResolvedValue(undefined);
}

describe('triggerTripEndRecall', () => {
  beforeEach(() => {
    // #2129 — in-memory 동시 호출 가드 초기화. tripStart 값을 여러 it 블록이 재사용하므로
    // 매 테스트 시작 전 리셋하지 않으면 두 번째 이후 호출이 'duplicate'로 오탐된다.
    _resetTripEndRecallGuardForTests();
    mockGetItem.mockReset();
    mockSetItem.mockReset();
    mockComputeAndUploadTripRecall.mockReset();
    mockComputeAndUploadTripPrescheduled.mockReset();
    mockComputeAndUploadTripPrescheduled.mockResolvedValue({ uploaded: false });
    mockComputeRouteArc.mockReset();
    mockGetTripStartedAt.mockReset();
    mockFlushRegressionCounters.mockReset();
    mockFlushRegressionCounters.mockResolvedValue(undefined);
    mockUploadSignalDump.mockReset();
    mockUploadSignalDump.mockResolvedValue({ ok: true });
    mockGetCurrentTripCorrIdSync.mockReset();
    mockGetCurrentTripCorrIdSync.mockReturnValue(null);
    mockGetCurrentTripCorrId.mockReset();
    mockGetCurrentTripCorrId.mockResolvedValue(null);
    mockGetRawSignalEntries.mockReset();
    mockGetRawSignalEntries.mockReturnValue([]);
    mockForwardTripTelemetry.mockReset();
    mockForwardTripTelemetry.mockResolvedValue({ ok: true });
    mockBuildDeviceMetadata.mockReset();
    mockBuildDeviceMetadata.mockReturnValue({ os: 'ios' });
    mockGetAlarmLog.mockReset();
    mockGetAlarmLog.mockResolvedValue([]);
    mockGetFusionTierLog.mockReset();
    mockGetFusionTierLog.mockReturnValue([]);
    mockGetFusionDebugEntries.mockReset();
    mockGetFusionDebugEntries.mockReturnValue([]);
    mockGetGpsDropEntries.mockReset();
    mockGetGpsDropEntries.mockReturnValue([]);
    mockReadBackendSsotMirror.mockReset();
    mockReadBackendSsotMirror.mockResolvedValue(null);
    // #1972 — lockless stamp defaults: lockless trip (lock=null) + infoModeEnabled=false +
    // fireCount=0 → paradigm intent stamp.
    mockLogLocklessTripEnd.mockReset();
    mockCountFiredAlarms.mockReset();
    mockCountFiredAlarms.mockReturnValue(0);
    mockBoardingLockGetState.mockReset();
    mockBoardingLockGetState.mockReturnValue({ lock: null });
    mockUserIntentGetState.mockReset();
    mockUserIntentGetState.mockReturnValue({ infoModeEnabled: false });
  });

  it('tripStart 부재 시 즉시 skip (no-trip-start)', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'no-trip-start' });
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
  });

  // #1928 F-E1 — tripStart 부재 fallback. 9h+ force-end / silent push trip-ended
  // 단독 경로에서 alarmLog 윈도우는 살아있을 수 있으므로 24h backstop forward 발사.
  it('#1928 F-E1 — tripStart 부재 시 24h backstop forward 발사 (alarmLog 회복 critical path)', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);
    setStorage({ [APNS_TOKEN_KEY]: 'apns-token-xyz' });
    mockGetAlarmLog.mockResolvedValue([{ ts: 1, source: 'fg' }]);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'no-trip-start' });
    expect(mockForwardTripTelemetry).toHaveBeenCalledTimes(1);
    const payload = mockForwardTripTelemetry.mock.calls[0][0];
    // 24h backstop = now - 24h
    expect(payload.tripStartedAt).toBe(2_000_000_000_000 - 24 * 60 * 60 * 1000);
    nowSpy.mockRestore();
  });

  it('idempotency — 같은 tripStart 로 이미 upload 됐으면 skip (duplicate)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({ [LAST_UPLOADED_RECALL_TRIP_START_KEY]: '100' });

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'duplicate' });
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
  });

  // #2129 — 18:05 hydration storm evidence: 여러 독립 호출자(force-end 경로)가 같은 trip에 대해
  // 거의 동시에 triggerTripEndRecall을 호출하면, AsyncStorage 기반 duplicate 체크만으로는
  // read-then-write async window에서 race가 발생해 3중 실행됐다. 동기 in-memory 가드로 차단.
  it('#2129 — 동일 tripStart 동시 호출 2건 → 1건만 실제 실행, 나머지는 duplicate skip', async () => {
    setupHappyPath();

    const [resultA, resultB] = await Promise.all([
      triggerTripEndRecall(),
      triggerTripEndRecall(),
    ]);

    // 둘 중 정확히 하나만 실제로 upload/stamp 경로를 탔다.
    const results = [resultA, resultB];
    const duplicates = results.filter((r) => r.skipped === 'duplicate');
    const executed = results.filter((r) => r.skipped !== 'duplicate');
    expect(duplicates).toHaveLength(1);
    expect(executed).toHaveLength(1);
    expect(mockComputeAndUploadTripRecall).toHaveBeenCalledTimes(1);
    expect(mockLogLocklessTripEnd).toHaveBeenCalledTimes(1);
  });

  it('#2129 — 다른 tripStart의 동시 호출은 서로 차단하지 않는다', async () => {
    setupHappyPath();
    // 두 번째 호출은 다른 tripStart를 갖도록 순차 mock 전환.
    mockGetTripStartedAt
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(200);

    await Promise.all([triggerTripEndRecall(), triggerTripEndRecall()]);

    expect(mockComputeAndUploadTripRecall).toHaveBeenCalledTimes(2);
  });

  it('route/origin/destination 누락 시 skip (route-arc-failed)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: null, // 누락
      [DESTINATION_KEY]: DEST_JSON,
    });

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'route-arc-failed' });
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
  });

  it('JSON parse 실패 시 skip (route-arc-failed)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: '{invalid json',
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'route-arc-failed' });
  });

  it('computeRouteArc null 반환 시 skip (route-arc-failed)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue(null);

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'route-arc-failed' });
  });

  // #1928 F-E2 — ROUTE_KEY race(HomeScreen.tsx:464 parallel removeItem) fallback.
  // recall은 skip이 맞지만 alarmLog forward는 R2 dashboard 회복 critical path.
  it('#1928 F-E2 — routeStops null + token 존재 시 forward(tripStart) 호출 (recall skip / forward 발사)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: null, // ROUTE_KEY race 시뮬레이션
      [DESTINATION_KEY]: DEST_JSON,
      [APNS_TOKEN_KEY]: 'apns-token-xyz',
    });
    mockGetAlarmLog.mockResolvedValue([{ ts: 1, source: 'fg' }]);

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'route-arc-failed' });
    // recall은 skip
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
    // forward는 발사 (tripStart=100 그대로)
    expect(mockForwardTripTelemetry).toHaveBeenCalledTimes(1);
    expect(mockForwardTripTelemetry.mock.calls[0][0].tripStartedAt).toBe(100);
  });

  it('정상 흐름 — routeStops 이름 배열을 computeAndUploadTripRecall 에 전달 + 성공 시 LAST_UPLOADED 기록', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({ stations: ROUTE_ARC_STATIONS, arcM: [0, 1, 2], totalLengthM: 2 });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockSetItem.mockResolvedValue(undefined);

    const result = await triggerTripEndRecall();

    expect(mockComputeAndUploadTripRecall).toHaveBeenCalledWith({
      routeStops: ['Origin', 'Mid', 'Dest'],
      tripStart: 100,
    });
    expect(mockSetItem).toHaveBeenCalledWith(LAST_UPLOADED_RECALL_TRIP_START_KEY, '100');
    expect(result).toEqual({ uploaded: true });
  });

  it('uploaded=false 면 LAST_UPLOADED 기록 안 함 (idempotency 차단 방지)', async () => {
    // backend 실패 등으로 uploaded=false 면 다음 trigger에서 재시도 가능해야 함.
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({ stations: ROUTE_ARC_STATIONS, arcM: [0, 1, 2], totalLengthM: 2 });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: false, skipped: 'empty' });

    const result = await triggerTripEndRecall();

    expect(mockSetItem).not.toHaveBeenCalled();
    expect(result).toEqual({ uploaded: false });
  });

  it('예외 발생 시 graceful skip (error) — throw 안 함', async () => {
    mockGetTripStartedAt.mockRejectedValue(new Error('boom'));

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'error' });
  });

  it('#918 — prescheduled 트리거 호출: uploaded=true 시 LAST_UPLOADED_PRESCHEDULED 기록', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockComputeAndUploadTripPrescheduled.mockResolvedValue({ uploaded: true });
    mockSetItem.mockResolvedValue(undefined);

    await triggerTripEndRecall();

    expect(mockComputeAndUploadTripPrescheduled).toHaveBeenCalledWith({ tripStart: 100 });
    expect(mockSetItem).toHaveBeenCalledWith(LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY, '100');
  });

  it('#918 — prescheduled uploaded=false면 LAST_UPLOADED_PRESCHEDULED 기록 안 함', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockComputeAndUploadTripPrescheduled.mockResolvedValue({ uploaded: false, skipped: 'empty' });
    mockSetItem.mockResolvedValue(undefined);

    await triggerTripEndRecall();

    const presetCalls = mockSetItem.mock.calls.filter(
      (c) => c[0] === LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY,
    );
    expect(presetCalls).toHaveLength(0);
  });

  it('#918 — prescheduled 마커가 같은 tripStart면 trigger skip (중복 차단)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY]: '100',
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });

    await triggerTripEndRecall();

    expect(mockComputeAndUploadTripPrescheduled).not.toHaveBeenCalled();
  });

  it('#918 — prescheduled trigger 예외도 흡수 (recall 결과는 영향 없음)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockComputeAndUploadTripPrescheduled.mockRejectedValue(new Error('boom'));

    const result = await triggerTripEndRecall();
    expect(result.uploaded).toBe(true); // recall 성공 영향 없음
  });

  it('LAST_UPLOADED 값이 다른 tripStart면 정상 upload 진행', async () => {
    mockGetTripStartedAt.mockResolvedValue(200);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: '100', // 이전 trip
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
    });
    mockComputeRouteArc.mockReturnValue({ stations: ROUTE_ARC_STATIONS, arcM: [0, 1, 2], totalLengthM: 2 });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockSetItem.mockResolvedValue(undefined);

    const result = await triggerTripEndRecall();

    expect(mockComputeAndUploadTripRecall).toHaveBeenCalled();
    expect(mockSetItem).toHaveBeenCalledWith(LAST_UPLOADED_RECALL_TRIP_START_KEY, '200');
    expect(result).toEqual({ uploaded: true });
  });

  it('#1267 — APNS token 존재 시 flushRegressionCounters(token) 호출', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
      [APNS_TOKEN_KEY]: 'apns-token-xyz',
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockSetItem.mockResolvedValue(undefined);

    await triggerTripEndRecall();

    expect(mockFlushRegressionCounters).toHaveBeenCalledWith('apns-token-xyz');
  });

  it('#1267 — APNS token 부재 시 flushRegressionCounters 호출 없이 graceful skip', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
      [APNS_TOKEN_KEY]: null,
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockSetItem.mockResolvedValue(undefined);

    await triggerTripEndRecall();

    expect(mockFlushRegressionCounters).not.toHaveBeenCalled();
  });

  it('#1267 — flushRegressionCounters 예외도 흡수 (recall 결과는 영향 없음)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({
      [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
      [ROUTE_KEY]: ROUTE_JSON,
      [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
      [DESTINATION_KEY]: DEST_JSON,
      [APNS_TOKEN_KEY]: 'apns-token-xyz',
    });
    mockComputeRouteArc.mockReturnValue({
      stations: ROUTE_ARC_STATIONS,
      arcM: [0, 1, 2],
      totalLengthM: 2,
    });
    mockComputeAndUploadTripRecall.mockResolvedValue({ uploaded: true });
    mockFlushRegressionCounters.mockRejectedValue(new Error('boom'));
    mockSetItem.mockResolvedValue(undefined);

    const result = await triggerTripEndRecall();
    expect(result.uploaded).toBe(true); // recall 성공 영향 없음
  });

  describe('#1520 — signal dump upload', () => {
    it('corrId(sync) + token + entries 정상 시 uploadSignalDump 호출', async () => {
      setupHappyPath();
      mockGetCurrentTripCorrIdSync.mockReturnValue('1700000000000-deadbeef');
      const entries = [{ ts: 1, kind: 'cycle' }];
      mockGetRawSignalEntries.mockReturnValue(entries);

      await triggerTripEndRecall();

      expect(mockUploadSignalDump).toHaveBeenCalledWith(
        '1700000000000-deadbeef',
        'apns-token-xyz',
        entries,
      );
      // sync hit으로 async getCurrentTripCorrId는 호출 안 됨.
      expect(mockGetCurrentTripCorrId).not.toHaveBeenCalled();
    });

    it('sync 부재 시 storage hydrate fallback 사용', async () => {
      setupHappyPath();
      mockGetCurrentTripCorrIdSync.mockReturnValue(null);
      mockGetCurrentTripCorrId.mockResolvedValue('1700000000000-deadbeef');
      mockGetRawSignalEntries.mockReturnValue([{ ts: 1, kind: 'cycle' }]);

      await triggerTripEndRecall();

      expect(mockGetCurrentTripCorrId).toHaveBeenCalled();
      expect(mockUploadSignalDump).toHaveBeenCalled();
    });

    it('corrId 부재 시 upload skip', async () => {
      setupHappyPath();
      mockGetCurrentTripCorrIdSync.mockReturnValue(null);
      mockGetCurrentTripCorrId.mockResolvedValue(null);
      mockGetRawSignalEntries.mockReturnValue([{ ts: 1 }]);

      await triggerTripEndRecall();
      expect(mockUploadSignalDump).not.toHaveBeenCalled();
    });

    it('APNS token 부재 시 upload skip', async () => {
      setupHappyPath();
      setStorage({
        [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
        [ROUTE_KEY]: ROUTE_JSON,
        [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
        [DESTINATION_KEY]: DEST_JSON,
        [APNS_TOKEN_KEY]: null,
      });
      mockGetCurrentTripCorrIdSync.mockReturnValue('1700000000000-deadbeef');
      mockGetRawSignalEntries.mockReturnValue([{ ts: 1 }]);

      await triggerTripEndRecall();
      expect(mockUploadSignalDump).not.toHaveBeenCalled();
    });

    it('entries 빈 배열이면 upload skip', async () => {
      setupHappyPath();
      mockGetCurrentTripCorrIdSync.mockReturnValue('1700000000000-deadbeef');
      mockGetRawSignalEntries.mockReturnValue([]);

      await triggerTripEndRecall();
      expect(mockUploadSignalDump).not.toHaveBeenCalled();
    });

    it('uploadSignalDump 예외 흡수 (recall 결과는 영향 없음)', async () => {
      setupHappyPath();
      mockGetCurrentTripCorrIdSync.mockReturnValue('1700000000000-deadbeef');
      mockGetRawSignalEntries.mockReturnValue([{ ts: 1 }]);
      mockUploadSignalDump.mockRejectedValue(new Error('boom'));

      const result = await triggerTripEndRecall();
      expect(result.uploaded).toBe(true);
    });
  });

  describe('#1579 (P0-3) — alarm log telemetry forward', () => {
    it('정상 흐름 — token + buffer snapshot + deviceMetadata로 forwardTripTelemetry 호출', async () => {
      setupHappyPath();
      mockGetAlarmLog.mockResolvedValue([{ ts: 1, source: 'fg' }]);
      mockGetFusionDebugEntries.mockReturnValue([{ ts: 2, kind: 'cycle' }]);
      // #1706 — 별 ring buffer entries 주입. 별 line으로 forward.
      mockGetFusionTierLog.mockReturnValue([{ ts: 4, tier: 'gpsFallback' }]);
      mockGetGpsDropEntries.mockReturnValue([{ ts: 3 }]);
      mockReadBackendSsotMirror.mockResolvedValue({ currentStationId: '강남' });
      mockBuildDeviceMetadata.mockReturnValue({ os: 'ios', appVersion: '1.2.3' });

      await triggerTripEndRecall();

      expect(mockForwardTripTelemetry).toHaveBeenCalledTimes(1);
      const payload = mockForwardTripTelemetry.mock.calls[0][0];
      expect(payload.token).toBe('apns-token-xyz');
      expect(payload.tripStartedAt).toBe(100);
      expect(payload.tripEndedAt).toBeGreaterThanOrEqual(100);
      expect(payload.alarmLog).toEqual([{ ts: 1, source: 'fg' }]);
      expect(payload.fusionLog).toEqual([{ ts: 2, kind: 'cycle' }]);
      // #1706 — 별 ring 채널 분리.
      expect(payload.fusionTierLog).toEqual([{ ts: 4, tier: 'gpsFallback' }]);
      expect(payload.gpsDrops).toEqual([{ ts: 3 }]);
      expect(payload.backendSsotSnapshot).toEqual({ currentStationId: '강남' });
      expect(payload.deviceMetadata).toEqual({ os: 'ios', appVersion: '1.2.3' });
    });

    it('APNS token 부재 시 forward skip', async () => {
      setupHappyPath();
      setStorage({
        [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
        [ROUTE_KEY]: ROUTE_JSON,
        [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
        [DESTINATION_KEY]: DEST_JSON,
        [APNS_TOKEN_KEY]: null,
      });

      await triggerTripEndRecall();
      expect(mockForwardTripTelemetry).not.toHaveBeenCalled();
    });

    it('forwardTripTelemetry 예외 흡수 (recall 결과는 영향 없음)', async () => {
      setupHappyPath();
      mockForwardTripTelemetry.mockRejectedValue(new Error('boom'));

      const result = await triggerTripEndRecall();
      expect(result.uploaded).toBe(true);
    });

    it('getAlarmLog 예외 흡수', async () => {
      setupHappyPath();
      mockGetAlarmLog.mockRejectedValue(new Error('storage'));

      const result = await triggerTripEndRecall();
      expect(result.uploaded).toBe(true);
      expect(mockForwardTripTelemetry).not.toHaveBeenCalled();
    });
  });

  // ── #1972 logLocklessTripEnd wire ────────────────────────────────────────────

  describe('#1972 lockless trip-end stamp (FE wire)', () => {
    it('lock=null + infoModeEnabled=true + fireCount>=1 → logLocklessTripEnd(fireCount, true)', async () => {
      setupHappyPath();
      mockBoardingLockGetState.mockReturnValue({ lock: null });
      mockUserIntentGetState.mockReturnValue({ infoModeEnabled: true });
      mockCountFiredAlarms.mockReturnValue(5);

      await triggerTripEndRecall();

      expect(mockLogLocklessTripEnd).toHaveBeenCalledTimes(1);
      expect(mockLogLocklessTripEnd).toHaveBeenCalledWith({
        fireCount: 5,
        userIntentDeclared: true,
      });
    });

    it('lock=null + infoModeEnabled=true + fireCount=0 → logLocklessTripEnd(0, true) (진짜 miss)', async () => {
      setupHappyPath();
      mockBoardingLockGetState.mockReturnValue({ lock: null });
      mockUserIntentGetState.mockReturnValue({ infoModeEnabled: true });
      mockCountFiredAlarms.mockReturnValue(0);

      await triggerTripEndRecall();

      expect(mockLogLocklessTripEnd).toHaveBeenCalledWith({
        fireCount: 0,
        userIntentDeclared: true,
      });
    });

    it('lock=null + infoModeEnabled=false + fireCount=0 → logLocklessTripEnd(0, false) (paradigm intent)', async () => {
      setupHappyPath();
      mockBoardingLockGetState.mockReturnValue({ lock: null });
      mockUserIntentGetState.mockReturnValue({ infoModeEnabled: false });
      mockCountFiredAlarms.mockReturnValue(0);

      await triggerTripEndRecall();

      expect(mockLogLocklessTripEnd).toHaveBeenCalledWith({
        fireCount: 0,
        userIntentDeclared: false,
      });
    });

    it('lock 활성 trip은 lockless 분류 X → logLocklessTripEnd 미호출', async () => {
      setupHappyPath();
      mockBoardingLockGetState.mockReturnValue({
        lock: { trainCode: '0001', boardingLine: '2' },
      });
      mockUserIntentGetState.mockReturnValue({ infoModeEnabled: true });
      mockCountFiredAlarms.mockReturnValue(3);

      await triggerTripEndRecall();

      expect(mockLogLocklessTripEnd).not.toHaveBeenCalled();
    });

    it('APNS token 부재 시 stamp 호출 안 함 (forward 자체가 skip)', async () => {
      setupHappyPath();
      setStorage({
        [LAST_UPLOADED_RECALL_TRIP_START_KEY]: null,
        [ROUTE_KEY]: ROUTE_JSON,
        [TRIP_ORIGIN_KEY]: ORIGIN_JSON,
        [DESTINATION_KEY]: DEST_JSON,
        [APNS_TOKEN_KEY]: null,
      });

      await triggerTripEndRecall();

      expect(mockLogLocklessTripEnd).not.toHaveBeenCalled();
    });
  });
});
