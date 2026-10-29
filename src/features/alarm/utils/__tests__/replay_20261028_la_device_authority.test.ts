/**
 * #2735 PR-4 replay — device LA 쓰기 권위 게이트를 실측 덤프의 silent push 수신 시각으로 재생한다.
 *
 * fixture 데이터는 실측이고 불변이다(통과시키려고 조정하지 않는다).
 *   - trip 180 (2026-10-28 저녁): `~/Downloads/텍스트-47A7E6D831B4-1.txt`(17:49 KST 덤프) Alarm log 의
 *     `silent-push-received` 행 + `live-activity-updated` 행. LA token 등록 17:13:29, lock 17:24:55
 *     (D1 trip_events export `te.txt` 83·84·101행).
 *   - 공백 653s: `~/Downloads/텍스트-01339A132F26-1.txt`(2026-06-30 덤프) `silent-push-received`
 *     13:20:21 -> 13:31:14.
 *
 * 이 파일은 invariants `liveActivityMirrorSync.ts` "권위 면제" 항목과 "device 쓰기는 backend 침묵을
 * 관측하지 못한다" 항목을 승격한 whole-chain 테스트다: 채널(실제 판정) -> refresh(D3) / mirror 코어(D2) 를
 * mock 없이 연결하고 마지막 소비자(`LiveActivity.updateLiveActivity`)가 호출됐는지를 assert 한다.
 */
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockAddPushTokenListener = jest.fn();
jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => true,
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  hasActiveLiveActivity: () => true,
}));
jest.mock('../../../../../modules/live-activity', () => ({
  startLiveActivity: jest.fn().mockResolvedValue(undefined),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  hasActiveLiveActivity: () => true,
  requestLiveActivityPushToken: async () => null,
  addPushTokenListener: (...args: unknown[]) => mockAddPushTokenListener(...args),
}));

jest.mock('../../api/alarmBackend', () => ({
  registerLiveActivityToken: jest.fn().mockResolvedValue({ ok: true }),
  clearLiveActivityToken: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../stationNotification', () => ({
  buildLiveActivityData: () => ({ stationName: 'STN', lineName: 'L', lineColorHex: '#000', distanceM: 0 }),
}));

const mockDecisions: string[] = [];
jest.mock('../alarmLog', () => ({
  logLaWrite: jest.fn(),
  logLaRefreshDecision: (decision: string) => mockDecisions.push(decision),
  logLiveActivityAuthorityState: jest.fn(),
  logLiveActivityUpdated: jest.fn(),
  logLiveActivityTokenRegister: jest.fn(),
  logLiveActivityLifecycle: jest.fn(),
  logLiveActivityMirrorSkip: jest.fn(),
  resetLiveActivityMirrorSkipTracking: jest.fn(),
}));

const mockReadBackendSsotMirror = jest.fn(async () => null as unknown);
jest.mock('../backendSsotMirror', () => ({
  ...jest.requireActual('../backendSsotMirror'),
  readBackendSsotMirror: () => mockReadBackendSsotMirror(),
}));

jest.mock('../../../../data/stations.json', () => [
  { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
  { id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 },
]);

import { Platform } from 'react-native';
import {
  __resetLiveActivityPushChannelForTests,
  markBackendLiveActivityTokenMissing,
  startLiveActivityWithRegistration,
} from '../liveActivityPushChannel';
import { refreshLiveActivityFromBackgroundContext } from '../refreshLiveActivityFromBackgroundContext';
import { setLastSilentPushReceivedAt } from '../lastSilentPushReceivedAt';
import {
  ACTIVE_TRIP_KEY,
  BG_LAST_STATION_KEY,
  BOARDING_LOCK_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../../shared/constants/storageKeys';

const kst = (date: string, hms: string): number => new Date(`${date}T${hms}+09:00`).getTime();

// --- 실측 fixture (불변) -------------------------------------------------------------------------
const TRIP_180_DATE = '2026-10-28';
const TRIP_180_REGISTERED_AT = '17:13:29';
const TRIP_180_LOCK_AT = '17:24:55';
/** Alarm log `silent-push-received` (SSoT 없는 reschedule/mid-cycle 포함). */
const TRIP_180_SILENT_PUSH = [
  '17:26:07',
  '17:27:16',
  '17:28:48',
  '17:29:17',
  '17:30:49',
  '17:31:48',
  '17:32:48',
  '17:33:52',
];
/** Alarm log `live-activity-updated` 중 lock(17:24:55) 이후 — device writer가 backend를 덮은 8건(plan §1 P1). */
const TRIP_180_POST_LOCK_DEVICE_WRITES = [
  '17:31:48',
  '17:31:49',
  '17:31:57',
  '17:31:57',
  '17:31:57',
  '17:31:57',
  '17:32:48',
  '17:33:52',
];
/** Alarm log `live-activity-updated` 중 lock 이전(lockless) — 유지돼야 하는 9건. */
const TRIP_180_LOCKLESS_DEVICE_WRITES = [
  '17:19:28',
  '17:19:31',
  '17:19:39',
  '17:20:03',
  '17:20:29',
  '17:23:13',
  '17:23:32',
  '17:24:06',
  '17:24:10',
];

const GAP_DATE = '2026-06-30';
const GAP_653_SILENT_PUSH = ['13:20:21', '13:31:14', '13:32:14', '13:37:14', '13:38:14', '13:39:14'];
// -----------------------------------------------------------------------------------------------

const destination = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };
const bgStation = { id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 };
const mirrorAt = (at: number) => ({
  currentStationId: '성수',
  currentStationLine: '2',
  motionState: 'moving',
  lastAdvanceEvidence: 'cron',
  lastAdvanceAt: at,
  passedStations: [],
  receivedAt: at,
});

function putLock(at: number): void {
  mockStore.set(
    BOARDING_LOCK_KEY,
    JSON.stringify({
      destinationId: '0228',
      trainCode: '7123',
      boardingStationId: '0328',
      boardingLine: '2',
      boardedAt: at,
      expectedDurationMs: 600_000,
    }),
  );
}

/** silent push 핸들러가 wake마다 하는 일: stamp -> LA refresh. */
async function wakeAt(
  at: number,
  { stamp = true, withMirror = false }: { stamp?: boolean; withMirror?: boolean } = {},
): Promise<void> {
  jest.setSystemTime(at);
  if (stamp) await setLastSilentPushReceivedAt(at);
  mockStore.set(BG_LAST_STATION_KEY, JSON.stringify({ station: bgStation, distanceKm: 0.1, timestamp: at }));
  mockReadBackendSsotMirror.mockResolvedValue(withMirror ? mirrorAt(at) : null);
  await refreshLiveActivityFromBackgroundContext();
}

async function registerOkAt(at: number): Promise<void> {
  jest.setSystemTime(at);
  let emit: (token: string) => void = () => undefined;
  mockAddPushTokenListener.mockImplementation((cb: (e: { token: string }) => void) => {
    emit = (token) => cb({ token });
    return { remove: jest.fn() };
  });
  await startLiveActivityWithRegistration('apns-trip-180', {
    stationName: '뚝섬',
    lineName: '2호선',
    lineColorHex: '#00A84D',
    distanceM: 0,
  });
  emit('la-token');
  await jest.advanceTimersByTimeAsync(0);
}

describe('replay 20261028 — LA device 권위 게이트 (#2735 PR-4)', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    mockStore.clear();
    mockDecisions.length = 0;
    mockUpdateLiveActivity.mockClear();
    __resetLiveActivityPushChannelForTests();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    mockStore.set(DESTINATION_KEY, JSON.stringify(destination));
    mockStore.set(ROUTE_KEY, JSON.stringify({ type: 'direct', line: '2', stops: 1 }));
    mockStore.set(ACTIVE_TRIP_KEY, 'apns-trip-180');
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  describe('trip 180', () => {
    it('lock(17:24:55) 이후 device writer 8건 시각 — D3(gps-bg)와 D2(mirror) 모두 updateLiveActivity 0회', async () => {
      await registerOkAt(kst(TRIP_180_DATE, TRIP_180_REGISTERED_AT));
      putLock(kst(TRIP_180_DATE, TRIP_180_LOCK_AT));
      const stamps = TRIP_180_SILENT_PUSH.map((t) => kst(TRIP_180_DATE, t));

      for (const hms of TRIP_180_POST_LOCK_DEVICE_WRITES) {
        const at = kst(TRIP_180_DATE, hms);
        // 해당 시각까지의 가장 최근 수신 stamp(실측) — wake 자체가 수신이므로 같은 초면 그 시각.
        const latest = Math.max(...stamps.filter((s) => s <= at));
        jest.setSystemTime(at);
        await setLastSilentPushReceivedAt(latest);
        for (const withMirror of [false, true]) {
          mockStore.set(BG_LAST_STATION_KEY, JSON.stringify({ station: bgStation, distanceKm: 0.1, timestamp: at }));
          mockReadBackendSsotMirror.mockResolvedValue(withMirror ? mirrorAt(at) : null);
          await refreshLiveActivityFromBackgroundContext();
        }
      }

      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      expect(mockDecisions).toEqual(Array(TRIP_180_POST_LOCK_DEVICE_WRITES.length * 2).fill('backend-authority-skip'));
    });

    it('SSoT 없는 wake 5건(17:26:07·17:27:16·17:28:48·17:29:17·17:30:49) — 전부 skip (lock 후 첫 wake부터)', async () => {
      await registerOkAt(kst(TRIP_180_DATE, TRIP_180_REGISTERED_AT));
      putLock(kst(TRIP_180_DATE, TRIP_180_LOCK_AT));
      for (const hms of TRIP_180_SILENT_PUSH.slice(0, 5)) {
        await wakeAt(kst(TRIP_180_DATE, hms));
      }
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('[거부] lockless 구간(lock 17:24:55 이전) device writer 9건 시각 — 쓰기가 유지된다', async () => {
      await registerOkAt(kst(TRIP_180_DATE, TRIP_180_REGISTERED_AT));
      // lock 없음. 신선한 silent push(heartbeat)가 있어도 게이트는 lock을 요구한다.
      for (const hms of TRIP_180_LOCKLESS_DEVICE_WRITES) {
        await wakeAt(kst(TRIP_180_DATE, hms));
      }
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(TRIP_180_LOCKLESS_DEVICE_WRITES.length);
    });

    it('token-missing 응답 직후 첫 wake부터 device 쓰기가 재개되고, 재등록 성공하면 다시 skip', async () => {
      await registerOkAt(kst(TRIP_180_DATE, TRIP_180_REGISTERED_AT));
      putLock(kst(TRIP_180_DATE, TRIP_180_LOCK_AT));
      await wakeAt(kst(TRIP_180_DATE, '17:26:07'));
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();

      markBackendLiveActivityTokenMissing();
      await jest.advanceTimersByTimeAsync(0);
      await wakeAt(kst(TRIP_180_DATE, '17:27:16'));
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

      await registerOkAt(kst(TRIP_180_DATE, '17:27:30'));
      await wakeAt(kst(TRIP_180_DATE, '17:28:48'));
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });
  });

  describe('공백 653s (13:20:21 -> 13:31:14)', () => {
    it('T=10분 지점(13:30:21 skip -> 13:30:22 device 재개)에서 풀리고, 다음 수신(13:31:14)에 다시 skip', async () => {
      const day = GAP_DATE;
      await registerOkAt(kst(day, '13:10:00'));
      putLock(kst(day, '13:12:00'));
      await wakeAt(kst(day, '13:20:21')); // 실측 수신
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();

      // 수신 없는 wake(BG location 등): stamp는 건드리지 않는다.
      await wakeAt(kst(day, '13:30:21'), { stamp: false });
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled(); // 공백 600s == T -> 아직 backend 권위

      await wakeAt(kst(day, '13:30:22'), { stamp: false });
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1); // 601s > T -> device 재개

      await wakeAt(kst(day, '13:31:13'), { stamp: false });
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2); // 수신 전까지 계속 device

      await wakeAt(kst(day, '13:31:14')); // 실측 수신 -> 권위 복귀
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);

      for (const hms of GAP_653_SILENT_PUSH.slice(2)) {
        await wakeAt(kst(day, hms));
      }
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    });
  });
});
