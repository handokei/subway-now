// ── TaskManager: defineTask 콜백을 캡처하기 위해 global 객체를 사용 ──
// jest.mock 팩토리는 변수 호이스팅보다 먼저 실행되므로,
// 팩토리 외부 변수를 참조하면 undefined가 된다.
// global 객체는 항상 접근 가능하므로 여기에 콜백을 저장한다.
jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__bgTaskCallback = callback;
    (global as any).__bgTaskName = name;
  },
}));

// ── expo-location 모킹 ──
jest.mock('expo-location', () => ({
  LocationObject: {},
}));

// ── AsyncStorage 모킹 ──
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

// ── stationPipeline 모킹 ──
const mockProcessLocationUpdate = jest.fn();
jest.mock('../../utils/stationPipeline', () => ({
  processLocationUpdate: (...args: unknown[]) => mockProcessLocationUpdate(...args),
}));

// ── stationAlarm 모킹 ──
const mockAlarmKey = jest.fn();
jest.mock('../../utils/stationAlarm', () => ({
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
}));

// ── logger 모킹 ──
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlarmEvent } from '../../utils/stationAlarm';
// 모듈 import — defineTask가 이 시점에 호출되어 global에 콜백이 저장됨
import '../../tasks/backgroundLocationTask';
import { BACKGROUND_LOCATION_TASK } from '../../tasks/backgroundLocationTask';

// ── 픽스처 ──

const mockStation = {
  id: 'station-1',
  name: '강남',
  line: '2' as const,
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};

const mockDestination = {
  id: 'station-2',
  name: '시청',
  line: '1' as const,
  lineColor: '#0052A4',
  lat: 37.565,
  lng: 126.977,
};

function makeLocation(
  lat: number,
  lng: number,
  opts: { speed?: number | null; ageMs?: number; accuracy?: number | null } = {},
) {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      altitude: null,
      accuracy: opts.accuracy ?? null,
      altitudeAccuracy: null,
      heading: null,
      speed: opts.speed ?? null,
    },
    timestamp: Date.now() - (opts.ageMs ?? 0),
  };
}

type TaskCtx = { data: unknown; error: { message: string } | null };
type TaskCallback = (ctx: TaskCtx) => Promise<void>;

function getTaskCallback(): TaskCallback {
  return (global as any).__bgTaskCallback as TaskCallback;
}

/** AsyncStorage.getItem 6개를 순서대로 모킹한다 (dest, sleep, fired, route, lastNotified, allowSpeaker) */
function mockStorageValues(
  dest: string | null,
  sleep: string | null = null,
  fired: string | null = null,
  route: string | null = null,
  lastNotified: string | null = null,
  allowSpeaker: string | null = null,
): void {
  (AsyncStorage.getItem as jest.Mock)
    .mockResolvedValueOnce(dest)
    .mockResolvedValueOnce(sleep)
    .mockResolvedValueOnce(fired)
    .mockResolvedValueOnce(route)
    .mockResolvedValueOnce(lastNotified)
    .mockResolvedValueOnce(allowSpeaker);
}

describe('BACKGROUND_LOCATION_TASK 상수', () => {
  it('올바른 태스크 이름 문자열을 갖는다', () => {
    expect(BACKGROUND_LOCATION_TASK).toBe('background-location-task');
  });
});

describe('backgroundLocationTask defineTask 콜백', () => {
  let taskCallback: TaskCallback;

  beforeAll(() => {
    taskCallback = getTaskCallback();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });
  });

  it('defineTask가 올바른 태스크 이름으로 등록된다', () => {
    expect((global as any).__bgTaskName).toBe('background-location-task');
    expect(typeof taskCallback).toBe('function');
  });

  // ── error 분기 ──

  it('error가 있으면 즉시 return하고 다른 함수를 호출하지 않는다', async () => {
    await taskCallback({ data: null, error: { message: '위치 오류' } });

    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  // ── data 없음 분기 ──

  it('data가 null이면 즉시 return한다', async () => {
    await taskCallback({ data: null, error: null });

    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  });

  // ── locations 빈 배열 분기 ──

  it('locations가 빈 배열이면 즉시 return한다', async () => {
    await taskCallback({ data: { locations: [] }, error: null });

    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  });

  // ── 목적지 미설정: 실시간 현황을 띄우지 않는다 ──

  it('destJson이 없으면 processLocationUpdate를 호출하지 않고 즉시 return한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  // ── 목적지 설정 + alarmEvent 없음 ──

  it('destJson이 있고 alarmEvent가 null이면 AsyncStorage.setItem을 호출하지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: mockStation, distanceKm: 0.1 },
      lastNotifiedStationId: null,
    });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      lat: 37.498,
      lng: 127.028,
      destination: mockDestination,
      firedAlarms: new Set(),
      sleepMode: false,
      allowSpeaker: true,
      storedRoute: null,
      lastNotifiedStationId: null,
    }));
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  // ── sleepMode 파싱 ──

  it("sleepJson이 'true'이면 sleepMode=true로 processLocationUpdate를 호출한다", async () => {
    mockStorageValues(JSON.stringify(mockDestination), 'true');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sleepMode: true,
    }));
  });

  it("sleepJson이 'false'이면 sleepMode=false로 processLocationUpdate를 호출한다", async () => {
    mockStorageValues(JSON.stringify(mockDestination), 'false');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sleepMode: false,
    }));
  });

  // ── allowSpeaker 파싱 ──

  it("allowSpeakerJson이 'false'이면 allowSpeaker=false로 processLocationUpdate를 호출한다", async () => {
    mockStorageValues(JSON.stringify(mockDestination), null, null, null, null, 'false');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      allowSpeaker: false,
    }));
  });

  it("allowSpeakerJson이 'true'이면 allowSpeaker=true로 processLocationUpdate를 호출한다", async () => {
    mockStorageValues(JSON.stringify(mockDestination), null, null, null, null, 'true');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      allowSpeaker: true,
    }));
  });

  // ── firedAlarms 파싱 ──

  it('firedJson이 있으면 파싱한 Set을 processLocationUpdate에 전달한다', async () => {
    const fired = ['destination:강남', 'transfer:시청'];
    mockStorageValues(JSON.stringify(mockDestination), null, JSON.stringify(fired));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      firedAlarms: new Set(fired),
    }));
  });

  // ── ROUTE_KEY 관련 테스트 ──

  it('ROUTE_KEY를 AsyncStorage에서 읽는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:route');
  });

  it('routeJson이 있으면 파싱한 route를 processLocationUpdate에 전달한다', async () => {
    const storedRoute = { type: 'direct', stops: 3 };
    mockStorageValues(JSON.stringify(mockDestination), null, null, JSON.stringify(storedRoute));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      storedRoute,
    }));
  });

  it('routeJson이 null이면 null storedRoute를 processLocationUpdate에 전달한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      storedRoute: null,
    }));
  });

  // ── alarmEvent 있음: firedAlarms 저장 ──

  it('alarmEvent가 있으면 alarmKey를 추가하고 AsyncStorage.setItem을 호출한다', async () => {
    const alarmEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '시청' };
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent,
      nearest: { station: mockStation, distanceKm: 0.1 },
      lastNotifiedStationId: null,
    });
    mockAlarmKey.mockReturnValue('destination:시청');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockAlarmKey).toHaveBeenCalledWith(alarmEvent);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:fired-alarms',
      JSON.stringify(['destination:시청']),
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:alarm-event',
      JSON.stringify(alarmEvent),
    );
  });

  it('기존 firedAlarms에 alarmEvent 키를 추가하여 저장한다', async () => {
    const alarmEvent: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '강남' };
    const existingFired = ['destination:시청'];
    mockStorageValues(JSON.stringify(mockDestination), null, JSON.stringify(existingFired));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent,
      nearest: { station: mockStation, distanceKm: 0.1 },
      lastNotifiedStationId: null,
    });
    mockAlarmKey.mockReturnValue('transfer:강남');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:fired-alarms',
      JSON.stringify(['destination:시청', 'transfer:강남']),
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:alarm-event',
      JSON.stringify(alarmEvent),
    );
  });

  // ── destJson 파싱 실패 분기 ──

  it('destJson이 손상된 JSON이면 즉시 return한다', async () => {
    mockStorageValues('invalid-json{{{');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  // ── 마지막 location 선택 ──

  it('locations 배열의 마지막 요소를 사용한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    const loc1 = makeLocation(37.1, 127.1);
    const loc2 = makeLocation(37.9, 127.9); // 마지막

    await taskCallback({
      data: { locations: [loc1, loc2] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      lat: 37.9,
      lng: 127.9,
    }));
  });

  // ── stale 위치 / 저정확도 게이트 ──

  const runWithLocation = (location: unknown) =>
    taskCallback({ data: { locations: [location] }, error: null });

  const expectGateBlocked = () => {
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  };

  it('stale 위치(timestamp 30초 초과)는 무시한다', async () => {
    await runWithLocation(makeLocation(37.498, 127.028, { ageMs: 60_000 }));
    expectGateBlocked();
  });

  it('timestamp가 없는 위치는 무시한다', async () => {
    const noTsLocation = {
      coords: {
        latitude: 37.498,
        longitude: 127.028,
        altitude: null,
        accuracy: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      // timestamp 누락
    };
    await runWithLocation(noTsLocation);
    expectGateBlocked();
  });

  it('저정확도 위치(accuracy 150m 초과)는 무시한다', async () => {
    await runWithLocation(makeLocation(37.498, 127.028, { accuracy: 200 }));
    expectGateBlocked();
  });

  it('accuracy가 임계값(150m) 이내면 통과한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { accuracy: 100 })] },
      error: null,
    });

    expect(AsyncStorage.getItem).toHaveBeenCalled();
  });

  // ── 전체 try-catch 에러 핸들링 ──

  it('processLocationUpdate가 실패해도 태스크가 크래시하지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockRejectedValueOnce(new Error('파이프라인 오류'));

    await expect(
      taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      }),
    ).resolves.toBeUndefined();
  });

  // ── LAST_NOTIFIED_STATION_KEY 관련 테스트 ──

  it('LAST_NOTIFIED_STATION_KEY를 AsyncStorage에서 읽어 processLocationUpdate에 전달한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination), null, null, null, 'station-1');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: 'station-1' });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:last-notified-station');
    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      lastNotifiedStationId: 'station-1',
    }));
  });

  it('lastNotifiedStationId가 변경되면 AsyncStorage에 저장한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination), null, null, null, 'station-1');

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: null,
      lastNotifiedStationId: 'station-2',
    });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:last-notified-station',
      'station-2',
    );
  });

  it('lastNotifiedStationId가 변경되지 않으면 저장하지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination), null, null, null, 'station-1');

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: null,
      lastNotifiedStationId: 'station-1',
    });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('GPS speed가 양수이면 speedMps로 processLocationUpdate에 전달한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { speed: 12.5 })] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({ speedMps: 12.5 }));
  });

  it('GPS speed가 음수이면 speedMps를 null로 정규화한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { speed: -1 })] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({ speedMps: null }));
  });

  it('lastNotifiedStationId가 null이면 저장하지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: null,
      lastNotifiedStationId: null,
    });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});
