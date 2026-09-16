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

const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockGetFiredAlarms = jest.fn();
jest.mock('../notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
}));

const mockPersistBgFireResult = jest.fn();
jest.mock('../bgFirePersist', () => ({
  persistBgFireResult: (...args: unknown[]) => mockPersistBgFireResult(...args),
}));

const mockIsMinimalAlarmEnabled = jest.fn();
jest.mock('../../../../shared/constants/debugFlags', () => ({
  isMinimalAlarmEnabled: () => mockIsMinimalAlarmEnabled(),
}));

const mockLogWaypointArvlcdFireDiagnostic = jest.fn();
jest.mock('../alarmLog', () => ({
  logWaypointArvlcdFireDiagnostic: (...args: unknown[]) =>
    mockLogWaypointArvlcdFireDiagnostic(...args),
}));

const mockPollWaypointArrivalIfDue = jest.fn();
jest.mock('../../../nearest-station/tasks/bgWaypointArrivalPoll', () => ({
  pollWaypointArrivalIfDue: (...args: unknown[]) => mockPollWaypointArrivalIfDue(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => {
  const actual = jest.requireActual('../../../../shared/utils/stationRoute');
  return {
    ...actual,
    findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  };
});

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { evaluateWaypointArvlcdFire } from '../bgWaypointArvlcdFire';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
} from '../../../../shared/constants/storageKeys';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';

const DESTINATION = { id: 'dest-1', name: '강남', line: '2', lat: 1, lng: 2 };
const DIRECT_ROUTE = { type: 'direct', line: '2', stops: 3 };
const TRANSFER_ROUTE = {
  type: 'transfer',
  fromLine: '7',
  toLine: '2',
  transferName: '건대입구',
  stopsToTransfer: 2,
  stopsFromTransfer: 3,
};
const LOCK_TRAIN_CODE = '2026090201';
const LOCK = {
  destinationId: 'dest-1',
  trainCode: LOCK_TRAIN_CODE,
  boardingStationId: 'S0',
  boardingLine: '7',
  boardedAt: 0,
  expectedDurationMs: 600_000,
};
const TARGET_STATION = { id: 'dest-1', name: '강남', line: '2', lat: 37.5, lng: 127.05 };

function mockAsyncStorageGet(map: Record<string, string | null>) {
  mockGetItem.mockImplementation((key: string) =>
    Promise.resolve(Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null),
  );
}

function imminentArrival(trainCode: string, code: number = ARRIVAL_CODE.ENTERING) {
  return { up: [{ trainCode, arrivalCode: code }], down: [] };
}

describe('evaluateWaypointArvlcdFire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItem.mockResolvedValue(undefined);
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(DIRECT_ROUTE),
    });
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockPollWaypointArrivalIfDue.mockResolvedValue(imminentArrival(LOCK_TRAIN_CODE));
    mockFindStationByNameAndLine.mockReturnValue(TARGET_STATION);
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });
    mockPersistBgFireResult.mockResolvedValue(undefined);
  });

  it('플래그 OFF면 즉시 false를 반환하고 lock을 조회하지 않는다', async () => {
    mockIsMinimalAlarmEnabled.mockReturnValue(false);

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockGetBoardingLock).not.toHaveBeenCalled();
    // 비활성 사용자 전원 스팸 방지 — flag-off는 진단 로그 미적재(#2474와 동일 원칙).
    expect(mockLogWaypointArvlcdFireDiagnostic).not.toHaveBeenCalled();
  });

  it('lock이 없으면 false를 반환하고 skip-no-lock을 적재한다', async () => {
    mockGetBoardingLock.mockResolvedValue(null);

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-lock', {
      hasTrainCode: false,
    });
  });

  it('lock.trainCode가 빈 문자열이면 false를 반환한다', async () => {
    mockGetBoardingLock.mockResolvedValue({ ...LOCK, trainCode: '' });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-lock', {
      hasTrainCode: false,
    });
  });

  // #2407과 동일 가드 — pending sentinel은 imminent 판정에 소비 금지(오발사 방지).
  it('lock.trainCode가 PENDING sentinel이면 false를 반환한다 (오발사 방지)', async () => {
    mockGetBoardingLock.mockResolvedValue({ ...LOCK, trainCode: PENDING_TRAIN_CODE });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-pending-traincode', {
      hasTrainCode: true,
    });
  });

  it('destination이 없으면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: null });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-destination');
  });

  it('destination JSON 파싱 실패면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: 'not-json' });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-bad-destination');
  });

  it('destination에 id가 없으면 false를 반환한다', async () => {
    mockAsyncStorageGet({ [DESTINATION_KEY]: JSON.stringify({ name: '강남' }) });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-bad-destination');
  });

  it('route가 없으면 false를 반환한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: null,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-route');
  });

  it('모든 waypoint가 이미 발사됐으면(nextTarget 없음) false를 반환하고 폴링하지 않는다', async () => {
    mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockPollWaypointArrivalIfDue).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-next-target');
  });

  // negative — 오발사 0 보장: 내 열차의 arvlCd가 아직 ENTERING/ARRIVED가 아니면 조용히 false.
  it('arvlCd가 내 열차 미확증이면(다른 trainCode) false를 반환하고 processLocationUpdate를 호출하지 않는다', async () => {
    mockPollWaypointArrivalIfDue.mockResolvedValue(imminentArrival('다른열차코드'));

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-not-imminent', {
      waypointName: '강남',
    });
  });

  it('arrival이 null이면(폴링 quota skip 등) false를 반환한다', async () => {
    mockPollWaypointArrivalIfDue.mockResolvedValue(null);

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-not-imminent', {
      waypointName: '강남',
    });
  });

  it('target station lookup 실패 시 false를 반환한다', async () => {
    mockFindStationByNameAndLine.mockReturnValue(undefined);

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('skip-no-target-station', {
      waypointName: '강남',
    });
  });

  it('sleepJson이 저장되지 않았으면 sleepMode=false로 기본 처리한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: null,
      [ROUTE_KEY]: JSON.stringify(DIRECT_ROUTE),
    });

    await evaluateWaypointArvlcdFire();

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ sleepMode: false }),
    );
  });

  it('direct route: destination waypoint를 폴링해 lock.trainCode로 imminent 확증 시 processLocationUpdate를 호출한다', async () => {
    const alarmEvent = { type: 'destination', phaseId: 'imminent', stationName: '강남' };
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent, nearest: null });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(true);
    expect(mockPollWaypointArrivalIfDue).toHaveBeenCalledWith('강남', '2');
    expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '2');
    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: TARGET_STATION.lat,
        lng: TARGET_STATION.lng,
        destination: DESTINATION,
        sleepMode: false,
        storedRoute: DIRECT_ROUTE,
        speedMps: null,
        source: 'bg',
        fusionSource: 'position-train',
      }),
    );
    expect(mockPersistBgFireResult).toHaveBeenCalledWith(
      expect.objectContaining({ alarmEvent, destination: DESTINATION, storedRoute: DIRECT_ROUTE }),
    );
    expect(mockLogWaypointArvlcdFireDiagnostic).toHaveBeenCalledWith('engaged', {
      waypointName: '강남',
    });
  });

  // #2383(evaluatePositionTrainFire)과 동일 계약 — arvlCd로 채택(파이프라인 실행)에 성공했다는
  // 사실 자체가 반환 기준. 내부 dedup/hop-window/sleep 게이트가 이번 tick 발사만 suppress해도
  // (alarmEvent=null) GPS-independent 신호로 위치가 확정됐으므로 true를 반환해 호출자가 GPS
  // 파이프라인으로 fall through하지 않게 한다.
  it('processLocationUpdate가 alarmEvent를 null로 반환해도(dedup 등) true를 반환한다 (채택 성공 기준)', async () => {
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(true);
    // dedup/게이트로 alarmEvent가 없어도 nearest bookkeeping을 위해 persist는 여전히 호출.
    expect(mockPersistBgFireResult).toHaveBeenCalled();
  });

  // 환승: transfer waypoint가 아직 미발사면 그것부터 폴링, transfer가 이미 발사됐으면 destination으로 진행.
  it('transfer route: transfer waypoint가 미발사면 transfer를 다음 폴링 대상으로 삼는다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(TRANSFER_ROUTE),
    });
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());

    await evaluateWaypointArvlcdFire();

    expect(mockPollWaypointArrivalIfDue).toHaveBeenCalledWith('건대입구', '7');
  });

  it('transfer route: transfer가 이미 발사됐으면 destination waypoint로 진행한다', async () => {
    mockAsyncStorageGet({
      [DESTINATION_KEY]: JSON.stringify(DESTINATION),
      [SLEEP_MODE_KEY]: 'false',
      [ROUTE_KEY]: JSON.stringify(TRANSFER_ROUTE),
    });
    mockGetFiredAlarms.mockResolvedValue(new Set(['early:건대입구']));

    await evaluateWaypointArvlcdFire();

    expect(mockPollWaypointArrivalIfDue).toHaveBeenCalledWith('강남', '2');
  });
});
