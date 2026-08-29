const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

const mockProcessLocationUpdate = jest.fn();
jest.mock('../stationPipeline', () => ({
  processLocationUpdate: (...args: unknown[]) => mockProcessLocationUpdate(...args),
}));

const mockAlarmKey = jest.fn();
jest.mock('../stationAlarm', () => ({
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

const mockIsMinimalAlarmEnabled = jest.fn();
jest.mock('../../../../shared/constants/debugFlags', () => ({
  isMinimalAlarmEnabled: () => mockIsMinimalAlarmEnabled(),
}));

const mockPassesLockedStationGate = jest.fn();
jest.mock('../../../nearest-station/utils/lockedStationGate', () => ({
  passesLockedStationGate: (...args: unknown[]) => mockPassesLockedStationGate(...args),
}));

const mockPollTrainPositionsIfDue = jest.fn();
jest.mock('../../../nearest-station/tasks/bgPositionTrainPoll', () => ({
  pollTrainPositionsIfDue: (...args: unknown[]) => mockPollTrainPositionsIfDue(...args),
}));

const mockPickCandidateTrains = jest.fn();
jest.mock('../../../arrival/utils/pickCandidateTrains', () => ({
  pickCandidateTrains: (...args: unknown[]) => mockPickCandidateTrains(...args),
}));

const mockComputeRouteArc = jest.fn();
jest.mock('../../../route/utils/routeProgress', () => ({
  computeRouteArc: (...args: unknown[]) => mockComputeRouteArc(...args),
}));

const mockTrackTrainProgress = jest.fn();
jest.mock('../../../route/utils/trackTrainProgress', () => ({
  trackTrainProgress: (...args: unknown[]) => mockTrackTrainProgress(...args),
}));

const mockSaveStationToWidget = jest.fn();
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
}));

const mockBuildWidgetTripContext = jest.fn();
jest.mock('../../../widget/utils/buildTripContext', () => ({
  buildWidgetTripContext: (...args: unknown[]) => mockBuildWidgetTripContext(...args),
}));

const mockGetStationById = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => ({
  getStationById: (...args: unknown[]) => mockGetStationById(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { evaluatePositionTrainFire } from '../bgPositionTrainFire';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  ALARM_EVENT_KEY,
  BG_LAST_STATION_KEY,
} from '../../../../shared/constants/storageKeys';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';

const ORIGIN = { id: 'S0', name: '탑승역', line: '2', lat: 37.0, lng: 127.0 };
const WAYPOINT = { id: 'S1', name: '다음역', line: '2', lat: 37.1, lng: 127.1 };
const CURRENT_STATION = { id: 'S1', name: '다음역', line: '2', lat: 37.1, lng: 127.1 };
const DESTINATION = { id: 'dest-1', name: '강남', line: '2', lat: 37.2, lng: 127.2 };
const ARC_STATIONS = [ORIGIN, WAYPOINT];
const ROUTE = { type: 'direct', stops: 3 };
const LOCK = {
  destinationId: 'dest-1',
  trainCode: 'T1',
  boardingStationId: 'S0',
  boardingLine: '2',
  boardedAt: 500,
  expectedDurationMs: 100_000,
};
const LINE_POSITIONS = { line: '2', trains: [{ statnNm: '다음역', trainNo: 'T1' }] };

function mockAsyncStorageGet(map: Record<string, string | null>) {
  mockGetItem.mockImplementation((key: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null),
  );
}

describe('evaluatePositionTrainFire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItem.mockResolvedValue(undefined);
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(ROUTE),
      [BG_LAST_STATION_KEY]: null,
    });
    mockGetStationById.mockReturnValue(ORIGIN);
    mockComputeRouteArc.mockReturnValue({ stations: ARC_STATIONS, arcM: [0, 100], totalLengthM: 100 });
    mockPollTrainPositionsIfDue.mockResolvedValue(LINE_POSITIONS);
    mockPickCandidateTrains.mockReturnValue([
      { trainNo: 'T1', line: '2', direction: 0, currentStationName: '다음역', trainStatus: 1, receivedAtMs: 1 },
    ]);
    mockTrackTrainProgress.mockReturnValue({
      trainNo: 'T1',
      currentStation: CURRENT_STATION,
      trainStatus: 1,
      confidence: 'sticky',
    });
    mockPassesLockedStationGate.mockReturnValue(true);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });
    mockBuildWidgetTripContext.mockReturnValue({
      currentStationName: CURRENT_STATION.name,
      destinationName: DESTINATION.name,
      tripActive: true,
    });
  });

  it('플래그 OFF면 즉시 false를 반환하고 lock을 조회하지 않는다', async () => {
    mockIsMinimalAlarmEnabled.mockReturnValue(false);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockGetBoardingLock).not.toHaveBeenCalled();
  });

  it('lock이 없으면 false를 반환한다', async () => {
    mockGetBoardingLock.mockResolvedValue(null);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockPollTrainPositionsIfDue).not.toHaveBeenCalled();
  });

  it('lock.trainCode가 없으면 false를 반환한다', async () => {
    mockGetBoardingLock.mockResolvedValue({ ...LOCK, trainCode: '' });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockPollTrainPositionsIfDue).not.toHaveBeenCalled();
  });

  // #2407 — pending lock(fallback lock, trainCode 미확정)은 이 정밀추적 경로를 skip해야
  // 한다. sentinel을 실 trainCode처럼 넣으면 어떤 열차와도 매칭되지 않아 false negative만 쌓인다.
  it('lock.trainCode가 pending sentinel이면 false를 반환한다 (#2407)', async () => {
    mockGetBoardingLock.mockResolvedValue({ ...LOCK, trainCode: PENDING_TRAIN_CODE });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockPollTrainPositionsIfDue).not.toHaveBeenCalled();
  });

  it('isUndergroundProfile/wifiStation 게이트를 걸지 않는다 — profile 무관하게 진행', async () => {
    // 본 경로는 환경 profile 판정 자체를 import하지 않는다. 회귀 가드: 모듈이 그런 함수를
    // 호출하지 않고도(mock 미등록) 정상 동작해야 한다.
    const result = await evaluatePositionTrainFire();

    expect(result).toBe(true);
  });

  it('destination이 없으면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: null });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockGetStationById).not.toHaveBeenCalled();
  });

  it('destination JSON 파싱 실패면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: 'not-json' });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
  });

  it('destination에 id가 없으면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: JSON.stringify({ name: '강남' }) });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
  });

  it('route가 없으면 false를 반환한다(arc 계산 불가)', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: null,
      [BG_LAST_STATION_KEY]: null,
    });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockGetStationById).not.toHaveBeenCalled();
  });

  it('탑승역 station lookup 실패 시 false를 반환한다', async () => {
    mockGetStationById.mockReturnValue(undefined);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockComputeRouteArc).not.toHaveBeenCalled();
  });

  it('arc가 비어있으면 false를 반환한다', async () => {
    mockComputeRouteArc.mockReturnValue(null);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockPollTrainPositionsIfDue).not.toHaveBeenCalled();
  });

  it('sleepJson이 저장되지 않았으면 sleepMode=false로 기본 처리한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: null,
      [ROUTE_KEY]: JSON.stringify(ROUTE),
      [BG_LAST_STATION_KEY]: null,
    });

    await evaluatePositionTrainFire();

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sleepMode: false }),
    );
  });

  it('BG_LAST_STATION JSON은 파싱되지만 station.name이 없으면 탑승역 이름을 anchor로 fallback한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(ROUTE),
      [BG_LAST_STATION_KEY]: JSON.stringify({ distanceKm: 0, timestamp: 1 }),
    });

    await evaluatePositionTrainFire();

    expect(mockPickCandidateTrains).toHaveBeenCalledWith(
      expect.objectContaining({ anchorStationName: ORIGIN.name }),
    );
  });

  it('BG_LAST_STATION이 있으면 그 station name을 anchor로 pickCandidateTrains를 호출한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(ROUTE),
      [BG_LAST_STATION_KEY]: JSON.stringify({ station: WAYPOINT, distanceKm: 0, timestamp: 1 }),
    });

    await evaluatePositionTrainFire();

    expect(mockPickCandidateTrains).toHaveBeenCalledWith(
      expect.objectContaining({ anchorStationName: WAYPOINT.name }),
    );
  });

  it('BG_LAST_STATION JSON이 손상되면 탑승역 이름을 anchor로 fallback한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(ROUTE),
      [BG_LAST_STATION_KEY]: 'not-json',
    });

    await evaluatePositionTrainFire();

    expect(mockPickCandidateTrains).toHaveBeenCalledWith(
      expect.objectContaining({ anchorStationName: ORIGIN.name }),
    );
  });

  it('polling이 null이면(quota skip 등) false를 반환하고 candidate 산출을 시도하지 않는다', async () => {
    mockPollTrainPositionsIfDue.mockResolvedValue(null);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockPickCandidateTrains).not.toHaveBeenCalled();
  });

  it('trackTrainProgress가 null이면(후보 없음) false를 반환한다', async () => {
    mockTrackTrainProgress.mockReturnValue(null);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  it('lock 게이트를 통과 못 하면 false를 반환한다', async () => {
    mockPassesLockedStationGate.mockReturnValue(false);

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(false);
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  it('userLocation 없이(GPS-free) lock.boardingLine으로 폴링하고 pickCandidateTrains/trackTrainProgress/lock 게이트를 순서대로 호출해 station 채택 시 true를 반환한다', async () => {
    const result = await evaluatePositionTrainFire();

    expect(result).toBe(true);
    expect(mockPollTrainPositionsIfDue).toHaveBeenCalledWith(LOCK.boardingLine);
    expect(mockPickCandidateTrains).toHaveBeenCalledWith(
      expect.objectContaining({
        positions: [LINE_POSITIONS],
        line: LOCK.boardingLine,
        anchorStationName: ORIGIN.name,
      }),
    );
    expect(mockPickCandidateTrains.mock.calls[0][0]).not.toHaveProperty('userLocation');
    expect(mockTrackTrainProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        lastConfirmedTrainNo: LOCK.trainCode,
        segmentStations: ARC_STATIONS,
        boardingStationId: LOCK.boardingStationId,
      }),
    );
    expect(mockTrackTrainProgress.mock.calls[0][0]).not.toHaveProperty('userLocation');
    expect(mockPassesLockedStationGate).toHaveBeenCalledWith(CURRENT_STATION, LOCK, ARC_STATIONS);
    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: CURRENT_STATION.lat,
        lng: CURRENT_STATION.lng,
        destination: DESTINATION,
        sleepMode: false,
        storedRoute: ROUTE,
        speedMps: null,
        source: 'bg',
        fusionSource: 'position-train',
      }),
    );
  });

  it('alarmEvent가 있으면 firedAlarms/ALARM_EVENT_KEY를 갱신한다', async () => {
    const alarmEvent = { type: 'destination', stationName: '강남', phaseId: 'imminent' };
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent, nearest: null });
    mockAlarmKey.mockReturnValue('imminent:강남');

    await evaluatePositionTrainFire();

    expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', expect.any(Set));
    expect(mockSetItem).toHaveBeenCalledWith(ALARM_EVENT_KEY, JSON.stringify(alarmEvent));
  });

  it('nearest가 있으면 BG_LAST_STATION_KEY 및 위젯을 갱신한다', async () => {
    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: CURRENT_STATION, distanceKm: 0 },
    });

    await evaluatePositionTrainFire();

    expect(mockSetItem).toHaveBeenCalledWith(
      BG_LAST_STATION_KEY,
      expect.stringContaining(CURRENT_STATION.id),
    );
    expect(mockBuildWidgetTripContext).toHaveBeenCalledWith(
      expect.objectContaining({ destination: DESTINATION, currentStation: CURRENT_STATION, route: ROUTE }),
    );
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(CURRENT_STATION, 0, undefined, undefined, {
      currentStationName: CURRENT_STATION.name,
      destinationName: DESTINATION.name,
      tripActive: true,
    });
  });
});
