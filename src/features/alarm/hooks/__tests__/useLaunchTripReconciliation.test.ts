import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import {
  SIGNAL_4_KTX_ETA_UPPER_BOUND_MS,
  SIGNAL_4_SILENT_PUSH_TIMEOUT_MS,
} from '../../../../shared/constants/realtime';
import {
  runLaunchTripReconciliation,
  useLaunchTripReconciliation,
} from '../useLaunchTripReconciliation';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

const mockFetchTripStatus = jest.fn();
jest.mock('../../api/tripStatus', () => ({
  fetchTripStatus: (...args: unknown[]) => mockFetchTripStatus(...args),
}));

const mockGetSentinel = jest.fn();
const mockSetSentinel = jest.fn();
const mockClearSentinel = jest.fn();
jest.mock('../../utils/tripEndedSentinel', () => {
  const actual = jest.requireActual('../../utils/tripEndedSentinel');
  return {
    // #2114 — 순수 함수라 실제 구현 그대로 사용. storage I/O 함수만 mock.
    isTripEndedSentinelStale: actual.isTripEndedSentinelStale,
    resolveTripEndedSentinelVerdict: actual.resolveTripEndedSentinelVerdict,
    getTripEndedSentinel: (...args: unknown[]) => mockGetSentinel(...args),
    setTripEndedSentinel: (...args: unknown[]) => mockSetSentinel(...args),
    clearTripEndedSentinel: (...args: unknown[]) => mockClearSentinel(...args),
  };
});

// #2045 Signal 4 — silent push last-received stamp + trip started at.
const mockGetLastSilentPushReceivedAt = jest.fn();
jest.mock('../../utils/lastSilentPushReceivedAt', () => ({
  getLastSilentPushReceivedAt: (...args: unknown[]) =>
    mockGetLastSilentPushReceivedAt(...args),
  setLastSilentPushReceivedAt: jest.fn(),
  clearLastSilentPushReceivedAt: jest.fn(),
}));

const mockGetTripStartedAt = jest.fn();
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

const mockTriggerTripEndRecall = jest.fn();
jest.mock('../../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

const mockRunTripBoundCleanups = jest.fn();
jest.mock('../../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));

const mockFlushSignalDumpOutbox = jest.fn();
jest.mock('../../api/signalDumpBackend', () => ({
  flushSignalDumpOutbox: (...args: unknown[]) => mockFlushSignalDumpOutbox(...args),
}));

// R11-c (#1612) — cold-launch active trip 없으면 backend SSoT mirror clear (race C 차단).
const mockClearBackendSsotMirror = jest.fn();
jest.mock('../../utils/backendSsotMirror', () => ({
  clearBackendSsotMirror: (...args: unknown[]) => mockClearBackendSsotMirror(...args),
}));

// #1628 — R11-c 차단 1건 측정 검증. clear 호출과 짝지어 같은 site에서 1회만 발사.
const mockLogCrossTripMirrorSkip = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logCrossTripMirrorSkip: (...args: unknown[]) => mockLogCrossTripMirrorSkip(...args),
}));

// #1597 — trip 종료 ended 경로에서 cleanup 직전에 corrId snapshot 캡처 + cleanup 후 prompt enqueue.
const mockGetCurrentTripCorrIdSync = jest.fn<string | null, []>(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));
const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) =>
    mockTriggerTripGroundTruthPrompt(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockGetSentinel.mockResolvedValue(null);
  mockSetSentinel.mockResolvedValue(undefined);
  mockClearSentinel.mockResolvedValue(undefined);
  mockTriggerTripEndRecall.mockResolvedValue({ uploaded: false });
  mockRunTripBoundCleanups.mockResolvedValue(undefined);
  mockFlushSignalDumpOutbox.mockResolvedValue({ ok: false, skipped: true });
  mockClearBackendSsotMirror.mockResolvedValue(undefined);
  // #2045 Signal 4 — 기본은 null(판정 skip). 각 test가 필요 시 override.
  mockGetLastSilentPushReceivedAt.mockResolvedValue(null);
  mockGetTripStartedAt.mockResolvedValue(null);
  // #2114 (방안 C′) — 기본은 null(corrId sync cache 미수화 → timestamp fallback). 각 test가 필요 시 override.
  mockGetCurrentTripCorrIdSync.mockReturnValue(null);
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
  // #2419 — Signal 4 self-end가 in-memory destination을 실제로 clear하는지 검증하려면
  // 매 test가 "stale destination이 남아있는 상태"에서 출발해야 한다.
  useDestinationStore.setState({
    destination: MOCK_STATIONS.gangnam,
    customOrigin: MOCK_STATIONS.chungmuro,
    tripOrigin: MOCK_STATIONS.hyochang,
  });
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
});

describe('runLaunchTripReconciliation', () => {
  it('URL 미설정 → skip (fetch 호출 없음)', async () => {
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  it('ACTIVE_TRIP_KEY 부재 → skip', async () => {
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  // R11-c (#1612) — cold-launch active trip 없으면 stale backend SSoT mirror clear (race C 차단).
  describe('R11-c (#1612) — cold-launch mirror clear', () => {
    it('ACTIVE_TRIP_KEY 부재 → clearBackendSsotMirror 1회 호출 (mirror 잔재 차단)', async () => {
      await runLaunchTripReconciliation();
      expect(mockClearBackendSsotMirror).toHaveBeenCalledTimes(1);
      expect(mockFetchTripStatus).not.toHaveBeenCalled();
      // #1628 — R11-c 측정 wire-completion: clear와 짝지어 logCrossTripMirrorSkip('launch') 1회.
      expect(mockLogCrossTripMirrorSkip).toHaveBeenCalledWith('launch');
      expect(mockLogCrossTripMirrorSkip).toHaveBeenCalledTimes(1);
    });

    it('ACTIVE_TRIP_KEY 존재 → clearBackendSsotMirror 호출 안 함 (기존 동작 보존)', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockFetchTripStatus.mockResolvedValue({
        status: 'active',
        endedAt: null,
        endReason: null,
      });
      await runLaunchTripReconciliation();
      expect(mockClearBackendSsotMirror).not.toHaveBeenCalled();
      // #1628 — clear가 안 됐으면 측정도 안 발사.
      expect(mockLogCrossTripMirrorSkip).not.toHaveBeenCalled();
    });
  });

  it('sentinel 기록 있음 → fetch skip', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockGetSentinel.mockResolvedValue({ endedAt: 1_700_000_000_000, corrId: null });
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).not.toHaveBeenCalled();
  });

  it('#2114 — stale sentinel(활성 trip이 sentinel보다 나중 시작) → clear 후 fetchTripStatus 진행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockGetSentinel.mockResolvedValue({ endedAt: 1_700_000_000_000, corrId: null });
    mockGetTripStartedAt.mockResolvedValue(1_700_000_060_000); // sentinel 이후 새 trip 시작.
    mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
    await runLaunchTripReconciliation();
    expect(mockClearSentinel).toHaveBeenCalledTimes(1);
    expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
  });

  describe('#2114 방안 C′ — corrId 스코프 1순위 판정', () => {
    it('corrId 불일치 → stale 확정 (timestamp상 fresh로 보여도 corrId mismatch가 우선)', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockGetSentinel.mockResolvedValue({ endedAt: 1_700_000_100_000, corrId: 'corr-old-trip' });
      mockGetTripStartedAt.mockResolvedValue(1_700_000_000_000); // timestamp만 보면 fresh.
      mockGetCurrentTripCorrIdSync.mockReturnValue('corr-new-trip');
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      expect(mockClearSentinel).toHaveBeenCalledTimes(1);
      expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
    });

    it('corrId 일치 → fresh 확정 (timestamp상 stale로 보여도 corrId 일치가 우선 → skip 유지)', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
      mockGetSentinel.mockResolvedValue({ endedAt: 1_700_000_000_000, corrId: 'corr-same-trip' });
      mockGetTripStartedAt.mockResolvedValue(1_700_000_060_000); // timestamp만 보면 stale.
      mockGetCurrentTripCorrIdSync.mockReturnValue('corr-same-trip');
      await runLaunchTripReconciliation();
      expect(mockClearSentinel).not.toHaveBeenCalled();
      expect(mockFetchTripStatus).not.toHaveBeenCalled();
    });
  });

  it('status ended → recall + cleanup + sentinel + active trip clear (#2069 — 로컬 알림 미발사)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });
    await runLaunchTripReconciliation();
    expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
    expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    expect(mockSetSentinel).toHaveBeenCalledWith(1_700_000_000_000, null);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    // #2419 — status='ended'는 cleanupBackendConfirmedEndedTrip을 경유하며, 그 함수가
    // in-memory destination/customOrigin/tripOrigin을 reset한다. 이게 없으면 stale
    // destination이 남아 lockless trip이 유령 재시작된다.
    const state = useDestinationStore.getState();
    expect(state.destination).toBeNull();
    expect(state.customOrigin).toBeNull();
    expect(state.tripOrigin).toBeNull();
  });

  it('status ended — 호출 순서: triggerTripEndRecall → runTripBoundCleanups → setTripEndedSentinel → removeItem(ACTIVE_TRIP_KEY)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1_700_000_000_000,
      endReason: 'destination-arrived',
    });

    // jest invocationCallOrder로 mock fn 호출 순서를 검증.
    // ACTIVE_TRIP_KEY removeItem은 AsyncStorage 직접 호출이라 mock fn order에 잡히지 않으므로
    // setSentinel 직후 storage가 비어 있음을 확인.
    await runLaunchTripReconciliation();

    const recallOrder = mockTriggerTripEndRecall.mock.invocationCallOrder[0];
    const cleanupOrder = mockRunTripBoundCleanups.mock.invocationCallOrder[0];
    const sentinelOrder = mockSetSentinel.mock.invocationCallOrder[0];

    expect(recallOrder).toBeLessThan(cleanupOrder);
    expect(cleanupOrder).toBeLessThan(sentinelOrder);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('status ended + endedAt null → Date.now() fallback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: null,
      endReason: 'unknown',
    });
    await runLaunchTripReconciliation();
    expect(mockSetSentinel).toHaveBeenCalledWith(Date.now(), null);
    jest.useRealTimers();
  });

  it('status ended + endReason null → unknown fallback (state cleanup은 그대로 진행)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1,
      endReason: null,
    });
    await runLaunchTripReconciliation();
    expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    expect(mockSetSentinel).toHaveBeenCalledWith(1, null);
  });

  it('status active → 변경 없음 + cleanup/recall 호출 안 함 (회귀 0)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'active',
      endedAt: null,
      endReason: null,
    });
    await runLaunchTripReconciliation();
    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
    // #2419 — trip이 여전히 active면 destination은 건드리면 안 된다 (회귀 방어).
    expect(useDestinationStore.getState().destination).not.toBeNull();
  });

  it('404/410 (null) → active trip clear만, cleanup/recall X (기존 동작 유지)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue(null);
    await runLaunchTripReconciliation();
    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
  });

  it('네트워크 에러 → silent fail (throw 없음, 상태 변경 없음)', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockRejectedValue(new Error('network'));
    await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
    expect(mockSetSentinel).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
  });

  it('내부 예외(setTripEndedSentinel 실패 등) → silent fail', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockSetSentinel.mockRejectedValueOnce(new Error('boom'));
    mockFetchTripStatus.mockResolvedValue({
      status: 'ended',
      endedAt: 1,
      endReason: 'expired',
    });
    await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
  });

  it('#1520 — flushSignalDumpOutbox 항상 호출 (cold-launch retry)', async () => {
    // ACTIVE_TRIP_KEY 없어도 flush는 호출되어야 한다 — outbox에는 직전 trip의 dump가 남아있을 수 있음.
    await runLaunchTripReconciliation();
    expect(mockFlushSignalDumpOutbox).toHaveBeenCalledTimes(1);
  });

  it('#1520 — flushSignalDumpOutbox 예외 시에도 trip status reconciliation은 계속 진행', async () => {
    // runLaunchTripReconciliation은 outer try-catch로 보호되므로 예외는 silent fail로 흡수.
    mockFlushSignalDumpOutbox.mockRejectedValueOnce(new Error('boom'));
    await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
  });

  // #2045 Signal 4 — backend-timeout self-end. 관찰 22 BG kill 6h+ 커버.
  // FG 유지 시 backstop인 #2044 3-signal과 상호 보완 — 본 chain은 launch 진입 시 판정.
  describe('#2045 Signal 4 — backend-timeout self-end', () => {
    const now = 2_000_000_000_000; // 2033-05-18. deterministic epoch.
    const OVER_TIMEOUT = SIGNAL_4_SILENT_PUSH_TIMEOUT_MS + 60_000; // 31분+
    const UNDER_TIMEOUT = SIGNAL_4_SILENT_PUSH_TIMEOUT_MS - 60_000; // 29분
    const UNDER_KTX = SIGNAL_4_KTX_ETA_UPPER_BOUND_MS - 60_000; // 9h 59분
    const OVER_KTX = SIGNAL_4_KTX_ETA_UPPER_BOUND_MS + 60_000; // 10h 1분

    beforeEach(async () => {
      jest.useFakeTimers().setSystemTime(now);
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('silent push 30분+ 무음 + trip 10h 미만 → self-end (recall + cleanup + sentinel + active clear)', async () => {
      // fetchTripStatus는 호출되면 안 됨 — Signal 4가 fetch 이전에 판정 & 종결.
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).not.toHaveBeenCalled();
      expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
      expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      expect(mockTriggerTripGroundTruthPrompt).toHaveBeenCalledTimes(1);
      expect(mockSetSentinel).toHaveBeenCalledWith(now, null);
      expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
      // #2419 — Signal 4 self-end 분기는 runTripBoundCleanups만으로는 in-memory destination이
      // stale로 남는다 — 명시적 reset이 없으면 lockless trip이 유령 재시작된다.
      const state = useDestinationStore.getState();
      expect(state.destination).toBeNull();
      expect(state.customOrigin).toBeNull();
      expect(state.tripOrigin).toBeNull();
    });

    it('self-end 시 호출 순서: recall → cleanup → prompt → sentinel → active clear', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      await runLaunchTripReconciliation();
      const recallOrder = mockTriggerTripEndRecall.mock.invocationCallOrder[0];
      const cleanupOrder = mockRunTripBoundCleanups.mock.invocationCallOrder[0];
      const promptOrder = mockTriggerTripGroundTruthPrompt.mock.invocationCallOrder[0];
      const sentinelOrder = mockSetSentinel.mock.invocationCallOrder[0];
      expect(recallOrder).toBeLessThan(cleanupOrder);
      expect(cleanupOrder).toBeLessThan(promptOrder);
      expect(promptOrder).toBeLessThan(sentinelOrder);
      expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    });

    it('silent push < 30분 (정상) → fetch로 흐름 이어짐 (self-end skip)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - UNDER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).toHaveBeenCalledWith('tk', 'https://api.test.dev');
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
      expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe('tk');
    });

    it('KTX/장거리 (trip 10h+) → self-end skip, fetch로 흐름 이어짐 (false positive 방지)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - OVER_KTX);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).toHaveBeenCalledTimes(1);
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });

    it('lastReceivedAt null (silent push 미수신) → self-end skip, fetch로 흐름 이어짐 (첫 launch or 새 trip 직후)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(null);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).toHaveBeenCalledTimes(1);
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });

    it('startedAt null (trip 시각 미기록) → self-end skip, fetch로 흐름 이어짐 (기존 recall에 위임)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(null);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).toHaveBeenCalledTimes(1);
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
    });

    it('sentinel 기록 있음(신선, 현재 trip과 동일 시점) → Signal 4 미진입 (fetch/self-end 모두 skip)', async () => {
      // sentinel=now(활성 trip 시작 시각 이후) — stale 아님 → 기존 skip 동작 유지.
      mockGetSentinel.mockResolvedValue({ endedAt: now, corrId: null });
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      await runLaunchTripReconciliation();
      expect(mockFetchTripStatus).not.toHaveBeenCalled();
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockSetSentinel).not.toHaveBeenCalled();
      expect(mockClearSentinel).not.toHaveBeenCalled();
      // sentinel skip는 위 sentinel test에서도 커버 — Signal 4가 sentinel skip를 우회하지 않는지 검증.
    });

    it('경계값: 정확히 30분 gap → skip (>= 아닌 > 임계값)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - SIGNAL_4_SILENT_PUSH_TIMEOUT_MS);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      // 30분 정확 = 30 * 60_000. now - lastReceived = 30분. 30분 > 30분 false → skip.
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockFetchTripStatus).toHaveBeenCalledTimes(1);
    });

    it('경계값: 정확히 10h trip age → skip (< 아닌 < 임계값)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - SIGNAL_4_KTX_ETA_UPPER_BOUND_MS);
      mockFetchTripStatus.mockResolvedValue({ status: 'active', endedAt: null, endReason: null });
      await runLaunchTripReconciliation();
      // 10h 정확 = 10 * 60 * 60_000. now - startedAt = 10h. 10h < 10h false → skip.
      expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      expect(mockFetchTripStatus).toHaveBeenCalledTimes(1);
    });

    it('내부 예외 (recall reject) → silent fail (outer try/catch가 흡수)', async () => {
      mockGetLastSilentPushReceivedAt.mockResolvedValue(now - OVER_TIMEOUT);
      mockGetTripStartedAt.mockResolvedValue(now - UNDER_KTX);
      mockTriggerTripEndRecall.mockRejectedValueOnce(new Error('boom'));
      await expect(runLaunchTripReconciliation()).resolves.toBeUndefined();
    });
  });
});

describe('useLaunchTripReconciliation', () => {
  it('마운트 시 1회 reconciliation 실행', async () => {
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'tk');
    mockFetchTripStatus.mockResolvedValue({
      status: 'active',
      endedAt: null,
      endReason: null,
    });
    renderHook(() => useLaunchTripReconciliation());
    await waitFor(() => expect(mockFetchTripStatus).toHaveBeenCalledTimes(1));
  });
});
