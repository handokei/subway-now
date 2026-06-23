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

import { triggerTripEndRecall } from '../triggerTripEndRecall';
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
  });

  it('tripStart 부재 시 즉시 skip (no-trip-start)', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'no-trip-start' });
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
  });

  it('idempotency — 같은 tripStart 로 이미 upload 됐으면 skip (duplicate)', async () => {
    mockGetTripStartedAt.mockResolvedValue(100);
    setStorage({ [LAST_UPLOADED_RECALL_TRIP_START_KEY]: '100' });

    const result = await triggerTripEndRecall();

    expect(result).toEqual({ uploaded: false, skipped: 'duplicate' });
    expect(mockComputeAndUploadTripRecall).not.toHaveBeenCalled();
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
});
