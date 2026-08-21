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
jest.mock('../../../alarm/utils/stationPipeline', () => ({
  processLocationUpdate: (...args: unknown[]) => mockProcessLocationUpdate(...args),
}));

// ── stationAlarm 모킹 ──
const mockAlarmKey = jest.fn();
jest.mock('../../../alarm/utils/stationAlarm', () => ({
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
}));

// ── notificationState 모킹 (firedAlarms는 destination scoped, #462) ──
const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../../../alarm/utils/notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

// ── alarmLog 모킹 ──
const mockLogSuppressedGate = jest.fn();
jest.mock('../../../alarm/utils/alarmLog', () => ({
  logSuppressedGate: (...args: unknown[]) => mockLogSuppressedGate(...args),
}));

// ── positionUpload 모킹 (#819) ──
const mockUploadPosition = jest.fn();
jest.mock('../../api/positionUpload', () => ({
  uploadPosition: (...args: unknown[]) => mockUploadPosition(...args),
}));

// ── motionActivity 모킹 (#819 stationary 분류) ──
const mockGetCurrentMotionStationary = jest.fn();
jest.mock('../../utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetCurrentMotionStationary(),
}));

// ── bgLocationProfile 모킹 (#2344 V8a profile 전환 + #2345 지하 accuracy 강등) ──
const mockApplyBgLocationProfile = jest.fn();
const mockDemoteToUndergroundIfNeeded = jest.fn();
const mockReleaseFromUndergroundIfNeeded = jest.fn();
jest.mock('../../utils/bgLocationProfile', () => ({
  applyBgLocationProfile: (...args: unknown[]) => mockApplyBgLocationProfile(...args),
  demoteToUndergroundIfNeeded: (...args: unknown[]) => mockDemoteToUndergroundIfNeeded(...args),
  releaseFromUndergroundIfNeeded: (...args: unknown[]) => mockReleaseFromUndergroundIfNeeded(...args),
}));

// ── accelMotionState 모킹 (#823 가속도 latest 첨부) ──
const mockGetLatestAccelSummary = jest.fn();
jest.mock('../../utils/accelMotionState', () => ({
  getLatestAccelSummary: () => mockGetLatestAccelSummary(),
}));

// ── accelerometerFingerprint 모킹 (#1542 BG location piggyback) ──
// classifyAccelerometerPattern은 helper; default 'unknown' 반환으로 기존 motion stationary fallback 동작.
const mockStartAccelerometerFingerprint = jest.fn();
const mockGetLatestAccelerometerSnapshot = jest.fn();
const mockClassifyAccelerometerPattern = jest.fn();
jest.mock('../../utils/accelerometerFingerprint', () => ({
  startAccelerometerFingerprint: () => mockStartAccelerometerFingerprint(),
  getLatestAccelerometerSnapshot: () => mockGetLatestAccelerometerSnapshot(),
  classifyAccelerometerPattern: (snapshot: unknown) => mockClassifyAccelerometerPattern(snapshot),
}));

// ── widgetStorage 모킹 (#1237 Phase 2) ──
const mockSaveStationToWidget = jest.fn();
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
}));

// ── logger 모킹 ──
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ── #1667 WiFi SSID 모킹 ──
const mockGetCurrentWifiSsid = jest.fn<Promise<string | null>, []>();
jest.mock('../../utils/wifiSsidNative', () => ({
  getCurrentWifiSsid: () => mockGetCurrentWifiSsid(),
}));
const mockLookupStationBySsid = jest.fn<{ name: string } | null, [string | null | undefined]>();
jest.mock('../../utils/wifiSsidLookup', () => ({
  lookupStationBySsid: (ssid: string | null | undefined) => mockLookupStationBySsid(ssid),
}));

// ── #2178 pull death backstop 모킹 — wiring만 검증(내부 판정/cleanup은 tripDeathPullBackstop.test.ts 전담) ──
const mockGetTripDeathPullBackendUrl = jest.fn<string | null, []>(() => null);
const mockCheckTripDeathByPull = jest.fn().mockResolvedValue('skipped');
jest.mock('../../../alarm/utils/tripDeathPullBackstop', () => ({
  getBackendUrl: () => mockGetTripDeathPullBackendUrl(),
  checkTripDeathByPull: (...args: unknown[]) => mockCheckTripDeathByPull(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AlarmEvent } from '../../../../shared/types/alarm';
// 모듈 import — defineTask가 이 시점에 호출되어 global에 콜백이 저장됨
import '../../tasks/backgroundLocationTask';
import { BACKGROUND_LOCATION_TASK } from '../backgroundLocationTask';
import {
  MAX_ACCURACY_M,
  MAX_LOCATION_AGE_MS,
  POSITION_UPLOAD_MIN_INTERVAL_MS,
} from '../../../../shared/constants/location';
import { ALARM_EVENT_KEY } from '../../../../shared/constants/storageKeys';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

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

/** AsyncStorage.getItem 3개를 순서대로 모킹한다 (dest, sleep, route).
 *  #2067 (Phase 2-device, D1) — allowSpeaker read는 processLocationUpdate가 더 이상 소비하지
 *  않아 backgroundLocationTask.ts에서 제거됐다(dead read cleanup).
 *  firedAlarms는 notificationState helper로 분리되어 별도 mockGetFiredAlarms로 제어한다.
 *  lastNotifiedStationId는 stationPipeline 내부에서 notificationState 모듈로 read/write 한다. */
function mockStorageValues(
  dest: string | null,
  sleep: string | null = null,
  route: string | null = null,
): void {
  (AsyncStorage.getItem as jest.Mock)
    .mockResolvedValueOnce(dest)
    .mockResolvedValueOnce(sleep)
    .mockResolvedValueOnce(route);
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
    mockGetFiredAlarms.mockResolvedValue(new Set());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });
    mockUploadPosition.mockResolvedValue({ ok: true, status: 200 });
    mockGetCurrentMotionStationary.mockReturnValue(false);
    mockGetLatestAccelSummary.mockReturnValue(null);
    mockGetLatestAccelerometerSnapshot.mockReturnValue(null);
    // 기본: 60s window 미수렴 → 'unknown' (CMMotionActivity fallback 경로 trigger).
    mockClassifyAccelerometerPattern.mockReturnValue('unknown');
    mockSaveStationToWidget.mockResolvedValue(undefined);
    // #1667 기본값: WiFi 미연결(null) → wifiSsidStationName undefined
    mockGetCurrentWifiSsid.mockResolvedValue(null);
    mockLookupStationBySsid.mockReturnValue(null);
    // #2178 — pull death backstop 기본값: baseUrl 없음(호출 안 함). 개별 테스트에서 override.
    mockGetTripDeathPullBackendUrl.mockReturnValue(null);
    mockCheckTripDeathByPull.mockResolvedValue('skipped');
    mockApplyBgLocationProfile.mockResolvedValue(undefined);
    mockDemoteToUndergroundIfNeeded.mockResolvedValue(undefined);
    mockReleaseFromUndergroundIfNeeded.mockResolvedValue(false);
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

  it('destJson이 있고 alarmEvent가 null이면 ALARM_EVENT_KEY는 쓰지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: mockStation, distanceKm: 0.1 },
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
      storedRoute: null,
    }));
    // alarmEvent가 없으므로 ALARM_EVENT_KEY는 기록되지 않는다.
    // BG_LAST_FIX_KEY(#527 jump gate)는 fix 수용 시 항상 기록되므로 별도 검증.
    const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    expect(setItemCalls.every(([key]) => key !== ALARM_EVENT_KEY)).toBe(true);
  });

  // ── sleepMode 파싱 ──

  it("sleepJson이 'true'이면 sleepMode=true로 processLocationUpdate를 호출한다", async () => {
    mockStorageValues(JSON.stringify(mockDestination), 'true');

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

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

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      sleepMode: false,
    }));
  });

  // ── firedAlarms 파싱 ──

  it('notificationState.getFiredAlarms(destinationId)로 읽어 processLocationUpdate에 전달한다 (#462)', async () => {
    const fired = ['destination:강남', 'transfer:시청'];
    mockStorageValues(JSON.stringify(mockDestination));
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(fired));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockGetFiredAlarms).toHaveBeenCalledWith(mockDestination.id);
    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      firedAlarms: new Set(fired),
    }));
  });

  // ── ROUTE_KEY 관련 테스트 ──

  it('ROUTE_KEY를 AsyncStorage에서 읽는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:route');
  });

  it('routeJson이 있으면 파싱한 route를 processLocationUpdate에 전달한다', async () => {
    const storedRoute = makeDirectRoute(3, '2');
    mockStorageValues(JSON.stringify(mockDestination), null, JSON.stringify(storedRoute));

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

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

    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      storedRoute: null,
    }));
  });

  // ── alarmEvent 있음: firedAlarms 저장 ──

  it('alarmEvent가 있으면 alarmKey를 추가하고 setFiredAlarms(destId, set)를 호출한다 (#462)', async () => {
    const alarmEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '시청' };
    mockStorageValues(JSON.stringify(mockDestination));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent,
      nearest: { station: mockStation, distanceKm: 0.1 },
    });
    mockAlarmKey.mockReturnValue('destination:시청');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockAlarmKey).toHaveBeenCalledWith(alarmEvent);
    expect(mockSetFiredAlarms).toHaveBeenCalledWith(
      mockDestination.id,
      new Set(['destination:시청']),
    );
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:alarm-event',
      JSON.stringify(alarmEvent),
    );
  });

  it('기존 firedAlarms에 alarmEvent 키를 추가하여 저장한다', async () => {
    const alarmEvent: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '강남' };
    mockStorageValues(JSON.stringify(mockDestination));
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(['destination:시청']));

    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent,
      nearest: { station: mockStation, distanceKm: 0.1 },
    });
    mockAlarmKey.mockReturnValue('transfer:강남');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockSetFiredAlarms).toHaveBeenCalledWith(
      mockDestination.id,
      new Set(['destination:시청', 'transfer:강남']),
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

  it('destination에 id가 없으면 즉시 return한다 (#462)', async () => {
    mockStorageValues(JSON.stringify({ name: '시청' }));

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    expect(mockGetFiredAlarms).not.toHaveBeenCalled();
  });

  // ── 마지막 location 선택 ──

  it('locations 배열의 마지막 요소를 사용한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

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

  // 게이트 drop 시 destination/sleep/route 등 도메인 키는 절대 읽지 않는다.
  // (ALARM_LOG_KEY는 적재용으로 정상 read/write 됨 — B2 인프라)
  // firedAlarms는 notificationState helper로 분리됐으므로 mockGetFiredAlarms 호출 여부로 검증.
  const DOMAIN_KEYS = [
    'subway-now:destination',
    'subway-now:sleep-mode',
    'subway-now:route',
    'subway-now:allow-speaker',
  ];
  const expectGateBlocked = () => {
    const getItemKeys = (AsyncStorage.getItem as jest.Mock).mock.calls.map(([k]) => k);
    for (const key of DOMAIN_KEYS) {
      expect(getItemKeys).not.toContain(key);
    }
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  };

  it('stale 위치(timestamp MAX_LOCATION_AGE_MS 초과)는 무시한다', async () => {
    await runWithLocation(makeLocation(37.498, 127.028, { ageMs: MAX_LOCATION_AGE_MS + 1 }));
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

  it('저정확도 위치(accuracy MAX_ACCURACY_M 초과)는 무시한다', async () => {
    await runWithLocation(makeLocation(37.498, 127.028, { accuracy: MAX_ACCURACY_M + 1 }));
    expectGateBlocked();
  });

  // ── 알람 로그 적재 (B2 인프라) ──

  it('stale 위치 게이트 drop 시 logSuppressedGate(gate-age, location)을 호출한다', async () => {
    const ageMs = MAX_LOCATION_AGE_MS + 1_000;
    await runWithLocation(makeLocation(37.498, 127.028, { ageMs }));

    expect(mockLogSuppressedGate).toHaveBeenCalledWith(
      'gate-age',
      expect.objectContaining({ lat: 37.498, lng: 127.028 }),
    );
  });

  it('저정확도 게이트 drop 시 logSuppressedGate(gate-accuracy, location)을 호출한다', async () => {
    const accuracy = MAX_ACCURACY_M + 50;
    await runWithLocation(makeLocation(37.498, 127.028, { accuracy }));

    expect(mockLogSuppressedGate).toHaveBeenCalledWith(
      'gate-accuracy',
      expect.objectContaining({ accuracy }),
    );
  });

  // #2345 — 지하 accuracy 강등 gate. isAccuracyAcceptable early-return 직전에 카운터를 올린다.
  it('저정확도 게이트 drop 시 demoteToUndergroundIfNeeded(TASK)를 호출한다', async () => {
    const accuracy = MAX_ACCURACY_M + 50;
    await runWithLocation(makeLocation(37.498, 127.028, { accuracy }));

    expect(mockDemoteToUndergroundIfNeeded).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
  });

  it('demoteToUndergroundIfNeeded가 reject해도 태스크는 크래시하지 않는다 (graceful)', async () => {
    mockDemoteToUndergroundIfNeeded.mockRejectedValueOnce(new Error('demote failed'));
    const accuracy = MAX_ACCURACY_M + 50;

    await expect(runWithLocation(makeLocation(37.498, 127.028, { accuracy }))).resolves.toBeUndefined();
  });

  // ── #527 jump gate: trip 컨텍스트(destJson 통과) 이후에만 동작 ──

  it('비현실 점프(25km/8s)면 logSuppressedGate(gate-jump)를 호출하고 processLocationUpdate를 건너뛴다', async () => {
    const prevTs = Date.now() - 8_000;
    const prevFix = { lat: 37.5390, lng: 126.9610, timestamp: prevTs };
    // dest, sleep, route, BG_LAST_FIX_KEY (readBgLastFix 4번째 호출)
    (AsyncStorage.getItem as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify(mockDestination))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(prevFix));

    await taskCallback({
      data: { locations: [makeLocation(37.6128, 127.0966)] }, // 신내 ≈ 25km 떨어짐
      error: null,
    });

    expect(mockLogSuppressedGate).toHaveBeenCalledWith(
      'gate-jump',
      expect.objectContaining({ lat: 37.6128, lng: 127.0966 }),
    );
    expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
  });

  it('정상 이동이면 jump 게이트를 통과하고 BG_LAST_FIX_KEY를 갱신한다', async () => {
    const prevTs = Date.now() - 30_000;
    const prevFix = { lat: 37.498, lng: 127.027, timestamp: prevTs };
    (AsyncStorage.getItem as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify(mockDestination))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(prevFix));

    await taskCallback({
      data: { locations: [makeLocation(37.499, 127.028)] }, // ≈ 130m 이동, 4.3 m/s
      error: null,
    });

    expect(mockLogSuppressedGate).not.toHaveBeenCalled();
    expect(mockProcessLocationUpdate).toHaveBeenCalled();
    const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    expect(setItemCalls.some(([key]) => key === 'subway-now:bg-last-fix')).toBe(true);
  });

  it('BG_LAST_FIX_KEY가 없으면(콜드스타트) jump 게이트를 통과한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    // mockStorageValues는 3개만 mockOnce → 4번째 호출(BG_LAST_FIX_KEY)은 default(null)

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockLogSuppressedGate).not.toHaveBeenCalled();
    expect(mockProcessLocationUpdate).toHaveBeenCalled();
  });

  it('BG_LAST_FIX_KEY가 손상된 JSON이면 prev=null로 처리하여 통과한다', async () => {
    (AsyncStorage.getItem as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify(mockDestination))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('not-json');

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalled();
  });

  it('BG_LAST_FIX_KEY가 형식 불일치 객체면 prev=null로 처리하여 통과한다', async () => {
    (AsyncStorage.getItem as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify(mockDestination))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalled();
  });

  it('accuracy가 임계값(MAX_ACCURACY_M) 이내면 통과한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { accuracy: MAX_ACCURACY_M - 50 })] },
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

  // LAST_NOTIFIED_STATION_KEY 직접 read/write는 stationPipeline 내부 notificationState 모듈로 이관됨.
  // 백그라운드 태스크는 더 이상 이 키를 직접 다루지 않으며, 관련 동작 검증은
  // - stationPipeline.test.ts (read/write 시점)
  // - notificationState.test.ts (실제 AsyncStorage I/O)
  // 에서 커버한다.

  it('백그라운드 태스크는 LAST_NOTIFIED_STATION_KEY를 직접 read/write 하지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith('subway-now:last-notified-station');
    const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    for (const [key] of setItemCalls) {
      expect(key).not.toBe('subway-now:last-notified-station');
    }
  });

  it('GPS speed가 양수이면 speedMps로 processLocationUpdate에 전달한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { speed: 12.5 })] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({ speedMps: 12.5 }));
  });

  it('GPS speed가 음수이면 speedMps를 null로 정규화한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028, { speed: -1 })] },
      error: null,
    });

    expect(mockProcessLocationUpdate).toHaveBeenCalledWith(expect.objectContaining({ speedMps: null }));
  });

  // ── #711: BG_LAST_STATION_KEY write ──

  it('#711: nearest가 있으면 BG_LAST_STATION_KEY에 station/distanceKm/timestamp를 적재한다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: mockStation, distanceKm: 0.42 },
    });

    const fixTs = Date.now();
    const loc = makeLocation(37.498, 127.028);
    loc.timestamp = fixTs;

    await taskCallback({ data: { locations: [loc] }, error: null });

    const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    const bgLastCall = setItemCalls.find(([key]) => key === 'subway-now:bg-last-station');
    expect(bgLastCall).toBeDefined();
    const payload = JSON.parse(bgLastCall![1]);
    expect(payload.station.id).toBe(mockStation.id);
    expect(payload.distanceKm).toBe(0.42);
    expect(payload.timestamp).toBe(fixTs);
  });

  it('#711: nearest가 null이면 BG_LAST_STATION_KEY를 쓰지 않는다', async () => {
    mockStorageValues(JSON.stringify(mockDestination));
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await taskCallback({
      data: { locations: [makeLocation(37.498, 127.028)] },
      error: null,
    });

    const setItemCalls = (AsyncStorage.setItem as jest.Mock).mock.calls;
    expect(setItemCalls.every(([key]) => key !== 'subway-now:bg-last-station')).toBe(true);
  });

  // ── #1237 Phase 2: BG widget writer ──

  describe('#1237 — BG tick에서 위젯 SSOT(saveStationToWidget) 갱신', () => {
    it('nearest 정상 → saveStationToWidget(station, distanceKm, undefined, undefined, tripContext) 호출 (#1929 F-W3)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      mockProcessLocationUpdate.mockResolvedValue({
        alarmEvent: null,
        nearest: { station: mockStation, distanceKm: 0.42 },
      });

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      });

      // #1929 F-W3: tripContext stamp — destination 있고 currentStation=nearest이면 tripActive: true
      expect(mockSaveStationToWidget).toHaveBeenCalledWith(
        mockStation,
        0.42,
        undefined,
        undefined,
        expect.objectContaining({
          tripActive: true,
          destinationName: mockDestination.name,
          currentStationName: mockStation.name,
        }),
      );
    });

    it('#1929 F-W3 — direct route(transfer 0개) → nextTransferName undefined로 stamp', async () => {
      const directRoute = {
        type: 'direct',
        stops: 5,
        line: '2',
        travelSeconds: 600,
      };
      mockStorageValues(JSON.stringify(mockDestination), null, JSON.stringify(directRoute));
      mockProcessLocationUpdate.mockResolvedValue({
        alarmEvent: null,
        nearest: { station: mockStation, distanceKm: 0.42 },
      });

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      });

      expect(mockSaveStationToWidget).toHaveBeenCalledWith(
        mockStation,
        0.42,
        undefined,
        undefined,
        expect.objectContaining({
          tripActive: true,
          nextTransferName: undefined,
        }),
      );
    });

    it('#1929 F-W3 — transfer route → nextTransferName으로 transferName stamp', async () => {
      const transferRoute = {
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 3,
        stopsFromTransfer: 4,
        secondsToTransfer: 360,
        secondsFromTransfer: 480,
      };
      mockStorageValues(JSON.stringify(mockDestination), null, JSON.stringify(transferRoute));
      mockProcessLocationUpdate.mockResolvedValue({
        alarmEvent: null,
        nearest: { station: mockStation, distanceKm: 0.42 },
      });

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      });

      expect(mockSaveStationToWidget).toHaveBeenCalledWith(
        mockStation,
        0.42,
        undefined,
        undefined,
        expect.objectContaining({
          tripActive: true,
          nextTransferName: '교대',
        }),
      );
    });

    it('nearest가 null이면 saveStationToWidget 호출 X (clearWidgetStation도 호출 X)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      });

      expect(mockSaveStationToWidget).not.toHaveBeenCalled();
    });

    it('destJson 미설정으로 조기 return하는 경우 saveStationToWidget 호출 X', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028)] },
        error: null,
      });

      expect(mockSaveStationToWidget).not.toHaveBeenCalled();
    });
  });

  describe('#819 — backend로 position + motion 송신', () => {
    /**
     * mockStorageValues 3번 chain(dest/sleep/route) 후 task code는
     * readBgLastFix(`getItem(BG_LAST_FIX_KEY)`)를 한 번, 그 다음 `getItem(APNS_TOKEN_KEY)`를 한
     * 번 호출한다. 따라서 4번째에 null(=fresh fix, 점프 검사 통과), 5번째에 token을 chain한다.
     * 안 그러면 APNS_TOKEN_KEY 자리에 BG_LAST_FIX 값이 들어가 uploadPosition 호출 안 됨.
     */
    function stubApnsTokenAfterStorage(token: string | null): void {
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY — prevFix 없음
        .mockResolvedValueOnce(token); // APNS_TOKEN_KEY
    }

    /**
     * #2093 (A) — BG_LAST_FIX_KEY(prevFix 없음) + APNS_TOKEN_KEY + BG_LAST_POSITION_UPLOAD_AT_KEY
     * 3단 체인. lastUploadAt을 명시 제어해 min-interval 쿨다운 분기를 검증한다.
     */
    function stubApnsTokenWithLastUploadAt(token: string | null, lastUploadAt: number | null): void {
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY — prevFix 없음
        .mockResolvedValueOnce(token) // APNS_TOKEN_KEY
        .mockResolvedValueOnce(lastUploadAt === null ? null : String(lastUploadAt)); // BG_LAST_POSITION_UPLOAD_AT_KEY
    }

    it('APNs token 있고 motion stationary=false → uploadPosition(unknown) 호출', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      mockGetCurrentMotionStationary.mockReturnValue(false);

      const fixTs = Date.now();
      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      loc.timestamp = fixTs;
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).toHaveBeenCalledWith({
        token: 'apns-tok-1',
        lat: 37.498,
        lng: 127.028,
        accuracy: 10,
        ts: fixTs,
        motion: 'unknown',
      });
    });

    it('motion stationary=true → motion=stationary로 송신', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      mockGetCurrentMotionStationary.mockReturnValue(true);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      const call = mockUploadPosition.mock.calls[0]?.[0];
      expect(call?.motion).toBe('stationary');
    });

    it('APNs token 부재 → uploadPosition 미호출 (graceful)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage(null);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).not.toHaveBeenCalled();
    });

    describe('#2093 (A) — POST /position 최소 간격 가드', () => {
      it('직전 업로드로부터 POSITION_UPLOAD_MIN_INTERVAL_MS 이내 → uploadPosition 미호출 (쿨다운)', async () => {
        mockStorageValues(JSON.stringify(mockDestination));
        const now = Date.now();
        // 실행 지연(테스트 setup ↔ task 내부 Date.now() 사이 real elapsed ms)에 flaky해지지 않도록
        // 경계값(-1ms)이 아닌 충분한 여유(-1s)를 둔다 — 여전히 min interval 이내임을 보장.
        stubApnsTokenWithLastUploadAt('apns-tok-1', now - (POSITION_UPLOAD_MIN_INTERVAL_MS - 1_000));

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).not.toHaveBeenCalled();
        // 쿨다운 중엔 준비 비용(accel fingerprint 시작)도 함께 skip.
        expect(mockStartAccelerometerFingerprint).not.toHaveBeenCalled();
        expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
          expect.stringContaining('bg-last-position-upload-at'),
          expect.anything(),
        );
      });

      it('직전 업로드로부터 POSITION_UPLOAD_MIN_INTERVAL_MS 경과 → uploadPosition 재개 + 타임스탬프 갱신', async () => {
        mockStorageValues(JSON.stringify(mockDestination));
        const now = Date.now();
        stubApnsTokenWithLastUploadAt('apns-tok-1', now - (POSITION_UPLOAD_MIN_INTERVAL_MS + 1));

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledTimes(1);
        expect(AsyncStorage.setItem).toHaveBeenCalledWith(
          'subway-now:bg-last-position-upload-at',
          expect.any(String),
        );
      });

      it('lastUploadAt 없음(최초 fix) → 즉시 업로드', async () => {
        mockStorageValues(JSON.stringify(mockDestination));
        stubApnsTokenWithLastUploadAt('apns-tok-1', null);

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledTimes(1);
      });

      it('BG_LAST_POSITION_UPLOAD_AT_KEY read throw → graceful null 취급(즉시 업로드)', async () => {
        mockStorageValues(JSON.stringify(mockDestination));
        (AsyncStorage.getItem as jest.Mock)
          .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY
          .mockResolvedValueOnce('apns-tok-1') // APNS_TOKEN_KEY
          .mockRejectedValueOnce(new Error('boom')); // BG_LAST_POSITION_UPLOAD_AT_KEY

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledTimes(1);
      });

      it('BG_LAST_POSITION_UPLOAD_AT_KEY 값이 숫자로 파싱 불가 → null 취급(즉시 업로드)', async () => {
        mockStorageValues(JSON.stringify(mockDestination));
        (AsyncStorage.getItem as jest.Mock)
          .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY
          .mockResolvedValueOnce('apns-tok-1') // APNS_TOKEN_KEY
          .mockResolvedValueOnce('not-a-number'); // BG_LAST_POSITION_UPLOAD_AT_KEY (손상값)

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledTimes(1);
      });
    });

    it('AsyncStorage.getItem(APNS_TOKEN_KEY) throw → 무시하고 uploadPosition 미호출', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      // 4번째 call: BG_LAST_FIX_KEY null, 5번째 call: APNS_TOKEN_KEY에서 throw
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('boom'));

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).not.toHaveBeenCalled();
    });

    it('accuracy null fix는 isAccuracyAcceptable 통과 후 송신 시 0으로 강등', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');

      // isAccuracyAcceptable(null)=true → gate 통과 → uploadPosition 분기 진입 → `accuracy ?? 0`로 0.
      const loc = makeLocation(37.498, 127.028, { accuracy: null });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).toHaveBeenCalledWith(
        expect.objectContaining({ accuracy: 0 }),
      );
    });

    it('#823 — fresh accelSummary는 payload에 첨부', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      const now = Date.now();
      const accel = {
        startTs: now - 1000,
        endTs: now - 500, // 500ms 전 — stale 가드 통과
        count: 100,
        ax: 0.1,
        ay: 0.2,
        az: 0.3,
        magnitudeMean: 0.5,
        magnitudeStd: 0.1,
        magnitudePeak: 1.2,
      };
      mockGetLatestAccelSummary.mockReturnValue(accel);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).toHaveBeenCalledWith(
        expect.objectContaining({ accelSummary: accel }),
      );
    });

    it('#823 — stale accelSummary(>5s)는 첨부하지 않음', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      const now = Date.now();
      const accel = {
        startTs: now - 11_000,
        endTs: now - 10_000, // 10초 전 — stale 가드에 걸림
        count: 100,
        ax: 0.1,
        ay: 0.2,
        az: 0.3,
        magnitudeMean: 0.5,
        magnitudeStd: 0.1,
        magnitudePeak: 1.2,
      };
      mockGetLatestAccelSummary.mockReturnValue(accel);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      const call = mockUploadPosition.mock.calls[0]?.[0];
      expect(call?.accelSummary).toBeUndefined();
    });

    it('#823 — latest accelSummary 부재면 accelSummary 키는 undefined로 송신', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      mockGetLatestAccelSummary.mockReturnValue(null);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      const call = mockUploadPosition.mock.calls[0]?.[0];
      expect(call?.accelSummary).toBeUndefined();
    });
  });

  describe('#1291 — BG 알람 모션 게이트 (주머니 지하 오발사 억제)', () => {
    it('motionStationary=true이면 processLocationUpdate를 호출하지 않는다 (억제)', async () => {
      mockGetCurrentMotionStationary.mockReturnValue(true);
      mockStorageValues(JSON.stringify(mockDestination));

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
        error: null,
      });

      expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    });

    it('motionStationary=true이면 logSuppressedGate(gate-motion-stationary)를 호출한다', async () => {
      mockGetCurrentMotionStationary.mockReturnValue(true);
      mockStorageValues(JSON.stringify(mockDestination));

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
        error: null,
      });

      expect(mockLogSuppressedGate).toHaveBeenCalledWith(
        'gate-motion-stationary',
        expect.objectContaining({ lat: 37.498, lng: 127.028 }),
      );
    });

    it('motionStationary=false이면 processLocationUpdate를 호출한다 (회귀 없음 — 이동 중)', async () => {
      mockGetCurrentMotionStationary.mockReturnValue(false);
      mockStorageValues(JSON.stringify(mockDestination));
      mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
        error: null,
      });

      expect(mockProcessLocationUpdate).toHaveBeenCalled();
    });

    it('motionStationary=true여도 uploadPosition(motion=stationary)은 정상 호출된다 (업로드 후 게이트)', async () => {
      mockGetCurrentMotionStationary.mockReturnValue(true);
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(mockDestination))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)  // BG_LAST_FIX_KEY
        .mockResolvedValueOnce('apns-tok-1'); // APNS_TOKEN_KEY

      await taskCallback({
        data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
        error: null,
      });

      expect(mockUploadPosition).toHaveBeenCalledWith(expect.objectContaining({ motion: 'stationary' }));
      expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    });

    describe('#2344 (V8a) — BG location profile 전환', () => {
      it('motionStationary=true → applyBgLocationProfile(TASK, "stationary") 호출', async () => {
        mockGetCurrentMotionStationary.mockReturnValue(true);
        mockStorageValues(JSON.stringify(mockDestination));

        await taskCallback({
          data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
          error: null,
        });

        expect(mockApplyBgLocationProfile).toHaveBeenCalledWith(
          BACKGROUND_LOCATION_TASK,
          'stationary',
        );
      });

      it('motionStationary=false → applyBgLocationProfile(TASK, "surface") 호출', async () => {
        mockGetCurrentMotionStationary.mockReturnValue(false);
        mockStorageValues(JSON.stringify(mockDestination));

        await taskCallback({
          data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
          error: null,
        });

        expect(mockApplyBgLocationProfile).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK, 'surface');
      });

      it('applyBgLocationProfile이 reject해도 태스크는 크래시하지 않는다 (graceful)', async () => {
        mockGetCurrentMotionStationary.mockReturnValue(true);
        mockApplyBgLocationProfile.mockRejectedValueOnce(new Error('restart failed'));
        mockStorageValues(JSON.stringify(mockDestination));

        await expect(
          taskCallback({
            data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
            error: null,
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe('#2345 — 지하 accuracy 강등: gate-accuracy 통과 시 underground eager release', () => {
      it('gate-accuracy를 통과하면 releaseFromUndergroundIfNeeded(TASK)를 호출한다', async () => {
        mockStorageValues(JSON.stringify(mockDestination));

        await taskCallback({
          data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
          error: null,
        });

        expect(mockReleaseFromUndergroundIfNeeded).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
      });

      it('eager release가 일어났으면(true) motion 기반 applyBgLocationProfile을 중복 호출하지 않는다', async () => {
        mockReleaseFromUndergroundIfNeeded.mockResolvedValueOnce(true);
        mockGetCurrentMotionStationary.mockReturnValue(true);
        mockStorageValues(JSON.stringify(mockDestination));

        await taskCallback({
          data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
          error: null,
        });

        expect(mockApplyBgLocationProfile).not.toHaveBeenCalled();
      });

      it('eager release가 일어나지 않았으면(false) motion 기반 applyBgLocationProfile을 정상 호출한다', async () => {
        mockReleaseFromUndergroundIfNeeded.mockResolvedValueOnce(false);
        mockGetCurrentMotionStationary.mockReturnValue(false);
        mockStorageValues(JSON.stringify(mockDestination));

        await taskCallback({
          data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
          error: null,
        });

        expect(mockApplyBgLocationProfile).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK, 'surface');
      });

      it('releaseFromUndergroundIfNeeded가 reject해도 태스크는 크래시하지 않고 motion 기반 전환을 계속 진행한다 (graceful)', async () => {
        mockReleaseFromUndergroundIfNeeded.mockRejectedValueOnce(new Error('release failed'));
        mockGetCurrentMotionStationary.mockReturnValue(false);
        mockStorageValues(JSON.stringify(mockDestination));

        await expect(
          taskCallback({
            data: { locations: [makeLocation(37.498, 127.028, { accuracy: 30 })] },
            error: null,
          }),
        ).resolves.toBeUndefined();
        expect(mockApplyBgLocationProfile).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK, 'surface');
      });
    });

    describe('#1667 (ADR-015 strongDB wire) — wifiSsidStationName forward', () => {
      function stubApnsToken(token: string): void {
        (AsyncStorage.getItem as jest.Mock)
          .mockResolvedValueOnce(JSON.stringify(mockDestination))
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY
          .mockResolvedValueOnce(token); // APNS_TOKEN_KEY
      }

      it('WiFi 매칭 성공 → uploadPosition에 wifiSsidStationName 포함', async () => {
        stubApnsToken('apns-tok-wifi');
        mockGetCurrentWifiSsid.mockResolvedValue('T_subway_gangnam_01');
        mockLookupStationBySsid.mockReturnValue({ name: '강남' });

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledWith(
          expect.objectContaining({ wifiSsidStationName: '강남' }),
        );
      });

      it('WiFi 미연결(null) → uploadPosition에 wifiSsidStationName 없음', async () => {
        stubApnsToken('apns-tok-wifi');
        mockGetCurrentWifiSsid.mockResolvedValue(null);
        mockLookupStationBySsid.mockReturnValue(null);

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        const call = mockUploadPosition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(call?.wifiSsidStationName).toBeUndefined();
      });

      it('WiFi SSID 매핑 미일치 → uploadPosition에 wifiSsidStationName 없음', async () => {
        stubApnsToken('apns-tok-wifi');
        mockGetCurrentWifiSsid.mockResolvedValue('unknown-ssid');
        mockLookupStationBySsid.mockReturnValue(null);

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        const call = mockUploadPosition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(call?.wifiSsidStationName).toBeUndefined();
      });

      it('getCurrentWifiSsid throw → graceful, wifiSsidStationName 없이 uploadPosition 정상 호출', async () => {
        stubApnsToken('apns-tok-wifi');
        mockGetCurrentWifiSsid.mockRejectedValue(new Error('wifi error'));

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalled();
        const call = mockUploadPosition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(call?.wifiSsidStationName).toBeUndefined();
      });
    });
  });

  describe('#1542 (ADR-016 S9) — accelerometer fingerprint BG piggyback', () => {
    /** Phase B 전용 token chain — APNS token after storage 3 + BG_LAST_FIX null. */
    function stubApnsTokenAfterStorage(token: string | null): void {
      (AsyncStorage.getItem as jest.Mock)
        .mockResolvedValueOnce(null) // BG_LAST_FIX_KEY — prevFix 없음
        .mockResolvedValueOnce(token); // APNS_TOKEN_KEY
    }

    it('apnsToken 있으면 BG fingerprint start 호출 (Background Location piggyback)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockStartAccelerometerFingerprint).toHaveBeenCalledTimes(1);
    });

    it('apnsToken 부재면 BG fingerprint start 미호출 (graceful)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage(null);

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockStartAccelerometerFingerprint).not.toHaveBeenCalled();
    });

    it.each<'stationary' | 'walking' | 'automotive'>(['stationary', 'walking', 'automotive'])(
      'accelerometer pattern=%s → motion 필드 그대로 채택 (motionActivity 무시)',
      async (pattern) => {
        mockStorageValues(JSON.stringify(mockDestination));
        stubApnsTokenAfterStorage('apns-tok-1');
        // motionActivity는 false(이동 중)지만 accelerometer 분류가 우선.
        mockGetCurrentMotionStationary.mockReturnValue(false);
        mockClassifyAccelerometerPattern.mockReturnValue(pattern);

        const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
        await taskCallback({ data: { locations: [loc] }, error: null });

        expect(mockUploadPosition).toHaveBeenCalledWith(
          expect.objectContaining({ motion: pattern }),
        );
      },
    );

    it('accelerometer unknown + motionActivity stationary → motion=stationary (fallback)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      mockGetCurrentMotionStationary.mockReturnValue(true);
      mockClassifyAccelerometerPattern.mockReturnValue('unknown');

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).toHaveBeenCalledWith(
        expect.objectContaining({ motion: 'stationary' }),
      );
    });

    it('accelerometer unknown + motionActivity false → motion=unknown (기존 #819 정책)', async () => {
      mockStorageValues(JSON.stringify(mockDestination));
      stubApnsTokenAfterStorage('apns-tok-1');
      mockGetCurrentMotionStationary.mockReturnValue(false);
      mockClassifyAccelerometerPattern.mockReturnValue('unknown');

      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });

      expect(mockUploadPosition).toHaveBeenCalledWith(
        expect.objectContaining({ motion: 'unknown' }),
      );
    });
  });

  // #2178 — pull 기반 trip 死 backstop. 내부 판정/cleanup 로직 자체는 tripDeathPullBackstop.test.ts가
  // 전담 — 여기서는 BG location tick이 GPS 게이트와 무관하게 wiring하는지만 검증한다.
  describe('#2178 — pull death backstop (tick 진입 즉시)', () => {
    it('baseUrl 미설정 → checkTripDeathByPull 호출 안 함', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue(null);
      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });
      expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
    });

    it('baseUrl 설정 → checkTripDeathByPull(baseUrl, "bg-location-tick") 호출', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue('https://api.test.dev');
      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });
      await taskCallback({ data: { locations: [loc] }, error: null });
      expect(mockCheckTripDeathByPull).toHaveBeenCalledWith(
        'https://api.test.dev',
        'bg-location-tick',
      );
    });

    it('저정확도/stale fix로 이후 게이트가 drop되는 fix라도 backstop은 호출됨(GPS 품질 무관)', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue('https://api.test.dev');
      // gate-age에 걸리는 오래된 fix.
      const staleLoc = makeLocation(37.498, 127.028, { ageMs: MAX_LOCATION_AGE_MS + 60_000 });
      await taskCallback({ data: { locations: [staleLoc] }, error: null });
      expect(mockCheckTripDeathByPull).toHaveBeenCalledWith(
        'https://api.test.dev',
        'bg-location-tick',
      );
      // 게이트 자체는 그대로 차단 — backstop 추가가 기존 게이트 동작을 바꾸지 않음을 함께 확인.
      expect(mockProcessLocationUpdate).not.toHaveBeenCalled();
    });

    it('checkTripDeathByPull throw해도 graceful (기존 알람 파이프라인 차단 없음)', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue('https://api.test.dev');
      mockCheckTripDeathByPull.mockRejectedValueOnce(new Error('backend-fail'));
      mockStorageValues(JSON.stringify(mockDestination));
      const loc = makeLocation(37.498, 127.028, { accuracy: 10 });

      await expect(
        taskCallback({ data: { locations: [loc] }, error: null }),
      ).resolves.toBeUndefined();
      expect(mockProcessLocationUpdate).toHaveBeenCalled();
    });

    it('error 분기 → checkTripDeathByPull 호출 안 함 (기존 early-return 유지)', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue('https://api.test.dev');
      await taskCallback({ data: null, error: { message: '위치 오류' } });
      expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
    });

    it('data 없음 분기 → checkTripDeathByPull 호출 안 함 (기존 early-return 유지)', async () => {
      mockGetTripDeathPullBackendUrl.mockReturnValue('https://api.test.dev');
      await taskCallback({ data: null, error: null });
      expect(mockCheckTripDeathByPull).not.toHaveBeenCalled();
    });
  });
});

describe('pickMotionLabel (#1542 ADR-016 S9)', () => {
  // 별 describe — pure helper. backgroundLocationTask scope 외부에서 직접 unit test.
  // accelerometer pattern이 'unknown'이 아니면 motionActivity stationary 무시 — RMS 60s 진동이
  // CMMotionActivity의 5~10분 intermittent flip(lesson_motion_activity_intermittent_signal)보다 강.
  const { pickMotionLabel } = jest.requireActual('../backgroundLocationTask');

  it.each<['stationary' | 'walking' | 'automotive']>([
    ['stationary'],
    ['walking'],
    ['automotive'],
  ])('accelerometer pattern=%s + motionActivity false → 그대로 그 pattern', (pattern) => {
    expect(pickMotionLabel(pattern, false)).toBe(pattern);
  });

  it.each<['stationary' | 'walking' | 'automotive']>([
    ['stationary'],
    ['walking'],
    ['automotive'],
  ])('accelerometer pattern=%s + motionActivity true → 그대로 그 pattern (accelerometer 우선)', (pattern) => {
    expect(pickMotionLabel(pattern, true)).toBe(pattern);
  });

  it('accelerometer unknown + motionActivity true → stationary (fallback)', () => {
    expect(pickMotionLabel('unknown', true)).toBe('stationary');
  });

  it('accelerometer unknown + motionActivity false → unknown (기존 #819 정책)', () => {
    expect(pickMotionLabel('unknown', false)).toBe('unknown');
  });
});
