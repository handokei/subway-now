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

const mockIsUndergroundProfile = jest.fn();
jest.mock('../../../nearest-station/utils/bgLocationProfile', () => ({
  isUndergroundProfile: () => mockIsUndergroundProfile(),
}));

const mockUndergroundSSOTConsensus = jest.fn();
jest.mock('../../../nearest-station/utils/undergroundSSotConsensus', () => ({
  undergroundSSOTConsensus: (...args: unknown[]) => mockUndergroundSSOTConsensus(...args),
}));

const mockPollUndergroundArrivalIfDue = jest.fn();
jest.mock('../../../nearest-station/tasks/bgUndergroundArrivalPoll', () => ({
  pollUndergroundArrivalIfDue: (...args: unknown[]) => mockPollUndergroundArrivalIfDue(...args),
}));

const mockGetCurrentWifiSsid = jest.fn();
jest.mock('../../../nearest-station/utils/wifiSsidNative', () => ({
  getCurrentWifiSsid: () => mockGetCurrentWifiSsid(),
}));

const mockLookupStationBySsid = jest.fn();
jest.mock('../../../nearest-station/utils/wifiSsidLookup', () => ({
  lookupStationBySsid: (...args: unknown[]) => mockLookupStationBySsid(...args),
}));

const mockGetLatestAccelerometerSnapshot = jest.fn();
const mockClassifyAccelerometerPattern = jest.fn();
jest.mock('../../../nearest-station/utils/accelerometerFingerprint', () => ({
  getLatestAccelerometerSnapshot: () => mockGetLatestAccelerometerSnapshot(),
  classifyAccelerometerPattern: (...args: unknown[]) => mockClassifyAccelerometerPattern(...args),
}));

const mockGetCurrentCellularTech = jest.fn();
const mockStartCellularTechUpdates = jest.fn();
const mockClassifyCellularEnvironment = jest.fn();
jest.mock('../../../nearest-station/utils/cellularTech', () => ({
  getCurrentCellularTech: () => mockGetCurrentCellularTech(),
  startCellularTechUpdates: () => mockStartCellularTechUpdates(),
  classifyCellularEnvironment: (...args: unknown[]) => mockClassifyCellularEnvironment(...args),
}));

const mockSaveStationToWidget = jest.fn();
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
}));

const mockBuildWidgetTripContext = jest.fn();
jest.mock('../../../widget/utils/buildTripContext', () => ({
  buildWidgetTripContext: (...args: unknown[]) => mockBuildWidgetTripContext(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { evaluateUndergroundConsensusFire } from '../undergroundConsensusFire';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  ALARM_EVENT_KEY,
  BG_LAST_STATION_KEY,
} from '../../../../shared/constants/storageKeys';

const STATION = { id: 'S1', name: '교대', line: '2', lat: 37.1, lng: 127.1 };
const DESTINATION = { id: 'dest-1', name: '강남', line: '2', lat: 37.2, lng: 127.2 };
const LOCK = {
  destinationId: 'dest-1',
  trainCode: 'T1',
  boardingStationId: 'S0',
  boardingLine: '2',
  boardedAt: 500,
  expectedDurationMs: 100_000,
};

function mockAsyncStorageGet(map: Record<string, string | null>) {
  mockGetItem.mockImplementation((key: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null),
  );
}

describe('evaluateUndergroundConsensusFire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItem.mockResolvedValue(undefined);
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockIsUndergroundProfile.mockResolvedValue(true);
    mockGetCurrentWifiSsid.mockResolvedValue('SSID');
    mockLookupStationBySsid.mockReturnValue(STATION);
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: null,
    });
    mockPollUndergroundArrivalIfDue.mockResolvedValue({ up: [], down: [] });
    mockGetCurrentCellularTech.mockReturnValue('LTE');
    mockClassifyCellularEnvironment.mockReturnValue('underground');
    mockGetLatestAccelerometerSnapshot.mockReturnValue(null);
    mockClassifyAccelerometerPattern.mockReturnValue('automotive');
    mockUndergroundSSOTConsensus.mockReturnValue({ station: STATION, trainCode: 'T1' });
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });
    mockBuildWidgetTripContext.mockReturnValue({
      currentStationName: STATION.name,
      destinationName: DESTINATION.name,
      tripActive: true,
    });
  });

  it('플래그 OFF면 즉시 no-op한다', async () => {
    mockIsMinimalAlarmEnabled.mockReturnValue(false);

    await evaluateUndergroundConsensusFire();

    expect(mockGetBoardingLock).not.toHaveBeenCalled();
  });

  it('lock이 없으면 no-op한다', async () => {
    mockGetBoardingLock.mockResolvedValue(null);

    await evaluateUndergroundConsensusFire();

    expect(mockIsUndergroundProfile).not.toHaveBeenCalled();
  });

  it('profile이 underground가 아니면 no-op한다', async () => {
    mockIsUndergroundProfile.mockResolvedValue(false);

    await evaluateUndergroundConsensusFire();

    expect(mockGetCurrentWifiSsid).not.toHaveBeenCalled();
  });

  it('WiFi station이 미해상이면 arrival 폴링 없이 no-op한다', async () => {
    mockLookupStationBySsid.mockReturnValue(null);

    await evaluateUndergroundConsensusFire();

    expect(mockPollUndergroundArrivalIfDue).not.toHaveBeenCalled();
  });

  it('destination이 없으면 no-op한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: null });

    await evaluateUndergroundConsensusFire();

    expect(mockPollUndergroundArrivalIfDue).not.toHaveBeenCalled();
  });

  it('destination JSON 파싱 실패면 no-op한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: 'not-json' });

    await evaluateUndergroundConsensusFire();

    expect(mockPollUndergroundArrivalIfDue).not.toHaveBeenCalled();
  });

  it('destination에 id가 없으면 no-op한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: JSON.stringify({ name: '강남' }) });

    await evaluateUndergroundConsensusFire();

    expect(mockPollUndergroundArrivalIfDue).not.toHaveBeenCalled();
  });

  it('consensus가 채택 안 되면(null) processLocationUpdate를 호출하지 않는다', async () => {
    mockUndergroundSSOTConsensus.mockReturnValue(null);

    await evaluateUndergroundConsensusFire();

    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  it('consensus 채택 시 arrival 폴링 + cellular start + consensus station 좌표로 processLocationUpdate를 호출한다', async () => {
    await evaluateUndergroundConsensusFire();

    expect(mockPollUndergroundArrivalIfDue).toHaveBeenCalledWith(STATION.name, STATION.line);
    expect(mockStartCellularTechUpdates).toHaveBeenCalled();
    expect(mockUndergroundSSOTConsensus).toHaveBeenCalledWith(
      expect.objectContaining({
        wifiStation: STATION,
        positionTrainResult: null,
        arrival: { up: [], down: [] },
        cellularEnvironmentVote: 'underground',
        accelerometerPattern: 'automotive',
        tripStartedAt: LOCK.boardedAt,
      }),
    );
    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: STATION.lat,
        lng: STATION.lng,
        destination: DESTINATION,
        sleepMode: false,
        storedRoute: null,
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

    await evaluateUndergroundConsensusFire();

    expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', expect.any(Set));
    expect(mockSetItem).toHaveBeenCalledWith(ALARM_EVENT_KEY, JSON.stringify(alarmEvent));
  });

  it('nearest가 있으면 BG_LAST_STATION_KEY 및 위젯을 갱신한다', async () => {
    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: STATION, distanceKm: 0 },
    });

    await evaluateUndergroundConsensusFire();

    expect(mockSetItem).toHaveBeenCalledWith(
      BG_LAST_STATION_KEY,
      expect.stringContaining(STATION.id),
    );
    expect(mockBuildWidgetTripContext).toHaveBeenCalledWith(
      expect.objectContaining({ destination: DESTINATION, currentStation: STATION, route: null }),
    );
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(STATION, 0, undefined, undefined, {
      currentStationName: STATION.name,
      destinationName: DESTINATION.name,
      tripActive: true,
    });
  });

  it('sleepMode/route JSON이 저장돼 있으면 파싱해 전달한다', async () => {
    const route = { type: 'direct', stops: 3 };
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'true',
      [ROUTE_KEY]: JSON.stringify(route),
    });

    await evaluateUndergroundConsensusFire();

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sleepMode: true, storedRoute: route }),
    );
  });

  it('sleepJson이 저장되지 않았으면 sleepMode=false로 기본 처리한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: null,
      [ROUTE_KEY]: null,
    });

    await evaluateUndergroundConsensusFire();

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sleepMode: false }),
    );
  });

  it('WiFi lookup이 예외를 던지면 graceful하게 null 취급한다', async () => {
    mockGetCurrentWifiSsid.mockRejectedValue(new Error('native fail'));
    mockLookupStationBySsid.mockImplementation((ssid: string | null) => (ssid ? STATION : null));

    await evaluateUndergroundConsensusFire();

    expect(mockLookupStationBySsid).toHaveBeenCalledWith(null);
    expect(mockPollUndergroundArrivalIfDue).not.toHaveBeenCalled();
  });
});
