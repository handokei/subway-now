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

import { triggerTripEndRecall } from '../triggerTripEndRecall';
import {
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

describe('triggerTripEndRecall', () => {
  beforeEach(() => {
    mockGetItem.mockReset();
    mockSetItem.mockReset();
    mockComputeAndUploadTripRecall.mockReset();
    mockComputeAndUploadTripPrescheduled.mockReset();
    mockComputeAndUploadTripPrescheduled.mockResolvedValue({ uploaded: false });
    mockComputeRouteArc.mockReset();
    mockGetTripStartedAt.mockReset();
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
});
