/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useStationAlarm은 본질적 orchestrator(본체에도 file-level disable 있음).
 * settings store(sleepMode/allowSpeaker)에 의존하는 분기를 검증하려면 같은 import 필요.
 * ADR Phase 5 (#890) orchestration 컨벤션.
 */
// #2122 (FG 보조 발사) — 로컬 station-passed 배너 발사. 실제 expo-notifications 왕복 없이
// 호출 여부/인자만 검증하기 위해 mock으로 격리.
const mockFireFgAuxStationPassedNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/stationNotification', () => ({
  fireFgAuxStationPassedNotification: (...args: unknown[]) =>
    mockFireFgAuxStationPassedNotification(...args),
}));

import { AppState } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import {
  useStationAlarm,
  type UseStationAlarmInputs,
} from '../useStationAlarm';
import {
  _resetFireAlarmOnceForTests,
  fireAlarmOnce,
} from '../../utils/fireAlarmOnce';
import { SIMPLE_ARRIVAL_ARCH_ENV_KEY } from '../../../../shared/config/archFlag';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useAlarmEventStore } from '../../store/useAlarmEventStore';
import type { Station } from '../../../../shared/types/station';
import type { AlarmEvent } from '../../utils/stationAlarm';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

// #2067 (Phase 2-device, D1) — sendAlarmNotification 제거로 useStationAlarm.ts는 더 이상
// stationNotification.ts를 import하지 않는다. sendStationPassedNotification mock은 #2064에서
// 이미 실제 export가 아니게 됐지만(레거시 잔재), 아래 mock 없이도 nothing require이 없어
// 안전 — 기존 assertion(`mockSendStationPassedNotification).not.toHaveBeenCalled()`)은
// "결코 wire되지 않은 mock"이라 항상 통과하는 vacuous 검증이 된다. 값 자체는 유지하되 real
// module mock은 제거해 dead jest.mock을 남기지 않는다.
const mockSendStationPassedNotification = jest.fn().mockResolvedValue(undefined);

// #2122 (FG 보조 발사) — AppState.currentState를 테스트에서 조작한다. react-native jest preset의
// 기본 mock(`node_modules/react-native/jest/mocks/AppState.js`)은 `currentState`를 plain
// 필드로 두므로 getter 없이 직접 대입 가능. 기본값 'background' — 기존 테스트("#2064 알림은
// 미발사")가 FG 보조 발사 분기에 진입하지 않도록 보수적 초기화.
function setAppState(state: 'active' | 'background' | 'inactive'): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

const mockEvaluateAlarmPhase = jest.fn();
jest.mock('../../utils/stationAlarm', () => {
  const actual = jest.requireActual('../../utils/stationAlarm');
  return {
    ...actual,
    evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  };
});

const mockResolveAlarmDirection = jest.fn();
jest.mock('../../utils/alarmDirection', () => ({
  resolveAlarmDirection: (...args: unknown[]) => mockResolveAlarmDirection(...args),
}));

const mockResolveNextTarget = jest.fn();
jest.mock('../../utils/stationPipeline', () => ({
  resolveNextTarget: (...args: unknown[]) => mockResolveNextTarget(...args),
}));

const mockGetLastNotifiedStationId = jest.fn();
const mockSetLastNotifiedStationId = jest.fn();
const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../../utils/notificationState', () => ({
  getLastNotifiedStationId: (...args: unknown[]) => mockGetLastNotifiedStationId(...args),
  setLastNotifiedStationId: (...args: unknown[]) => mockSetLastNotifiedStationId(...args),
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockLogFiredAlarm = jest.fn();
const mockLogFiredAlarmsHydrate = jest.fn();
const mockLogFiredStationPassed = jest.fn();
const mockLogHydrationTransition = jest.fn();
const mockLogRefMismatch = jest.fn();
const mockLogSuppressedDedupAlarm = jest.fn();
const mockLogSuppressedDedupStation = jest.fn();
const mockLogSuppressedMovement = jest.fn();
const mockLogSuppressedPhaseGate = jest.fn();
const mockLogSuppressedSleepFirstTransfer = jest.fn();
const mockLogSuppressedSleepStationPassed = jest.fn();
const mockLogSuppressedDismissSilence = jest.fn();
const mockLogSuppressedStationPassedWarmup = jest.fn();
const mockLogSuppressedHopWindow = jest.fn();
const mockLogSuppressedHopWindowNoSource = jest.fn();
const mockLogSuppressedOriginHopLockless = jest.fn();
const mockLogSuppressedPassedEventOnLockOrigin = jest.fn();
const mockLogSuppressedCrossCategoryDedup = jest.fn();
const mockLogSuppressedCrossCategoryRecent = jest.fn();
const mockLogSuppressedPhaseToPhaseDedup = jest.fn();
const mockLogSuppressedChannelAgnosticDedup = jest.fn();
const mockLogFiredAlarmsTripBoundaryReset = jest.fn();
const mockLogSuppressedSsotFireGate = jest.fn();
const mockLogSuppressedLocklessNoUserIntent = jest.fn();
const mockLogSuppressedFireAlarmOnce = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logFiredAlarm: (...args: unknown[]) => mockLogFiredAlarm(...args),
  logFiredAlarmsHydrate: (...args: unknown[]) => mockLogFiredAlarmsHydrate(...args),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logHydrationTransition: (...args: unknown[]) => mockLogHydrationTransition(...args),
  logRefMismatch: (...args: unknown[]) => mockLogRefMismatch(...args),
  logSuppressedDedupAlarm: (...args: unknown[]) => mockLogSuppressedDedupAlarm(...args),
  logSuppressedDedupStation: (...args: unknown[]) => mockLogSuppressedDedupStation(...args),
  logSuppressedMovement: (...args: unknown[]) => mockLogSuppressedMovement(...args),
  logSuppressedPhaseGate: (...args: unknown[]) => mockLogSuppressedPhaseGate(...args),
  logSuppressedSleepFirstTransfer: (...args: unknown[]) =>
    mockLogSuppressedSleepFirstTransfer(...args),
  logSuppressedSleepStationPassed: (...args: unknown[]) =>
    mockLogSuppressedSleepStationPassed(...args),
  logSuppressedDismissSilence: (...args: unknown[]) => mockLogSuppressedDismissSilence(...args),
  logSuppressedStationPassedWarmup: (...args: unknown[]) =>
    mockLogSuppressedStationPassedWarmup(...args),
  logSuppressedHopWindow: (...args: unknown[]) => mockLogSuppressedHopWindow(...args),
  logSuppressedHopWindowNoSource: (...args: unknown[]) =>
    mockLogSuppressedHopWindowNoSource(...args),
  logSuppressedOriginHopLockless: (...args: unknown[]) =>
    mockLogSuppressedOriginHopLockless(...args),
  logSuppressedPassedEventOnLockOrigin: (...args: unknown[]) =>
    mockLogSuppressedPassedEventOnLockOrigin(...args),
  logSuppressedCrossCategoryDedup: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryDedup(...args),
  logSuppressedCrossCategoryRecent: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryRecent(...args),
  logSuppressedPhaseToPhaseDedup: (...args: unknown[]) =>
    mockLogSuppressedPhaseToPhaseDedup(...args),
  logSuppressedChannelAgnosticDedup: (...args: unknown[]) =>
    mockLogSuppressedChannelAgnosticDedup(...args),
  logFiredAlarmsTripBoundaryReset: (...args: unknown[]) =>
    mockLogFiredAlarmsTripBoundaryReset(...args),
  logSuppressedSsotFireGate: (...args: unknown[]) =>
    mockLogSuppressedSsotFireGate(...args),
  logSuppressedLocklessNoUserIntent: (...args: unknown[]) =>
    mockLogSuppressedLocklessNoUserIntent(...args),
  logSuppressedFireAlarmOnce: (...args: unknown[]) =>
    mockLogSuppressedFireAlarmOnce(...args),
}));

// #1893 (RC-17) — trip-boundary detection effect는 tripStartedAt storage를 read한다.
// 기본: null (trip 미시작) — destination polling cycle에서 reset 시도 skip.
// 개별 테스트는 mockGetTripStartedAt.mockResolvedValue(<epoch>)로 override.
const mockGetTripStartedAt = jest.fn().mockResolvedValue(null);
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

// #1572 (T9) — evaluateSsotFireGate mock. 기본 no-block (mirror-missing graceful).
// 개별 테스트는 mockEvaluateSsotFireGate.mockResolvedValueOnce({blocked: true, reason: '...'})로 override.
import type {
  SsotFireGateInput,
  SsotFireGateOutcome,
} from '../../utils/ssotFireGate';
const mockEvaluateSsotFireGate = jest.fn<Promise<SsotFireGateOutcome>, [SsotFireGateInput]>(
  async () => ({ blocked: false, reason: 'mirror-missing' }),
);
jest.mock('../../utils/ssotFireGate', () => ({
  evaluateSsotFireGate: (input: SsotFireGateInput) => mockEvaluateSsotFireGate(input),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
}));

const mockAwaitInitialScheduledAlarmDrain = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/scheduledAlarmReceiver', () => ({
  awaitInitialScheduledAlarmDrain: () => mockAwaitInitialScheduledAlarmDrain(),
}));

const mockIsImminentByArrivalCode = jest.fn();
jest.mock('../../../arrival/utils/imminentArrivalSignal', () => ({
  isImminentByArrivalCode: (...args: unknown[]) => mockIsImminentByArrivalCode(...args),
}));

const mockFindFgArvlCdFireSignal = jest.fn();
jest.mock('../../utils/fgArvlCdFastPath', () => ({
  findFgArvlCdFireSignal: (...args: unknown[]) => mockFindFgArvlCdFireSignal(...args),
}));

const mockGetStoredTripTrainCode = jest.fn();
jest.mock('../../../route/utils/tripTrainCode', () => ({
  getStoredTripTrainCode: (...args: unknown[]) => mockGetStoredTripTrainCode(...args),
}));

const mockUseArrivalInfo = jest.fn();
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (...args: unknown[]) => mockUseArrivalInfo(...args),
}));

const makeStation = (id: string, name: string, lat = 37.5, lng = 127.0): Station => ({
  id,
  name,
  line: '2',
  lineColor: '#33A23D',
  lat,
  lng,
});

const destination = makeStation('D1', '강남', 37.498, 127.028);
const altDestination = makeStation('D2', '잠실', 37.513, 127.100);

const earlyDest: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
const earlyTransfer: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
const imminentDest: AlarmEvent = { phaseId: 'imminent', type: 'destination', stationName: '강남' };

// #1816 — 테스트 기본 lock. lock 활성 trip은 paradigm shift 가드를 통과해 fire path에 진입.
// lock=null(lockless)을 명시적으로 테스트하는 케이스는 개별적으로 mockGetBoardingLock.mockResolvedValue(null) 재설정.
const DEFAULT_LOCK = {
  destinationId: 'D1',
  trainCode: 'T-DEFAULT',
  boardingStationId: 'S-DEFAULT',
  boardingLine: '2' as const,
  boardedAt: 0,
  expectedDurationMs: 60_000,
};

function defaultInputs(overrides: Partial<UseStationAlarmInputs> = {}): UseStationAlarmInputs {
  return {
    route: null,
    destination: null,
    nearestStation: null,
    userLocation: null,
    speedMps: null,
    accuracyMeters: null,
    // 기본은 warmup 가드 우회 — 대부분 단위 테스트는 mount 직후 evaluate 검증.
    // warmup 자체 동작은 별도 describe('#670/#672 warmup guard')에서 검증.
    skipWarmupGuard: true,
    ...overrides,
  };
}

describe('useStationAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    mockFireFgAuxStationPassedNotification.mockResolvedValue(undefined);
    useSettingsStore.setState({ sleepMode: false, allowSpeaker: true });
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    mockEvaluateAlarmPhase.mockReturnValue(null);
    mockResolveAlarmDirection.mockReturnValue(undefined);
    mockResolveNextTarget.mockReturnValue(null);
    // #2064 — jest.clearAllMocks()는 mockResolvedValueOnce 등으로 큐잉된 반환값을 비우지 않는다.
    // 일부 race/cancel 테스트가 소비되지 않은 once 큐(cancelled 가드에 막혀 실제 호출이 발생하지
    // 않는 IIFE)를 남길 수 있어, 다음 테스트로 새는 것을 막기 위해 명시적으로 mockReset 후
    // 기본값을 재설정한다.
    mockGetLastNotifiedStationId.mockReset();
    mockGetLastNotifiedStationId.mockResolvedValue(null);
    mockSetLastNotifiedStationId.mockResolvedValue(undefined);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockIsImminentByArrivalCode.mockReturnValue(false);
    mockGetStoredTripTrainCode.mockResolvedValue(null);
    mockUseArrivalInfo.mockReturnValue({ arrival: null, loading: false, isMock: false });
    // #1816 — 기본 lock 활성. lockless(lock=null) 케이스는 개별 테스트에서 명시적으로 재설정.
    mockGetBoardingLock.mockResolvedValue(DEFAULT_LOCK);
    mockFindFgArvlCdFireSignal.mockReturnValue(null);
    mockAwaitInitialScheduledAlarmDrain.mockResolvedValue(undefined);
    // #1515 — cross-category dedup 모듈 in-memory 상태 리셋. mock하지 않은 실모듈 사용.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
    // #1984 — fire-once ledger 리셋. 각 테스트가 필요한 경우 env 로 flag ON.
    // #2002 — 임시 setter (`__setSimpleArchEnabledForTests`) 제거. real helper wire —
    // `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` env 값으로 게이트.
    _resetFireAlarmOnceForTests();
    delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
  });

  it('does not evaluate when route is null', () => {
    renderHook(() => useStationAlarm(defaultInputs({ destination })));
    expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
  });

  it('does not evaluate when destination is null', () => {
    const route = makeDirectRoute(1, '2');
    renderHook(() => useStationAlarm(defaultInputs({ route })));
    expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
  });

  it('does not evaluate when accuracy exceeds the alarm gate (MAX_ACCURACY_M)', () => {
    const route = makeDirectRoute(3, '2');
    renderHook(() =>
      useStationAlarm(
        defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.4, lng: 127.0 },
          speedMps: 10,
          accuracyMeters: 500,
        }),
      ),
    );
    expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
  });

  it('evaluates when accuracy is exactly the alarm gate (boundary inclusive)', async () => {
    const route = makeDirectRoute(3, '2');
    renderHook(() =>
      useStationAlarm(
        defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.4, lng: 127.0 },
          speedMps: 10,
          accuracyMeters: 200,
        }),
      ),
    );
    await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
  });

  describe('arrival fusion 보조 트리거 (Stage 3)', () => {
    const route = makeDirectRoute(1, '2');
    const onRouteStation = makeStation('S2-DST', '강남'); // route+dest 매칭

    it('GPS 게이트 차단 + arrivalConfidence=arrival-confirmed → station-passed 감지 (#2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500, // GPS 게이트 차단
            arrivalConfidence: 'arrival-confirmed',
          }),
        ),
      );
      // #2064 (Phase 1-device) — station-passed 로컬 알림 제거. 감지 성공은 dedup bookkeeping
      // (setLastNotifiedStationId) 호출로 검증한다.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      // Phase 알람은 GPS 필요하므로 호출 안 됨
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('GPS 게이트 차단 + arrivalConfidence=boarding-lock → station-passed 감지 (#584 PR D2, #2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'boarding-lock',
          }),
        ),
      );
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('GPS 게이트 차단 + arrivalConfidence=arrival-arriving → 발화 안 함 (확정 아님)', () => {
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'arrival-arriving',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('GPS 게이트 차단 + arrivalConfidence=gps-only → 발화 안 함 (회귀 안전)', () => {
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'gps-only',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('GPS 통과 + arrivalConfidence 없음(undefined) → Phase + station-passed 모두 평가 (backward compat)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
            // arrivalConfidence 미전달
          }),
        ),
      );
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
      // #2064 — station-passed 감지 성공은 dedup bookkeeping으로 검증(로컬 알림 미발사).
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('arrival-confirmed 트리거도 lastNotifiedStationId dedup 적용 (GPS와 중복 발화 방지)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'arrival-confirmed',
          }),
        ),
      );
      await waitFor(() => expect(mockLogSuppressedDedupStation).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  it('builds AlarmSource and calls evaluator', async () => {
    const route = makeDirectRoute(3, '2');
    renderHook(() =>
      useStationAlarm(
        defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.4, lng: 127.0 },
          speedMps: 10,
        }),
      ),
    );
    await waitFor(() =>
      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({
          route,
          destinationName: '강남',
          etaSeconds: expect.any(Number),
        }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      ),
    );
  });

  // #903 (Seam G) — arrivalConfidence가 강등 라벨이면 evaluateAlarmPhase에 degradedConfidence=true 전달
  describe('#903 degradedConfidence 전달', () => {
    const route = makeDirectRoute(3, '2');
    const baseInputs = () =>
      defaultInputs({
        route,
        destination,
        userLocation: { lat: 37.4, lng: 127.0 },
        speedMps: 10,
        accuracyMeters: 100,
      });

    it('arrivalConfidence="gps-only-underground" → degradedConfidence=true', async () => {
      renderHook(() =>
        useStationAlarm({ ...baseInputs(), arrivalConfidence: 'gps-only-underground' }),
      );
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ degradedConfidence: true }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });

    it('arrivalConfidence="gps-only" → degradedConfidence=false', async () => {
      renderHook(() =>
        useStationAlarm({ ...baseInputs(), arrivalConfidence: 'gps-only' }),
      );
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ degradedConfidence: false }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });

    it('arrivalConfidence 미전달 → degradedConfidence=false (graceful)', async () => {
      renderHook(() => useStationAlarm(baseInputs()));
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ degradedConfidence: false }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });
  });

  // #1773 (D) — fire path A confidence 화이트리스트 회귀 가드.
  // gps-only-underground 강등 시 GPS 정확도 게이트(500m > 200m)가 already 차단하므로
  // station-passed 알람(mockSendStationPassedNotification)과 phase 알람(logFiredAlarm)
  // 모두 발화 안 됨을 명시 검증. 지상(gps-only/detection-fused)은 정상 진입.
  describe('#1773 (D) fire path A — confidence 기반 silence 검증', () => {
    const route = makeDirectRoute(1, '2');
    // 경로상 2호선 역 — isStationOnRoute 통과 조건.
    const onRouteStation = makeStation('S2-ON', '역삼');

    it('D1: gps-only-underground + accuracy=500m → station-passed 차단 (지하 GPS 정확도 게이트)', () => {
      // 지하 GPS 환경: accuracy 500m > MAX_ACCURACY_M(200m) + arrivalConfidence 강등.
      // !accuracyOk && !arrivalConfirmed → station-passed 효과 early return.
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'gps-only-underground',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('D2: gps-only (지상) + accuracy=100m → evaluateAlarmPhase 호출 + phase fire 경로 진입', async () => {
      // 지상 GPS — accuracy 게이트 통과, degradedConfidence=false → phase 평가 정상 실행.
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
            arrivalConfidence: 'gps-only',
          }),
        ),
      );
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
      // gps-only는 degraded=false → evaluateAlarmPhase에 degradedConfidence=false 전달.
      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ degradedConfidence: false }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      );
    });

    it('D3: detection-fused + accuracy=100m → evaluateAlarmPhase 호출 + degradedConfidence=false', async () => {
      // detection-fused는 verdict ≥2 합의 + 근접 게이트 결합 — 지하에서도 알람 허용.
      // degradedConfidence=false이므로 early/transfer도 차단 안 됨.
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
            arrivalConfidence: 'detection-fused',
          }),
        ),
      );
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ degradedConfidence: false }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      );
    });

    it('D4: lockless trip + gps-only-underground + accuracy=500m → station-passed 차단 (lock 유무 무관)', () => {
      // lock 없는 lockless trip도 GPS 정확도 게이트는 동일 적용.
      // boardingLock=null이어도 !accuracyOk && !arrivalConfirmed → fire path A early return.
      mockGetBoardingLock.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
            arrivalConfidence: 'gps-only-underground',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });
  });

  // Epic #1204 N8 — currentLine 소스 boardingLock 우선.
  // 5호선 답십리 lock 진행 중 fusion이 2호선 상왕십리 nearest로 jitter해도
  // currentLine은 lock.boardingLine을 유지해 다른 leg의 hop fire를 차단해야 한다.
  describe('#1204 N8 — currentLine boardingLock 우선', () => {
    const route = makeDirectRoute(3, '5');
    // nearest는 2호선으로 잘못 잡힌 jitter 시나리오 — 실제 사용자는 5호선 trip 진행 중.
    const wrongNearest = makeStation('N-wrong', '상왕십리', 37.5638, 127.0288);
    const baseInputs = () =>
      defaultInputs({
        route,
        destination,
        nearestStation: { ...wrongNearest, line: '2' as const },
        userLocation: { lat: 37.4, lng: 127.0 },
        speedMps: 10,
        accuracyMeters: 100,
      });

    it('lock.boardingLine 있으면 currentLine은 lock 노선', async () => {
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-5',
        boardingStationId: 'S-답십리',
        boardingLine: '5' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      });
      renderHook(() => useStationAlarm(baseInputs()));
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ currentLine: '5' }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });

    it('lock 없으면 nearestStation.line으로 fallback', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      renderHook(() => useStationAlarm(baseInputs()));
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ currentLine: '2' }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });

    it('lock + nearestStation 둘 다 null이면 currentLine=null', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: null,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
          }),
        ),
      );
      await waitFor(() =>
        expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
          expect.objectContaining({ currentLine: null }),
          expect.any(Set),
          undefined,
          expect.any(Array),
        ),
      );
    });
  });

  it('passes null etaSeconds when speed is null', async () => {
    const route = makeDirectRoute(3, '2');
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: null }),
      ),
    );
    await waitFor(() =>
      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ etaSeconds: null }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      ),
    );
  });

  it('passes null etaSeconds when userLocation is null', async () => {
    const route = makeDirectRoute(3, '2');
    renderHook(() => useStationAlarm(defaultInputs({ route, destination, speedMps: 10 })));
    await waitFor(() =>
      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ etaSeconds: null }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      ),
    );
  });

  it('sends alarm notification with the full event', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyDest, expect.any(String)),
    );
  });

  it('attaches direction to the alarm event when nearestStation is set and direction resolves', async () => {
    const route = makeDirectRoute(1, '2');
    const station = makeStation('S1', '역삼');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    mockResolveAlarmDirection.mockReturnValue('up');
    renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenCalledWith(
        'fg',
        { ...earlyDest, direction: 'up' },
        expect.any(String),
      ),
    );
  });

  it('sends transfer alarm for transfer route', async () => {
    const route = makeTransferRoute({
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    });
    mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyTransfer, expect.any(String)),
    );
  });

  it('sends transfer alarm for multi-transfer route', async () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 1 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 3,
    });
    mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyTransfer, expect.any(String)),
    );
  });

  it('does not fire the same alarm twice', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
    rerender({});
    expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
  });

  it('fires imminent after early for the same waypoint', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValueOnce(earlyDest);
    const { rerender } = renderHook(
      ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
      {
        initialProps: {
          inputs: defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: 5 }),
        },
      },
    );
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenLastCalledWith('fg', earlyDest, expect.any(String)),
    );

    mockEvaluateAlarmPhase.mockReturnValueOnce(imminentDest);
    rerender({
      inputs: defaultInputs({ route, destination, userLocation: { lat: 37.49, lng: 127.025 }, speedMps: 20 }),
    });
    await waitFor(() =>
      expect(mockLogFiredAlarm).toHaveBeenLastCalledWith('fg', imminentDest, expect.any(String)),
    );
    expect(mockLogFiredAlarm).toHaveBeenCalledTimes(2);
  });

  it('#1515 cross-category dedup — 같은 station에 station-passed가 직전 fire됐다면 phase 알람 차단', async () => {
    // 직전 station-passed fire를 시뮬레이션: dedup map에 직접 mark.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    dedup.markStationFired(destination.id, earlyDest.stationName, 'station-passed', Date.now());
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127 }, speedMps: 5 }),
      ),
    );
    await waitFor(() =>
      expect(mockLogSuppressedCrossCategoryDedup).toHaveBeenCalledWith({
        source: 'fg',
        stationName: earlyDest.stationName,
        kind: 'destination',
        phaseId: 'early',
      }),
    );
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('#1643 trip-scoped dedup — 직전 5s 안 다른 station에서 station-passed fire됐다면 phase 알람 차단', async () => {
    // 어대 evidence 시나리오: "군자 도착"(SP) 직후 "곧 성수 도착"(D imminent) 차단.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    // 직전 다른 station(군자)에서 SP fire를 시뮬레이션.
    dedup.markStationFired(destination.id, '군자', 'station-passed', Date.now());
    // phase 알람은 다른 station(성수=earlyDest.stationName)에 발사 시도.
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127 }, speedMps: 5 }),
      ),
    );
    await waitFor(() =>
      expect(mockLogSuppressedCrossCategoryRecent).toHaveBeenCalledWith({
        source: 'fg',
        stationName: earlyDest.stationName,
        kind: 'destination',
        phaseId: 'early',
      }),
    );
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('#1643 trip-scoped dedup — 직전 5s 안 다른 station에서 phase fire됐다면 station-passed 차단', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    // 직전 다른 station(성수=earlyDest.stationName)에서 phase D fire를 시뮬레이션.
    dedup.markStationFired(destination.id, earlyDest.stationName, 'destination', Date.now());
    // station-passed는 다른 station(군자) 통과 시도 — cross-station + cross-cat이라 차단.
    const passedStation = makeStation('S-gunja', '군자');
    mockEvaluateAlarmPhase.mockReturnValue(null);
    renderHook(() =>
      useStationAlarm(defaultInputs({ route, destination, nearestStation: passedStation })),
    );
    await waitFor(() =>
      expect(mockLogSuppressedCrossCategoryRecent).toHaveBeenCalledWith({
        source: 'fg',
        stationName: '군자',
        kind: 'station-passed',
      }),
    );
    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
  });

  it('#1656 phase↔phase dedup — 직전 3s 안 다른 station에서 phase fire됐다면 phase 알람 차단', async () => {
    // 어대 12:32 시나리오: "곧 건대"(transfer imminent) 직후 "성수 도착"(destination) 차단.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    // 직전 다른 station(건대)에서 transfer phase fire를 시뮬레이션.
    dedup.markStationFired(destination.id, '건대', 'transfer', Date.now());
    // destination phase 알람(성수=earlyDest.stationName, 다른 station) 발사 시도.
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127 }, speedMps: 5 }),
      ),
    );
    await waitFor(() =>
      expect(mockLogSuppressedPhaseToPhaseDedup).toHaveBeenCalledWith({
        source: 'fg',
        stationName: earlyDest.stationName,
        kind: 'destination',
        phaseId: 'early',
      }),
    );
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('#1901/#1900 channel-agnostic dedup — 같은 station + 같은 phase 8분 안 재발사는 차단', async () => {
    // 2026-06-26 trip-3 동대문역사문화공원 evidence: silent state push + LA dirty update의
    // cross-channel 중복(8m 14s 차)이 위 cross-category gates(30s/5s/3s) 모두 통과시킴 →
    // channel-agnostic 8분 backstop만 차단. 본 테스트는 5분(=cross-cat 30s window 만료, 8분 backstop만 활성)
    // 후 같은 station + 같은 phase 재발사 시도가 차단되는지 검증.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    const baseTime = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    // 직전 같은 station에 destination + early phase fire 시뮬레이션 (t=baseTime).
    dedup.markStationFired(destination.id, earlyDest.stationName, 'destination', baseTime, 'early');
    // 5분 후 — cross-cat 30s, trip-scoped 5s, phase-to-phase 3s 모두 만료. 8분 backstop만 활성.
    nowSpy.mockReturnValue(baseTime + 5 * 60_000);

    // 같은 station + 같은 phase(early) 재발사 시도. firedAlarms set 비어 있으면 진입부 add 후
    // 8분 backstop에서 차단되어 delete 복구.
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127 }, speedMps: 5 }),
      ),
    );
    await waitFor(() =>
      expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalledWith({
        source: 'fg',
        stationName: earlyDest.stationName,
        kind: 'destination',
        phaseId: 'early',
      }),
    );
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('#1901/#1900 channel-agnostic dedup — 다른 phaseId(early→imminent)는 정상 진행이라 통과', async () => {
    // early destination 발사 후 imminent destination 진행은 정상이어야 함. backstop은 같은 phase
    // 매칭 시에만 차단.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dedup = require('../../utils/crossCategoryStationDedup');
    const route = makeDirectRoute(1, '2');
    const baseTime = 1_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);
    dedup.markStationFired(destination.id, earlyDest.stationName, 'destination', baseTime, 'early');
    // 5분 후 — cross-cat gate 만료, 8분 backstop만 활성. imminent로 진행 시도.
    nowSpy.mockReturnValue(baseTime + 5 * 60_000);

    mockEvaluateAlarmPhase.mockReturnValue(imminentDest);
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127 }, speedMps: 5 }),
      ),
    );
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    // imminent 정상 발사. channel-agnostic backstop이 잘못 차단하지 않음.
    expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', imminentDest, expect.any(String));
    expect(mockLogSuppressedChannelAgnosticDedup).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it('destination 변경 시 새 destinationId로 re-hydrate 한다 (#462 destination scoped)', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(
      ({ dest }: { dest: Station }) => useStationAlarm(defaultInputs({ route, destination: dest })),
      { initialProps: { dest: destination } },
    );
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
    expect(mockGetFiredAlarms).toHaveBeenCalledWith(destination.id);

    const altEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '잠실' };
    mockEvaluateAlarmPhase.mockReturnValue(altEvent);
    rerender({ dest: altDestination });
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(2));
    expect(mockLogFiredAlarm).toHaveBeenLastCalledWith('fg', altEvent, expect.any(String));
    // destination 변경 → 새 id로 storage 재읽기 (저장된 entry는 옛 destinationId라 빈 set 반환 → 자동 isolation).
    expect(mockGetFiredAlarms).toHaveBeenCalledWith(altDestination.id);
  });

  it('sets alarmEvent in store when sleepMode is on', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(useAlarmEventStore.getState().alarmEvent).toEqual(earlyDest));
  });

  it('does not set alarmEvent when sleepMode is off', async () => {
    useSettingsStore.setState({ sleepMode: false });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('does not re-fire when sleepMode toggles after first fire', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));

    useSettingsStore.setState({ sleepMode: true });
    rerender({});
    expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
  });

  // #750 — 공통 sleep 룰 게이트가 FG 즉시 발사 path도 차단한다.
  // scheduler가 사전 예약을 skip한 transfer를 FG polling이 우회 발사하던 회귀.
  describe('#750 sleep first-transfer 게이트', () => {
    const lock = {
      destinationId: destination.id,
      trainCode: 'T-1',
      boardingStationId: 'S-BOARD',
      boardingLine: '2' as const,
      boardedAt: Date.now(),
      expectedDurationMs: 60_000,
    };

    it('sleep ON + lock 활성 + 첫 hop transfer → sendAlarmNotification 호출 X, suppression 로그', async () => {
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(lock);
      // transferRoute targets: [{name:'시청', alarmType:'transfer'}, {name:'강남', alarmType:'destination'}].
      // earlyTransfer.stationName='시청'이 첫 hop과 일치 → suppress.
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() =>
        expect(mockLogSuppressedSleepFirstTransfer).toHaveBeenCalledWith({
          source: 'fg',
          stationName: '시청',
          phaseId: 'early',
        }),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    // #1816 — sleep OFF + lock 활성 + 첫 hop transfer → 정상 발사 (lock 활성 trip은 sleep 게이트 비활성).
    it('sleep OFF + lock 활성 + 첫 hop transfer → 정상 발사', async () => {
      useSettingsStore.setState({ sleepMode: false });
      mockGetBoardingLock.mockResolvedValue(lock);
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock null + 첫 hop transfer → lockless-no-user-intent suppress (#1816)', async () => {
      // #1816 — lock=null(lockless trip) 시 sleep 게이트에 도달하기 전에 lockless-no-user-intent로 차단.
      // 기존 #1214: sleep ON + lockless → sleep-first-transfer 차단 → 이제 lockless guard가 앞서 차단.
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(null);
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() =>
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg-evaluated',
            stationName: '시청',
            kind: 'transfer',
            phaseId: 'early',
          }),
        ),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      // lockless guard가 앞서 차단하므로 sleep gate는 호출 안 됨.
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + destination 카테고리 → 정상 발사 (transfer 외 영향 없음)', async () => {
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(lock);
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + imminent API path도 동일 게이트 적용 (firstHop transfer면 suppress)', async () => {
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(lock);
      // imminent path는 destination event를 발사하므로 게이트 trigger 안 됨 — 회귀 확인용.
      // 별도 시나리오: imminent transfer는 phase 평가 한쪽뿐이라 case는 ETA effect에서 cover.
      // 본 케이스는 imminent destination 정상 동작 검증 (다른 path가 transfer 차단하는 정책에 의해
      // 우발 차단되지 않음).
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockIsImminentByArrivalCode.mockReturnValue(true);
      mockGetStoredTripTrainCode.mockResolvedValue('T-1');
      mockUseArrivalInfo.mockReturnValue({
        arrival: { arrivalCode: '1' },
        loading: false,
        isMock: false,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
          }),
        ),
      );
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });
  });

  describe('station-passed notification', () => {
    const directTarget = {
      nextStationName: '강남',
      stopsToNextStation: 3,
      isTransfer: false,
      stopsToDestination: 3,
    };

    // #2064 (Phase 1-device) — station-passed 로컬 알림 제거. 감지 성공은 notificationState
    // dedup bookkeeping(setLastNotifiedStationId)만으로 검증한다.
    it('records dedup bookkeeping when nearest station changes (does not send local notification)', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));

      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, 'S1');
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('does not fire when stored lastNotifiedStationId equals nearest station', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      mockGetLastNotifiedStationId.mockResolvedValue('S1');

      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));

      await waitFor(() => {
        expect(mockGetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('records dedup bookkeeping again when nearest station changes to a different one', async () => {
      const route = makeDirectRoute(3, '2');
      const station1 = makeStation('S1', '역삼');
      const station2 = makeStation('S2', '선릉');
      mockResolveNextTarget.mockReturnValue(directTarget);
      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: station1 } },
      );
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);
      });

      const nextTarget = {
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      };
      mockResolveNextTarget.mockReturnValue(nextTarget);
      rerender({ s: station2 });
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(2);
      });
      expect(mockSetLastNotifiedStationId).toHaveBeenLastCalledWith(destination.id, 'S2');
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('does not fire when nearestStation is null', () => {
      const route = makeDirectRoute(3, '2');
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('does not fire when route is null', () => {
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(defaultInputs({ destination, nearestStation: station })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('does not fire when destination is null', () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(defaultInputs({ route, nearestStation: station })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    // #2064 — resolveNextTarget은 더 이상 dispatchStationPassed에서 호출되지 않는다(로컬 알림
    // 본문 생성용이었던 호출부 자체가 제거됨). resolveNextTarget 고유 로직의 정확성은
    // `stationPipeline.test.ts`의 별도 describe('resolveNextTarget', ...)가 계속 커버 — 여기서는
    // resolveNextTarget이 무엇을 반환하든(null 포함) dedup bookkeeping이 영향받지 않음을 검증한다.
    it('dedup bookkeeping proceeds regardless of resolveNextTarget return value (no longer consumed)', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(null);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, 'S1');
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    // #2064 — 로컬 알림(sendStationPassedNotification)이 제거되어 그 rejection 경로도 함께
    // 사라졌다. 남은 async 경계(setLastNotifiedStationId write)의 rejection도 hook이 throw 없이
    // 흡수하는지 검증으로 대체.
    it('handles setLastNotifiedStationId rejection gracefully', async () => {
      mockSetLastNotifiedStationId.mockRejectedValueOnce(new Error('storage 실패'));
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      expect(() =>
        renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station }))),
      ).not.toThrow();
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
    });

    it('handles getLastNotifiedStationId rejection gracefully', async () => {
      mockGetLastNotifiedStationId.mockRejectedValueOnce(new Error('storage 실패'));
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      expect(() =>
        renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station }))),
      ).not.toThrow();
      await waitFor(() => {
        expect(mockGetLastNotifiedStationId).toHaveBeenCalled();
      });
    });

    it('transfer route에서 경로 외 노선의 역은 알림을 발송하지 않는다', () => {
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 5,
      });
      // 4호선 역 (경로상 노선 1, 2가 아님)
      const offRouteStation: Station = {
        id: 'OFF-1',
        name: '동대문',
        line: '4',
        lineColor: '#00A4E3',
        lat: 37.5,
        lng: 127.0,
      };
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '시청',
        stopsToNextStation: 3,
        isTransfer: true,
        stopsToDestination: 8,
      });
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: offRouteStation })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('direct route에서 경로 외 노선의 역은 알림을 발송하지 않는다 (#195 회귀 가드)', () => {
      // #195: PR #196의 isStationOnRoute(direct)가 항상 true였던 결함을 막는 통합 회귀.
      // 2호선 강남 → 2호선 잠실 direct 경로 진행 중 GPS가 9호선 한성백제를 잡아도
      // 거리 게이트(1km)는 통과하지만 isStationOnRoute(direct) → false로 알림 차단.
      const route = makeDirectRoute(3, '2');
      const offRouteStation: Station = {
        id: 'OFF-9',
        name: '한성백제',
        line: '9',
        lineColor: '#BB8336',
        lat: 37.5,
        lng: 127.0,
      };
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '잠실',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: offRouteStation })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('경로 외 역 다음에 경로상 역이 오면 알림을 발송한다', async () => {
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 5,
      });
      const offRouteStation: Station = {
        id: 'OFF-1',
        name: '동대문',
        line: '4',
        lineColor: '#00A4E3',
        lat: 37.5,
        lng: 127.0,
      };
      const onRouteStation = makeStation('S1', '서울'); // line '2' (toLine)
      const transferTarget = {
        nextStationName: '시청',
        stopsToNextStation: 2,
        isTransfer: true,
        stopsToDestination: 7,
      };
      mockResolveNextTarget.mockReturnValue(transferTarget);

      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: offRouteStation } },
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();

      rerender({ s: onRouteStation });
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);
      });
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, onRouteStation.id);
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    // #2064 — 아래 두 테스트("알림 발송 후에만 저장" / "알림 발송이 성공하면 그 후에 저장")는
    // dispatchStationPassed의 옛 notify→write 순차 구조(실패 시 storage write 스킵)를 검증했다.
    // 로컬 알림(sendStationPassedNotification) 호출 자체가 제거되어 그 순차 구조가 더 이상
    // 존재하지 않는다 — markStationFired(sync) → isCancelled() → setLastNotifiedStationId(write)
    // 만 남았고, write를 막는 "실패 가능한 이전 단계"가 없다. 두 테스트 모두 관찰 목적을 잃어
    // 제거. write 자체의 rejection-safety는 위 'handles setLastNotifiedStationId rejection
    // gracefully'가 커버.

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it('race: A→B→A 빠른 변동 시 가장 마지막 candidate에 대한 알림만 발송된다', async () => {
      const route = makeDirectRoute(3, '2');
      const stationA = makeStation('SA', '강남A');
      const stationB = makeStation('SB', '강남B');
      mockResolveNextTarget.mockReturnValue(directTarget);

      const readA = deferred<string | null>();
      const readB = deferred<string | null>();
      const readA2 = deferred<string | null>();
      mockGetLastNotifiedStationId
        .mockReturnValueOnce(readA.promise)
        .mockReturnValueOnce(readB.promise)
        .mockReturnValueOnce(readA2.promise);

      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: stationA } },
      );
      rerender({ s: stationB });
      rerender({ s: stationA });

      // 세 IIFE 모두 read를 대기 중 — 이제 모두 resolve
      readA.resolve(null);
      readB.resolve(null);
      readA2.resolve(null);

      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);
      });
      // 처음 두 IIFE는 cancelled 가드에 막혀 마지막(A) 한 번만 dedup bookkeeping 수행.
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, stationA.id);
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('cancel 플래그: read 완료 전 언마운트되면 알림을 발송하지 않는다', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);

      const read = deferred<string | null>();
      mockGetLastNotifiedStationId.mockReturnValueOnce(read.promise);

      const { unmount } = renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      unmount();
      read.resolve(null);

      // microtask 진행을 위해 한 사이클 양보
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    // #2064 — 이 위치에 있던 'cancel 플래그: notify 완료 전 언마운트되면 storage write를 하지
    // 않는다' 테스트는 옛 dispatchStationPassed의 notify await 경계(isCancelled() 재확인 지점이
    // notify 이후에 있었음)를 이용했다. 새 코드는 markStationFired(sync) → isCancelled() →
    // setLastNotifiedStationId(await)만 남았고, 이 cancelled 재확인은 setLastNotifiedStationId
    // "이전"에 위치 — 즉 getLastNotifiedStationId await 직후의 cancelled 게이트(바로 위
    // 'read 완료 전 언마운트' 테스트)와 완전히 동일한 경계다. setLastNotifiedStationId 호출
    // "이후"에는 재확인 지점이 없어(가장 마지막 statement) 재현할 별도 race window가 없다 —
    // 중복 커버라 제거.
  });

  // ── BG↔FG firedAlarms 단일 출처 (#336 회귀 가드) ──
  // BG가 AsyncStorage(FIRED_ALARMS_KEY)에 fired 알람을 기록한 뒤 FG로 복귀하면
  // useStationAlarm은 시작 시 storage를 hydrate해 같은 phase를 재발화하지 않는다.
  describe('firedAlarms BG↔FG 단일 출처 (#336)', () => {
    const route = makeDirectRoute(1, '2');

    const renderWithBgFired = () => {
      // BG가 이미 발화: storage에 alarmKey가 있음.
      mockGetFiredAlarms.mockResolvedValueOnce(new Set([`early:${destination.name}`]));
      // evaluator가 동일 키 firedAlarms를 받으면 null 반환하는 실제 dedup 의미를 흉내.
      mockEvaluateAlarmPhase.mockImplementation((_src: unknown, fired: Set<string>) =>
        fired.has(`early:${destination.name}`) ? null : earlyDest,
      );
      return renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
          }),
        ),
      );
    };

    it('BG가 발화한 phase를 마운트 시 hydrate해 FG에서 재발화하지 않는다', async () => {
      renderWithBgFired();

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      // hydrated 이후 evaluator가 호출되더라도 동일 키가 들어있어 null 반환 → 미발화.
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('FG에서 phase 발화 시 setFiredAlarms(destinationId, set)로 동기화한다 (#462)', async () => {
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
      expect(mockSetFiredAlarms).toHaveBeenCalledWith(destination.id, expect.any(Set));
      // 발화된 alarmKey가 storage로 흘러갔는지 확인.
      const lastCall = mockSetFiredAlarms.mock.calls.at(-1)!;
      const lastSet = lastCall[1] as Set<string>;
      expect(lastSet.has(`early:${destination.name}`)).toBe(true);
    });

    it('초기 바인드 시 BG가 적재한 firedAlarms를 보존한다 (storage clear 없음)', async () => {
      renderWithBgFired();

      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
      // BG 적재로 인해 evaluator가 null 반환 → 미발화.
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('destination 변경 직후 hydration 완료 전에는 evaluator가 호출되지 않는다 (race guard, #462)', async () => {
      // hydration await 동안 effect가 phase 평가를 보류해야 한다.
      let releaseHydration: (() => void) | undefined;
      mockGetFiredAlarms.mockReturnValueOnce(
        new Promise<Set<string>>((resolve) => {
          releaseHydration = () => resolve(new Set());
        }),
      );
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // hydration 미완료 상태에서 evaluator가 호출되면 안 됨.
      await new Promise((r) => setImmediate(r));
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();

      releaseHydration!();
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
    });
  });

  // #1893 (RC-17) — firedAlarmsRef trip-boundary detection effect.
  // 같은 destinationId로 trip 재시작 시(=목적지 그대로 두고 새 출발) hydration effect는 재실행되지
  // 않는다. tripStartedAt이 ref stamp와 다르면 in-memory Set을 명시적으로 비우고 로그 1건 적재.
  describe('#1893 firedAlarmsRef trip-boundary reset', () => {
    const route = makeDirectRoute(1, '2');

    it('tripStartedAt이 ref와 다르면 in-memory Set reset + 로그 1건 적재', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set());
      // 첫 hydration 시 tripStartedAt = 1_000_000 → ref에 stamp.
      mockGetTripStartedAt.mockResolvedValueOnce(1_000_000);
      // 첫 polling effect run (mount 시) — 같은 1_000_000 → ref stamp 후 비교 skip.
      mockGetTripStartedAt.mockResolvedValueOnce(1_000_000);
      // destinationArrival 변경으로 polling re-trigger 시 새 trip 2_000_000.
      mockGetTripStartedAt.mockResolvedValueOnce(2_000_000);

      const { rerender } = renderHook(
        ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
        { initialProps: { inputs: defaultInputs({ route, destination }) } },
      );

      // hydration 완료 + 첫 ref stamp.
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());

      // destinationArrival 변경(useArrivalInfo가 새 arrival 반환) → polling effect 재실행.
      mockUseArrivalInfo.mockReturnValue({
        arrival: { stationName: '강남', line: '2' as const, arrivals: [] },
        loading: false,
        isMock: false,
      });
      rerender({ inputs: defaultInputs({ route, destination, speedMps: 1 }) });

      await waitFor(() =>
        expect(mockLogFiredAlarmsTripBoundaryReset).toHaveBeenCalledWith({
          source: 'fg',
          destinationId: destination.id,
          previousTripStartedAt: 1_000_000,
          nextTripStartedAt: 2_000_000,
        }),
      );
    });

    it('tripStartedAt이 ref와 같으면 reset skip (정상 동일 trip 진행)', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set());
      // hydration과 polling 모두 같은 epoch.
      mockGetTripStartedAt.mockResolvedValue(1_000_000);

      const { rerender } = renderHook(
        ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
        { initialProps: { inputs: defaultInputs({ route, destination }) } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());

      mockUseArrivalInfo.mockReturnValue({
        arrival: { stationName: '강남', line: '2' as const, arrivals: [] },
        loading: false,
        isMock: false,
      });
      rerender({ inputs: defaultInputs({ route, destination, speedMps: 1 }) });

      await new Promise((r) => setImmediate(r));
      expect(mockLogFiredAlarmsTripBoundaryReset).not.toHaveBeenCalled();
    });

    it('tripStartedAt=null(trip 종료) 분기에선 reset skip', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set());
      // 첫 hydration: ref에 1_000_000 stamp.
      mockGetTripStartedAt.mockResolvedValueOnce(1_000_000);
      // 첫 polling: hydration 미완료 OR same epoch (race graceful) — same epoch로 return.
      mockGetTripStartedAt.mockResolvedValueOnce(1_000_000);
      // re-trigger: trip 종료 → null → reset skip.
      mockGetTripStartedAt.mockResolvedValueOnce(null);

      const { rerender } = renderHook(
        ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
        { initialProps: { inputs: defaultInputs({ route, destination }) } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      mockUseArrivalInfo.mockReturnValue({
        arrival: { stationName: '강남', line: '2' as const, arrivals: [] },
        loading: false,
        isMock: false,
      });
      rerender({ inputs: defaultInputs({ route, destination, speedMps: 1 }) });

      await new Promise((r) => setImmediate(r));
      expect(mockLogFiredAlarmsTripBoundaryReset).not.toHaveBeenCalled();
    });

    it('destinationId=null 분기에선 polling effect 자체가 skip', async () => {
      // destination 없음 → effect early return.
      mockGetTripStartedAt.mockResolvedValue(1_000_000);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination: null })));

      await new Promise((r) => setImmediate(r));
      expect(mockLogFiredAlarmsTripBoundaryReset).not.toHaveBeenCalled();
    });

    it('hydration ref가 아직 null이면 polling effect는 reset skip (race graceful)', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set());
      // hydration은 늦게 끝나도록 — getTripStartedAt 첫 호출은 pending.
      let releaseHydration: ((v: number | null) => void) | undefined;
      mockGetTripStartedAt.mockReturnValueOnce(
        new Promise<number | null>((resolve) => {
          releaseHydration = resolve;
        }),
      );
      // polling effect는 즉시 returns 2_000_000(but ref still null).
      mockGetTripStartedAt.mockResolvedValueOnce(2_000_000);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // polling effect는 ref=null 보고 return.
      await new Promise((r) => setImmediate(r));
      expect(mockLogFiredAlarmsTripBoundaryReset).not.toHaveBeenCalled();
      // hydration 풀어줘서 cleanup.
      releaseHydration!(1_000_000);
    });
  });

  // ── 알람 로그 적재 (B2 인프라) ──
  describe('appendAlarmLog 적재', () => {
    const route = makeDirectRoute(1, '2');
    const station = makeStation('S1', '강남', 37.498, 127.028);

    it('알람 발사 시 logFiredAlarm(fg, event, "eta")를 호출한다', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyDest, 'eta');
      });
    });

    // #2064 (Phase 1-device) — station-passed 로컬 알림 제거로 logFiredStationPassed(alarmLog
    // 'fired' 엔트리) 호출부도 함께 제거됨. dedup bookkeeping(setLastNotifiedStationId)은 유지.
    it('역 통과 감지 시에도 logFiredStationPassed는 호출하지 않는다 (dedup bookkeeping만 수행)', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockSetLastNotifiedStationId.mockResolvedValue(undefined);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 1,
      });

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
      });
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
    });

    // #2122 — FG 보조 발사. backend APNs 전달 지연(실측 35~51s)을 FG에서 디바이스 자체 판정으로
    // 우회. #2064 봉인은 유지하되 AppState==='active' && lock 활성일 때만 예외적으로 로컬
    // station-passed 배너를 추가 발사한다.
    describe('#2122 FG 보조 발사 (AppState active 한정)', () => {
      function renderStationPassed() {
        mockEvaluateAlarmPhase.mockReturnValue(null);
        mockGetLastNotifiedStationId.mockResolvedValue(null);
        mockSetLastNotifiedStationId.mockResolvedValue(undefined);
        mockResolveNextTarget.mockReturnValue({
          nextStationName: '강남',
          stopsToNextStation: 1,
          isTransfer: false,
          stopsToDestination: 1,
        });
        return renderHook(() =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
        );
      }

      it('FG(active) + lock 활성 + 게이트 통과 → fireFgAuxStationPassedNotification 발사 + logFiredStationPassed(fg) 스탬프', async () => {
        setAppState('active');

        renderStationPassed();

        await waitFor(() => {
          expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
        });
        await waitFor(() => {
          expect(mockFireFgAuxStationPassedNotification).toHaveBeenCalledWith(station.name);
        });
        expect(mockLogFiredStationPassed).toHaveBeenCalledWith('fg', station.name);
      });

      it('BG(background) → fireFgAuxStationPassedNotification 미호출 (#2064 봉인 유지)', async () => {
        setAppState('background');

        renderStationPassed();

        await waitFor(() => {
          expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
        });
        expect(mockFireFgAuxStationPassedNotification).not.toHaveBeenCalled();
        expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
      });

      it('lock 없음(lockless) → FG(active)여도 dispatch 자체에 도달하지 못해 미호출', async () => {
        setAppState('active');
        mockGetBoardingLock.mockResolvedValue(null);

        renderStationPassed();

        await waitFor(() => {
          expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalled();
        });
        expect(mockFireFgAuxStationPassedNotification).not.toHaveBeenCalled();
        expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
      });

      it('FG(active) + lock 활성이어도 fireFgAuxStationPassedNotification 실패 시 dedup bookkeeping은 유지되고 예외를 던지지 않는다', async () => {
        setAppState('active');
        mockFireFgAuxStationPassedNotification.mockRejectedValueOnce(new Error('schedule 실패'));

        renderStationPassed();

        await waitFor(() => {
          expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
        });
        await waitFor(() => {
          expect(mockFireFgAuxStationPassedNotification).toHaveBeenCalledWith(station.name);
        });
        // logFiredStationPassed는 fireFgAuxStationPassedNotification 성공 후에만 호출 — 실패 시 미호출.
        expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
      });
    });

    it('lastNotifiedStationId 일치로 skip 시 logSuppressedDedupStation(fg, station)을 호출한다', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(station.id);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(mockLogSuppressedDedupStation).toHaveBeenCalledWith('fg', station);
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    // #452: deps에 raw accuracyMeters가 들어가면 GPS 노이즈로 매 fix 재실행되어
    // dedup-suppressed 로그가 1초당 1줄씩 쌓여 alarm log ring buffer를 점령했다.
    // 게이트 통과 영역 내부에서 accuracyMeters만 바뀔 때 effect가 추가 실행되지 않아야 한다.
    it('#452: 같은 station에서 accuracyMeters만 바뀌어도 dedup-suppressed 로그가 추가되지 않는다', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(station.id);

      const { rerender } = renderHook(
        (props: UseStationAlarmInputs) => useStationAlarm(props),
        {
          initialProps: defaultInputs({
            route,
            destination,
            nearestStation: station,
            accuracyMeters: 10,
          }),
        },
      );

      await waitFor(() => {
        expect(mockLogSuppressedDedupStation).toHaveBeenCalledTimes(1);
      });

      // GPS 노이즈처럼 정확도만 게이트 통과 범위 내에서 변경.
      rerender(
        defaultInputs({
          route,
          destination,
          nearestStation: station,
          accuracyMeters: 25,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      rerender(
        defaultInputs({
          route,
          destination,
          nearestStation: station,
          accuracyMeters: 50,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      // 추가 호출 없음 — 게이트 boolean이 바뀌지 않는 한 effect가 재실행되지 않음.
      // (await 후 검증으로 비동기 IIFE의 carryover 호출 가능성도 차단)
      expect(mockLogSuppressedDedupStation).toHaveBeenCalledTimes(1);
    });
  });

  describe('#396 API 신호 기반 imminent', () => {
    const route = makeDirectRoute(3, '2');
    const station = makeStation('S1', '시청');

    it('isImminentByArrivalCode가 true이고 미발사 상태면 imminent 알람 발사 + logFiredAlarm("fg", _, "api")', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockUseArrivalInfo.mockReturnValue({
        arrival: { up: [], down: [], isMock: false },
        loading: false,
        isMock: false,
      });
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          // #727 — speed=2.0, accuracy=50으로 명시해 movement 가드 통과
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            speedMps: 2,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ phaseId: 'imminent', stationName: '강남', type: 'destination' }),
          'api',
        );
      });
      expect(mockLogFiredAlarm).toHaveBeenCalled();
    });

    // #727 — speed/accuracy 가드. 정적 사용자의 잘못된 trainCode/fusion 신호로 인한 misfire 차단.
    it('#727 speed=0(정적)이면 API imminent 발사 차단 + movement-static-speed 적재', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            speedMps: 0,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
            reason: 'movement-static-speed',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      const apiCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'api');
      expect(apiCalls).toHaveLength(0);
    });

    it('#727 accuracy>100m(저신뢰)이면 API imminent 발사 차단 + movement-low-accuracy 적재', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            speedMps: 2,
            accuracyMeters: 1500,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-low-accuracy' }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('#727 speed/accuracy 모두 누락(null)이어도 API imminent 발사 (graceful pass)', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            speedMps: null,
            accuracyMeters: null,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ phaseId: 'imminent' }),
          'api',
        );
      });
    });

    it('API 신호 false면 발사하지 않는다', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(false);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      // hydration 완료 대기
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();

      const apiCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'api');
      expect(apiCalls).toHaveLength(0);
    });

    it('이미 imminent가 firedAlarms에 있으면 dedup으로 재발사하지 않는다', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();

      const apiCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'api');
      expect(apiCalls).toHaveLength(0);
    });

    it('hydration 완료 전에는 API 신호 평가를 보류한다', () => {
      // getFiredAlarms를 영원히 pending 상태로 두면 firedHydrated가 false 유지
      mockGetFiredAlarms.mockReturnValue(new Promise(() => {}));
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('sleepMode면 setAlarmEvent도 함께 호출', async () => {
      useSettingsStore.setState({ sleepMode: true });
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);
      const setAlarmEventSpy = jest.spyOn(useAlarmEventStore.getState(), 'setAlarmEvent');

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(setAlarmEventSpy).toHaveBeenCalledWith(
          expect.objectContaining({ phaseId: 'imminent', stationName: '강남' }),
        );
      });
      setAlarmEventSpy.mockRestore();
    });

    it('resolveAlarmDirection 결과가 있으면 event에 direction 포함', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);
      mockResolveAlarmDirection.mockReturnValue('up');

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ direction: 'up' }),
          expect.any(String),
        );
      });
    });

    it('destination이 없으면 평가하지 않는다', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() => useStationAlarm(defaultInputs({ route })));

      await Promise.resolve();
      const apiCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'api');
      expect(apiCalls).toHaveLength(0);
    });

    it('nearestStation이 null이면 direction 미부착 (resolveAlarmDirection 호출 안 함)', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: null })),
      );

      await waitFor(() => {
        expect(mockLogFiredAlarm).toHaveBeenCalled();
      });
      // nearestStation null이면 direction 분기를 거치지 않음
      const apiLogCall = mockLogFiredAlarm.mock.calls[0];
      expect(apiLogCall[1]).not.toHaveProperty('direction');
    });

    it('destinationId 없으면 trackedTrainCode를 null로 리셋한다', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');

      const { rerender } = renderHook(
        ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
        { initialProps: { inputs: defaultInputs({ route, destination }) } },
      );

      await waitFor(() => expect(mockGetStoredTripTrainCode).toHaveBeenCalledWith('D1'));

      rerender({ inputs: defaultInputs({ route, destination: null }) });

      // destination null이면 effect는 setTrackedTrainCode(null) 호출 후 종료
      // getStoredTripTrainCode 추가 호출 없음
      const callCountBefore = mockGetStoredTripTrainCode.mock.calls.length;
      await Promise.resolve();
      expect(mockGetStoredTripTrainCode.mock.calls.length).toBe(callCountBefore);
    });
  });

  // #2067 (Phase 2-device, D1) — sendAlarmNotification 제거로 fusionSource → notificationSource
  // 라벨을 조립하던 useMemo 자체가 죽은 코드가 되어 제거됨(#2067 리뷰 P2-1, 투기적 보존 금지).
  // fusionSource 입력값이 station-passed dedup bookkeeping을 깨지 않는지만 남겨 검증한다.
  describe('fusionSource 입력 시 station-passed dedup bookkeeping (#327 잔여)', () => {
    it('fusionSource 전달돼도 station-passed는 알림 없이 dedup bookkeeping만 수행', async () => {
      const route = makeDirectRoute(5, '2');
      const destination = makeStation('D1', '강남');
      const station = makeStation('S1', '역삼');
      const directTarget = {
        nextStationName: '강남',
        stopsToNextStation: 5,
        isTransfer: false,
        stopsToDestination: 5,
      };
      mockResolveNextTarget.mockReturnValue(directTarget);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            fusionSource: 'route-progress',
          }),
        ),
      );
      await waitFor(() =>
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  describe('phase alarm dedup 로깅 (#580)', () => {
    it('하이드레이션 완료 시 destinationId + size로 logFiredAlarmsHydrate 호출', async () => {
      const stored = new Set(['early:강남']);
      mockGetFiredAlarms.mockResolvedValueOnce(stored);
      renderHook(() => useStationAlarm(defaultInputs({ destination })));
      await waitFor(() =>
        expect(mockLogFiredAlarmsHydrate).toHaveBeenCalledWith(destination.id, 1),
      );
    });

    it('evaluateAlarmPhase가 suppressedOut에 push한 이벤트마다 logSuppressedDedupAlarm 호출', async () => {
      const route = makeDirectRoute(1, '2');
      const suppressedEvent: AlarmEvent = {
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      };
      mockEvaluateAlarmPhase.mockImplementation(
        (_src: unknown, _fired: unknown, _phases: unknown, suppressed: AlarmEvent[]) => {
          suppressed.push(suppressedEvent);
          return null;
        },
      );
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
          }),
        ),
      );
      await waitFor(() =>
        expect(mockLogSuppressedDedupAlarm).toHaveBeenCalledWith('fg', suppressedEvent),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });
  });

  // #699: setFiredAlarms를 fire-and-forget으로 두면 다음 cycle(또는 BG silent push)이
  // stale storage를 읽어 같은 phase를 재발사함 (실기기에서 destination 2분 차 더블 fire 캡처).
  // fireAndLog가 setFiredAlarms를 await하는지, 그리고 같은 evaluator cycle 내에서 같은
  // phase가 두 번 발사되지 않는지 회귀 가드한다.
  describe('#699 setFiredAlarms await dedup', () => {
    const route = makeDirectRoute(1, '2');

    it('phase 발사 시 setFiredAlarms write 완료를 기다린 후 logFiredAlarm을 호출한다', async () => {
      // storage write 지연을 시뮬레이션: 외부에서 release할 때까지 pending.
      let releaseSetFired: (() => void) | undefined;
      mockSetFiredAlarms.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseSetFired = () => resolve();
        }),
      );
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // setFiredAlarms는 호출되지만 아직 resolve 안 됨 → logFiredAlarm 미호출.
      await waitFor(() => expect(mockSetFiredAlarms).toHaveBeenCalled());
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();

      // storage write가 완료되면 그제서야 logFiredAlarm 진행.
      releaseSetFired!();
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyDest, 'eta'));
    });

    it('storage write 대기 중 두 번째 evaluation이 들어와도 같은 phase는 한 번만 발사된다', async () => {
      let releaseSetFired: (() => void) | undefined;
      mockSetFiredAlarms.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSetFired = () => resolve();
          }),
      );
      // 실제 evaluator 의미를 흉내: firedAlarms에 이미 키가 있으면 null.
      mockEvaluateAlarmPhase.mockImplementation((_src: unknown, fired: Set<string>) =>
        fired.has(`early:${destination.name}`) ? null : earlyDest,
      );

      const { rerender } = renderHook(
        ({ loc }: { loc: { lat: number; lng: number } }) =>
          useStationAlarm(
            defaultInputs({
              route,
              destination,
              userLocation: loc,
              speedMps: 10,
              accuracyMeters: 100,
            }),
          ),
        { initialProps: { loc: { lat: 37.4, lng: 127.0 } } },
      );

      // 첫 evaluation: 발사 — setFiredAlarms 호출되었지만 pending.
      await waitFor(() => expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1));

      // storage write가 아직 끝나지 않은 사이에 다음 evaluation 발생(GPS 좌표 갱신).
      rerender({ loc: { lat: 37.401, lng: 127.001 } });
      await Promise.resolve();
      await Promise.resolve();

      // sync firedAlarmsRef.current.add 덕분에 두 번째 evaluator는 dedup → 추가 발사 없음.
      releaseSetFired!();
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      const etaCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'eta');
      expect(etaCalls).toHaveLength(1);
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
    });

    it('setFiredAlarms가 reject되어도 notification은 발사된다 (영속화 실패 graceful)', async () => {
      mockSetFiredAlarms.mockRejectedValueOnce(new Error('storage 실패'));
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyDest, 'eta'));
    });

    it('imminent API 신호도 setFiredAlarms write 완료를 기다린 후 logFiredAlarm을 호출한다', async () => {
      let releaseSetFired: (() => void) | undefined;
      mockSetFiredAlarms.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseSetFired = () => resolve();
        }),
      );
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockSetFiredAlarms).toHaveBeenCalled());
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();

      releaseSetFired!();
      await waitFor(() =>
        expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', imminentDest, 'api'),
      );
    });
  });


  describe('#1019 phase gate stamps', () => {
    const route = makeDirectRoute(3, '2');
    it('accuracy 초과 시 gate-phase-accuracy stamp', async () => {
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: 10, accuracyMeters: 500 })));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith('gate-phase-accuracy', destination.name);
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });
    it('warmup suppress 시 gate-phase-warmup stamp', async () => {
      renderHook(() => useStationAlarm({ route, destination, nearestStation: null, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: 10, accuracyMeters: 100 }));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith('gate-phase-warmup', destination.name);
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });
    it('skipWarmupGuard=true이면 gate-phase-warmup stamp 없음', async () => {
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: 10, accuracyMeters: 100 })));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockLogSuppressedPhaseGate.mock.calls.filter((c) => c[0] === 'gate-phase-warmup')).toHaveLength(0);
    });
  });

  // #670/#672/#1316/#1645 — phase 알람 warmup 가드. 하이드레이션 완료 후 HYDRATE_WARMUP_MS(10s) 시간 window
  // 동안 phase 평가를 보류한다. #1316 이전엔 첫 eval 1회만 suppress(isFirstAlarmEvalRef)했으나, 2번째
  // eval이 GPS/ETA 안정화 전 destination/transfer early를 발사 → firedAlarms 슬롯 점유로 실제 도착이
  // dedup되는 회귀(08:24:31 성수)가 있었다. station-passed(#1010)와 동일한 시간 window로 통일한다.
  describe('#670/#672/#1316 phase warmup window 가드', () => {
    const route = makeDirectRoute(3, '2');
    // skipWarmupGuard 미전달 → production default(false) 적용. warmup window 보류 동작 확인.
    function inputsWithGuardDefault(loc: { lat: number; lng: number }): UseStationAlarmInputs {
      return {
        route,
        destination,
        nearestStation: null,
        userLocation: loc,
        speedMps: 10,
        accuracyMeters: 100,
      };
    }

    it('mount 직후 첫 evaluation trigger는 suppress (default skipWarmupGuard=false)', async () => {
      renderHook(() => useStationAlarm(inputsWithGuardDefault({ lat: 37.4, lng: 127.0 })));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('warmup window 내에서는 좌표가 갱신돼도 계속 suppress (단발 아님 — #1316)', async () => {
      const baseTs = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      const { rerender } = renderHook(
        ({ loc }: { loc: { lat: number; lng: number } }) =>
          useStationAlarm(inputsWithGuardDefault(loc)),
        { initialProps: { loc: { lat: 37.4, lng: 127.0 } } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
      // 좌표가 한 번 더 갱신돼도 (window 안, Date.now 불변) 여전히 보류 — 단발 suppress라면 여기서
      // evaluate가 호출됐을 것. 시간 window라 계속 차단된다.
      rerender({ loc: { lat: 37.41, lng: 127.01 } });
      await waitFor(() =>
        expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith('gate-phase-warmup', destination.name),
      );
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('warmup window 경과 후 좌표 갱신 시 evaluate 호출됨 (hydratedAt + 10s 이후)', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      const { rerender } = renderHook(
        ({ loc }: { loc: { lat: number; lng: number } }) =>
          useStationAlarm(inputsWithGuardDefault(loc)),
        { initialProps: { loc: { lat: 37.4, lng: 127.0 } } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
      // window 경과 후(30s + 1ms) 좌표 갱신 → 안정된 입력으로 평가 진입.
      nowSpy.mockReturnValue(baseTs + 10_001);
      rerender({ loc: { lat: 37.41, lng: 127.01 } });
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
    });
  });

  // #1316 — 조기 발사가 dedup을 오염시켜 실제 도착 알람이 누락되는 회귀 재현.
  // device evidence: 08:24:31 트립 생성 직후 destination early(성수, 6역 전) 조기 발사 →
  // firedAlarms 슬롯 점유 → 08:40:53 실제 도착 시 dedup-alarm으로 억제.
  // warmup window가 단발 suppress(2번째 eval 발사 가능)였던 게 root cause.
  // 시간 window 전환 후: window 동안 발사 0 → firedAlarms 청결 → window 경과 후 도착 시 정상 발사.
  describe('#1316 조기 발사 dedup 오염 방지', () => {
    const route = makeDirectRoute(6, '2');

    function inputsNearDestination(): UseStationAlarmInputs {
      return {
        route,
        destination,
        nearestStation: makeStation('S1', '역삼'),
        userLocation: { lat: 37.498, lng: 127.028 },
        speedMps: 10,
        accuracyMeters: 100,
      };
    }

    it('warmup window 내 destination early 발사 보류 → firedAlarms 슬롯 미점유', async () => {
      const baseTs = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      // 트립 시작 직후 evaluateAlarmPhase가 early destination을 반환하려 해도(straight-line ETA 과소추정
      // 등) warmup이 evaluate 진입 자체를 막아야 한다.
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(inputsNearDestination()));

      await waitFor(() =>
        expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith('gate-phase-warmup', destination.name),
      );
      // 핵심: evaluate 진입 차단 → firedAlarms 슬롯 점유 없음(setFiredAlarms 미호출) → 발사 없음.
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('조기 발사로 오염되지 않아 window 경과 후 실제 도착에서 destination 정상 발사', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      // #1816 — lock 활성 trip: lockless-no-user-intent 가드를 통과해야 warmup 이후 발사 검증 가능.
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-WARMUP',
        boardingStationId: 'S-BOARD',
        boardingLine: '2' as const,
        boardedAt: baseTs,
        expectedDurationMs: 60_000,
      });
      // 트립 시작 시점: early destination 조건 매칭(조기 발사 시도).
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      const { rerender } = renderHook(
        ({ loc }: { loc: { lat: number; lng: number } }) =>
          useStationAlarm({ ...inputsNearDestination(), userLocation: loc }),
        { initialProps: { loc: { lat: 37.4, lng: 127.0 } } },
      );

      // window 내 — 조기 발사 차단 확인.
      await waitFor(() =>
        expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith('gate-phase-warmup', destination.name),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();

      // 실제 도착 시점: window 경과 + 좌표 갱신. firedAlarms가 비어 있으므로 dedup 없이 발사돼야 한다.
      nowSpy.mockReturnValue(baseTs + 10_001);
      rerender({ loc: { lat: 37.498, lng: 127.028 } });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', earlyDest, 'eta');
    });
  });

  describe('#733 Phase ETA path movement gate', () => {
    const route = makeDirectRoute(1, '2');
    const station = makeStation('S1', '역삼');

    function renderPhaseHook(props: Partial<UseStationAlarmInputs>): void {
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            userLocation: { lat: 37.4, lng: 127 },
            accuracyMeters: 50,
            ...props,
          }),
        ),
      );
    }

    it('Phase rawEvent 있음 + speed=null + positionStability=static이면 차단 + movement-static-position 적재', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
      renderPhaseHook({ speedMps: null, positionStability: 'static' });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '시청',
            kind: 'transfer',
            phaseId: 'early',
            reason: 'movement-static-position',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('Phase rawEvent 있음 + speed=0이면 차단 + movement-static-speed 적재', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderPhaseHook({ speedMps: 0 });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            stationName: '강남',
            kind: 'destination',
            phaseId: 'early',
            reason: 'movement-static-speed',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('Phase rawEvent 있음 + speed>=0.5(이동)이면 정상 발사 (positionStability=static 무시)', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderPhaseHook({ speedMps: 5, positionStability: 'static' });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    });
  });

  describe('#733 station-passed movement gate', () => {
    const route = makeDirectRoute(1, '2');
    const onRouteStation = makeStation('S2-DST', '강남');

    function renderStationPassedHook(props: Partial<UseStationAlarmInputs>): void {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 50,
            ...props,
          }),
        ),
      );
    }

    it('station-passed + 정적 신호(speed=0) + 약한 arrival이면 차단 + movement-static-speed 적재', async () => {
      renderStationPassedHook({ speedMps: 0 });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '강남',
            kind: 'station-passed',
            reason: 'movement-static-speed',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('station-passed + speed=null + positionStability=static이면 차단 + movement-static-position 적재', async () => {
      renderStationPassedHook({ speedMps: null, positionStability: 'static' });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            stationName: '강남',
            kind: 'station-passed',
            reason: 'movement-static-position',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('station-passed + 정적 신호 + arrivalConfirmed면 movement gate skip → 정상 감지 (#2064 알림은 미발사)', async () => {
      renderStationPassedHook({ speedMps: 0, arrivalConfidence: 'arrival-confirmed' });

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('station-passed + 이동 신호(speed=5)면 정상 감지 (#2064 알림은 미발사)', async () => {
      renderStationPassedHook({ speedMps: 5 });

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #728 — CMMotionActivity motionStationary 신호. 3개 effect(Phase ETA / API imminent / station-passed)
  // 전부 동일 가드 적용. speed=0.69(임계 우회) phantom과 destination/transfer 카테고리 무방비 회귀를 잡는다.
  describe('#728 motionStationary gate', () => {
    const route = makeDirectRoute(1, '2');
    const onRouteStation = makeStation('S2-DST', '강남');

    it('API imminent + motionStationary=true (speed=0.69 임계 우회) → 차단 + movement-motion-stationary 적재', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0.69, // 임계값 0.5 우회
            accuracyMeters: 50,
            motionStationary: true,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
            reason: 'movement-motion-stationary',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('Phase rawEvent (early destination) + motionStationary=true → 차단 + movement-motion-stationary 적재', async () => {
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            userLocation: { lat: 37.4, lng: 127 },
            speedMps: 1.5, // 이동으로 보이는 speed지만 motion=stationary
            accuracyMeters: 50,
            motionStationary: true,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            stationName: '강남',
            kind: 'destination',
            phaseId: 'early',
            reason: 'movement-motion-stationary',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('station-passed + motionStationary=true → 차단 + movement-motion-stationary 적재', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0.69, // 임계 우회 phantom
            accuracyMeters: 50,
            motionStationary: true,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            stationName: '강남',
            kind: 'station-passed',
            reason: 'movement-motion-stationary',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('motionStationary=false면 차단 안 함 (이동 신호 정상, #2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 5,
            accuracyMeters: 50,
            motionStationary: false,
          }),
        ),
      );

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('motionStationary 미전달 — 기존 동작 유지 (graceful fallback, #2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 5,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('station-passed + motionStationary=true + arrivalConfirmed면 motion gate skip → 정상 감지 (#2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      // arrivalConfirmed는 motion gate 자체를 우회 (기존 정책 — arrival API 단독 신호 보호).
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0,
            accuracyMeters: 50,
            motionStationary: true,
            arrivalConfidence: 'arrival-confirmed',
          }),
        ),
      );

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1401 (Epic #1396 sub 5/6) — trainProgressing 신호가 정적 가드 3종을 우회시키는지 검증.
  // 본 테스트는 useFusedNearestStation에서 도출된 trainProgressing이 useStationAlarm으로 전달되어
  // evaluateMovement의 motion-stationary / static-speed / static-position 차단을 모두 우회시키는 것을 검증.
  // 사용자 증상: 역삼 13:37 미발사 회귀 — GPS speed null + motion=stationary 정적 판정으로 도착 알람 누락.
  describe('#1401 trainProgressing 우회', () => {
    const route = makeDirectRoute(1, '2');
    const onRouteStation = makeStation('S2-DST', '강남');

    /**
     * 7 케이스 모두 동일한 base inputs(route + destination + nearestStation) + 케이스별 overrides로
     * useStationAlarm을 렌더 → Sonar CPD. helper로 추출.
     */
    function renderTrainProgressingAlarm(
      overrides: Partial<UseStationAlarmInputs>,
    ): ReturnType<typeof renderHook<unknown, unknown>> {
      return renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            ...overrides,
          }),
        ),
      );
    }

    it('API imminent + motionStationary=true + trainProgressing=true → device 정적 가드 우회 → 정상 발사', async () => {
      // 역삼 회귀 시나리오: motion=stationary지만 fusion arc advance가 확인되면 발사 허용.
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderTrainProgressingAlarm({
        speedMps: 0.69,
        accuracyMeters: 50,
        motionStationary: true,
        trainProgressing: true,
      });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedMovement).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'movement-motion-stationary' }),
      );
    });

    it('API imminent + speed=0(static-speed) + trainProgressing=true → 정상 발사', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderTrainProgressingAlarm({
        speedMps: 0,
        accuracyMeters: 50,
        trainProgressing: true,
      });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedMovement).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'movement-static-speed' }),
      );
    });

    it('API imminent + speed=null + positionStability=static + trainProgressing=true → 정상 발사 (역삼 회귀)', async () => {
      // 역삼 13:37 정확 시나리오: GPS speed=null + position=static → 기존엔 static-position 차단.
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderTrainProgressingAlarm({
        speedMps: null,
        accuracyMeters: 50,
        positionStability: 'static',
        trainProgressing: true,
      });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedMovement).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'movement-static-position' }),
      );
    });

    it('Phase rawEvent (early destination) + motionStationary=true + trainProgressing=true → 정상 발사', async () => {
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });

      renderTrainProgressingAlarm({
        userLocation: { lat: 37.4, lng: 127 },
        speedMps: 1.5,
        accuracyMeters: 50,
        motionStationary: true,
        trainProgressing: true,
      });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    });

    it('station-passed + motionStationary=true + trainProgressing=true → 정상 감지 (#2064 알림은 미발사)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      renderTrainProgressingAlarm({
        speedMps: 0.69,
        accuracyMeters: 50,
        motionStationary: true,
        trainProgressing: true,
      });

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('trainProgressing=false면 기존 동작 (motion=stationary 차단 그대로)', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderTrainProgressingAlarm({
        speedMps: 0.69,
        accuracyMeters: 50,
        motionStationary: true,
        trainProgressing: false,
      });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-motion-stationary' }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('trainProgressing=undefined(기본값)면 기존 동작 (graceful fallback)', async () => {
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderTrainProgressingAlarm({
        speedMps: 0,
        accuracyMeters: 50,
        // trainProgressing 미전달 — 기본값 false → 기존 정적 가드 그대로.
      });

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-static-speed' }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });
  });

  // #1010 — station-passed firedHydrated 가드 + 30s hydration warmup.
  // lock hydrate 직후 GPS가 stabilize되기 전 false alarm 방지.
  describe('#1010 station-passed hydration warmup guard', () => {
    const route = makeDirectRoute(3, '2');
    const station = makeStation('S1', '역삼');

    it('firedHydrated=false (hydration pending) 동안 station-passed 발사 보류', async () => {
      // getFiredAlarms를 영원히 pending 상태로 두면 firedHydrated=false 유지
      mockGetFiredAlarms.mockReturnValue(new Promise(() => {}));
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2, isTransfer: false, stopsToDestination: 2 });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            accuracyMeters: 50,
            skipWarmupGuard: false,
          }),
        ),
      );

      // hydration이 완료되지 않으면 발사 없음
      await new Promise((r) => setTimeout(r, 50));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('warmup window 내 (hydratedAt 직후) station-passed 차단 + gate-station-passed-warmup 적재', async () => {
      const baseTs = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2, isTransfer: false, stopsToDestination: 2 });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            accuracyMeters: 50,
            skipWarmupGuard: false,
          }),
        ),
      );

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      // warmup window 안 — 발사 차단
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedStationPassedWarmup).toHaveBeenCalledWith(station.name);
    });

    it('skipWarmupGuard=true면 warmup window 안에서도 즉시 감지 (#2064 알림은 미발사)', async () => {
      const baseTs = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2, isTransfer: false, stopsToDestination: 2 });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            accuracyMeters: 50,
            skipWarmupGuard: true,
          }),
        ),
      );

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('warmup window 경과 후 감지 허용 (hydratedAt + 10s 이후, #2064 알림은 미발사)', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2, isTransfer: false, stopsToDestination: 2 });

      const { rerender } = renderHook(
        ({ s }: { s: typeof station | null }) =>
          useStationAlarm(
            defaultInputs({
              route,
              destination,
              nearestStation: s,
              accuracyMeters: 50,
              skipWarmupGuard: false,
            }),
          ),
        { initialProps: { s: null as typeof station | null } },
      );

      // hydration 완료 대기 (hydratedAt이 baseTs로 설정됨)
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());

      // warmup window 경과 후 nearestStation 제공 — 이 시점엔 warmup guard를 통과해야 함.
      nowSpy.mockReturnValue(baseTs + 10_001);
      rerender({ s: station });

      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #754 — fireAndLog dedup race: await getBoardingLock() 동안 effect가 재실행돼
  // 같은 rawEvent로 in-flight fireAndLog가 다수 누적되어도 사용자에게는 1회만 노출.
  describe('#754 fireAndLog dedup race', () => {
    it('진입 시 firedAlarmsRef에 키가 이미 있으면 즉시 return (in-flight entry dedup)', async () => {
      // race 시뮬레이션: evaluateAlarmPhase mock이 firedAlarms를 honor 안 함으로써 같은
      // rawEvent를 매 evaluation마다 반환 (production race에서 in-flight fireAndLog가 add 전에
      // 다음 evaluation이 들어오는 상황과 동치). fireAndLog 진입 가드가 차단해야 한다.
      // #1816 — lock 활성 trip: lockless-no-user-intent 가드를 통과해야 in-flight dedup 검증 가능.
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-DEDUP',
        boardingStationId: 'S-BOARD',
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 60_000,
      });
      const route = makeDirectRoute(1, '2');

      const { rerender } = renderHook(
        ({ lat }: { lat: number }) =>
          useStationAlarm(
            defaultInputs({
              route,
              destination,
              userLocation: { lat, lng: 127.0 },
            }),
          ),
        { initialProps: { lat: 37.5 } },
      );

      // 첫 fire 완료까지 대기 — firedAlarmsRef에 'early:강남' 적재.
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // mock이 firedAlarms를 무시하므로 evaluateAlarmPhase는 다시 같은 rawEvent 반환 → fireAndLog 호출.
      // 진입 가드(has(key)=true)가 catch하지 않으면 88회 burst 회귀 — 추가 발사 없어야 한다.
      rerender({ lat: 37.50001 });
      rerender({ lat: 37.50002 });
      rerender({ lat: 37.50003 });

      // microtask + effect 사이클 flush. setTimeout(0)으로 macrotask queue까지 비운다.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
    });

    it('sleep-rule suppress 분기에서 firedAlarms.delete로 복구 → sleep 해제 후 다음 evaluation은 정상 발사', async () => {
      const lock = {
        destinationId: destination.id,
        trainCode: 'T-1',
        boardingStationId: 'S-BOARD',
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 60_000,
      };
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(lock);

      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);

      const { rerender } = renderHook(
        ({ lat }: { lat: number }) =>
          useStationAlarm(
            defaultInputs({
              route,
              destination,
              userLocation: { lat, lng: 127.0 },
            }),
          ),
        { initialProps: { lat: 37.5 } },
      );

      await waitFor(() => expect(mockLogSuppressedSleepFirstTransfer).toHaveBeenCalled());
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();

      // sleep OFF 토글 → firedAlarms.delete가 sync 적용됐다면 다음 evaluation은 정상 발사.
      // delete가 빠지면 같은 키가 firedAlarms에 남아 진입 가드가 영구 봉쇄 → 회귀.
      useSettingsStore.setState({ sleepMode: false });
      rerender({ lat: 37.50001 });

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    });
  });

  describe('#746 dismiss silence 게이트 (FG)', () => {
    const route = makeDirectRoute(3, '2');
    const userLocation = { lat: 37.498, lng: 127.028 };
    const ALARM_INPUTS = {
      route,
      destination,
      userLocation,
      speedMps: 10,
      accuracyMeters: 50,
      nearestStation: makeStation('S1', '시청', 37.498, 127.028),
    };

    // 중복 fixture 추출 — SonarCloud new_duplicated_lines_density 3% 임계 준수.
    function seedSilence(state: { sinceTs: number; sinceLat: number | null; sinceLng: number | null }) {
      useAlarmEventStore.setState({ dismissSilence: state });
    }
    function seedActiveSilence(loc: { lat: number; lng: number } | null = null) {
      seedSilence({
        sinceTs: Date.now(),
        sinceLat: loc?.lat ?? null,
        sinceLng: loc?.lng ?? null,
      });
    }
    function seedExpiredSilence() {
      seedSilence({ sinceTs: Date.now() - 10 * 60_000, sinceLat: null, sinceLng: null });
    }
    function setupApiImminent() {
      mockGetStoredTripTrainCode.mockResolvedValue('T-1');
      mockUseArrivalInfo.mockReturnValue({ arrival: { up: [], down: [] }, loading: false, isMock: false });
      mockIsImminentByArrivalCode.mockReturnValue(true);
    }
    function renderForSilence() {
      renderHook(() => useStationAlarm(defaultInputs(ALARM_INPUTS)));
    }

    it('ETA path: silence 활성이면 phase 알람 차단 + log + return (movement gate 전 단계)', async () => {
      seedActiveSilence(userLocation);
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderForSilence();
      await waitFor(() =>
        expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: earlyDest.stationName,
            kind: earlyDest.type,
            phaseId: earlyDest.phaseId,
          }),
        ),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('API imminent path: silence 활성이면 imminent도 차단', async () => {
      seedActiveSilence();
      setupApiImminent();
      renderForSilence();
      await waitFor(() =>
        expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
          expect.objectContaining({
            stationName: imminentDest.stationName,
            kind: 'destination',
            phaseId: 'imminent',
          }),
        ),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('station-passed path: silence 활성이면 알림 차단 + lastNotifiedStationId 갱신 보존', async () => {
      seedActiveSilence(userLocation);
      mockGetLastNotifiedStationId.mockResolvedValue('other-id');
      renderForSilence();
      await waitFor(() =>
        expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: ALARM_INPUTS.nearestStation.name,
            kind: 'station-passed',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('silence 만료(시간 5분 초과) → 게이트 통과 + store clear action 호출 (정상 발사)', async () => {
      const setStateSpy = jest.spyOn(useAlarmEventStore.getState(), 'clearDismissSilence');
      seedExpiredSilence();
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderForSilence();
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(setStateSpy).toHaveBeenCalled();
      setStateSpy.mockRestore();
    });

    it('API imminent path: silence 만료(시간) 시 clear 호출 + 정상 발사', async () => {
      const clearSpy = jest.spyOn(useAlarmEventStore.getState(), 'clearDismissSilence');
      seedExpiredSilence();
      setupApiImminent();
      renderForSilence();
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });

    it('silence 만료(거리 200m 이상) → 게이트 통과', async () => {
      // 0.003도 ≈ 333m. 시간은 fresh지만 좌표 거리로 만료.
      seedSilence({ sinceTs: Date.now(), sinceLat: 37.498, sinceLng: 127.028 });
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            ...ALARM_INPUTS,
            userLocation: { lat: 37.501, lng: 127.028 },
            nearestStation: makeStation('S1', '시청', 37.501, 127.028),
          }),
        ),
      );
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
    });

    it('silence state 없음 → 게이트 통과 (정상 발사)', async () => {
      useAlarmEventStore.setState({ dismissSilence: null });
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderForSilence();
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedDismissSilence).not.toHaveBeenCalled();
    });

    it('silence 만료 시 clearAction이 reject되어도 정상 발사 + warn 로그', async () => {
      // applySilenceGate의 logClearFailure 분기 커버.
      const clearSpy = jest
        .spyOn(useAlarmEventStore.getState(), 'clearDismissSilence')
        .mockRejectedValueOnce(new Error('storage write failed'));
      seedExpiredSilence();
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderForSilence();
      // reject되어도 silence는 통과되어 알람 정상 발사.
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });

  // #917 A2 follow-up — FG fast path: lock.trainCode arvlCd∈{0,1} 매역 알림.
  // GPS 기반 station-passed effect와 분리해 검증하기 위해 nearestStation을 off-route로 두고
  // `findFgArvlCdFireSignal` mock으로 fast path만 isolate. fast path 자체는 isStationOnRoute을
  // 보지만, 그 게이트는 effect 내부에서 직접 검사하지 않고 mock 반환값 + 경로 매칭으로 확인.
  // GPS path는 isStationOnRoute=false로 사전 차단되므로 fast path 단독 검증이 가능.
  describe('#917 FG fast path arvlCd∈{0,1} 매역 알림', () => {
    const route = makeDirectRoute(3, '2');
    // line '2' — direct route와 일치 → 양쪽 effect 모두 on-route. 그러나 GPS effect는
    // 별도 mockGetLastNotifiedStationId 사전 set으로 dedup 처리(아래 helper).
    const onRouteStation = makeStation('S-시청', '시청');
    const activeLock = {
      destinationId: 'D1',
      trainCode: 'T-LOCK',
      boardingStationId: 'S0',
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };
    const dummyArrival = { up: [], down: [], isMock: false };

    /**
     * fastPathInputs:
     *   - speedMps/accuracyMeters: movement gate 통과
     *   - currentStationArrival: non-null (effect 게이트 통과). 내용은 mock으로 대체되므로 placeholder.
     *   - nearestStation: on-route (line '2'). GPS path 발사를 막기 위해 default beforeEach에서
     *     mockGetLastNotifiedStationId를 onRouteStation.id로 set → GPS path는 dedup 차단되고
     *     fast path도 같은 dedup에 걸린다. fast path 통과 케이스 테스트는 별도 mockGetLastNotifiedStationId(null)
     *     override + GPS path 차단을 위해 nearestStation 자체를 off-route로 둠.
     */
    function fastPathInputs(overrides: Partial<UseStationAlarmInputs> = {}): UseStationAlarmInputs {
      return defaultInputs({
        route,
        destination,
        nearestStation: onRouteStation,
        speedMps: 5,
        accuracyMeters: 50,
        currentStationArrival: dummyArrival,
        ...overrides,
      });
    }

    // GPS station-passed effect를 완전히 우회하기 위해 off-route station으로 둠.
    // fast path effect도 isStationOnRoute로 같은 station을 검사하지만, 핵심 게이트 검증은
    // GPS path 발사가 0인 환경에서 fast path만의 fire/no-fire를 관찰하기 위함.
    // off-route 테스트 외엔 onRouteStation을 쓰고, lastNotifiedStationId 사전 set으로 GPS dedup.
    const OFF_ROUTE_LINE = '3' as const;
    const offRouteStation: Station = { ...onRouteStation, id: 'OFF', line: OFF_ROUTE_LINE };

    // fast path positive — GPS path는 nearestStation을 off-route로 두어 차단, fast path는
    // isStationOnRoute=false 직격이라 발사 못 함. 다른 방법: GPS path가 dedup으로 차단되는 시나리오.
    // → mockGetLastNotifiedStationId를 'GPS-FIRED'로 set하면 GPS path는 fire 후 dedup에 막힘…
    //   아니, GPS path는 lastId === candidateStation.id면 dedup. candidateStation.id=onRouteStation.id.
    //   다른 id를 fast path와 GPS가 봐도 둘 다 같은 candidate를 보기 때문에 분리 불가.
    //
    // 결론: positive 테스트는 GPS+fast 둘 다 fire 가능한 환경에서 진행 + 'fg-arvlcd' source 라벨로
    // fast path 발사 여부만 가린다. GPS path는 sendStationPassedNotification을 'fg' source로 logFiredStationPassed
    // 호출하므로 mock 호출 인자로 식별 가능.

    // #2064 (Phase 1-device) — station-passed 로컬 알림(sendStationPassedNotification) +
    // alarmLog 'fired' 엔트리(logFiredStationPassed) 모두 제거. 감지 성공은 dedup bookkeeping
    // (setLastNotifiedStationId) 1회 호출로만 검증한다.
    it('lock 활성 + arvlCd 신호 → station-passed 감지 + lastNotifiedStationId 갱신 (알림 미발사)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      // #1515 — cross-category station-level dedup으로 GPS path와 fast-path 중 먼저 reservation을
      // 점유한 쪽만 dedup bookkeeping을 완료한다(같은 station, 같은 destination, 30s 윈도우).
      await waitFor(() =>
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, onRouteStation.id),
      );
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
    });

    // #640 회귀 가드 — 본 PR의 핵심.
    it('#640 회귀 가드 — lock 부재면 같은 신호여도 fast path 발사 X (fg-arvlcd 미적재)', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id); // GPS dedup
      // findFgArvlCdFireSignal mock은 lock=null로 호출되어 null 반환 (helper 자체 가드 검증).
      mockFindFgArvlCdFireSignal.mockImplementation((_arrival, lock) =>
        lock ? { trainCode: 'T-LOCK', arvlCd: 0 } : null,
      );

      renderHook(() => useStationAlarm(fastPathInputs()));

      // 충분히 대기 — fast path가 발사해선 안 됨.
      await waitFor(() => expect(mockGetBoardingLock).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('#640 회귀 가드 — findFgArvlCdFireSignal이 null 반환(trainCode 불일치/arvlCd 불일치)면 발사 X', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue(null);

      renderHook(() => useStationAlarm(fastPathInputs()));

      await waitFor(() => expect(mockGetBoardingLock).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('lastNotifiedStationId가 같은 station.id면 fast path dedup → fg-arvlcd dedup 로그', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      await waitFor(() =>
        expect(mockLogSuppressedDedupStation).toHaveBeenCalledWith('fg-arvlcd', onRouteStation),
      );
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('currentStationArrival 미전달(undefined)이면 fast path no-op (arvlCd fire X)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(fastPathInputs({ currentStationArrival: undefined })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      // #1236 — GPS station-passed path도 sleep 룰 게이트 위해 getBoardingLock을 호출하므로
      // 'getBoardingLock 미호출' 대신 'fast path fire 미발생'으로 검증한다.
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('currentStationArrival null이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(fastPathInputs({ currentStationArrival: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('nearestStation null이면 fast path no-op (fire 대상 station 결정 불가)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      // #1272 (N8) — destinationId 기반 lock mirror effect가 destinationId 설정 시 lock을
      // 1회 prefetch 한다. fast path 발사 자체는 nearestStation null이므로 발생하지 않음.
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('nearestStation이 route 밖이면(line 불일치) fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: offRouteStation })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('route 또는 destination 미설정이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ route: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('destination 미설정이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ destination: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      // destination=null이면 lock mirror effect도 early return → getBoardingLock 호출 0.
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('movement gate 차단(speed=0) → fast path 발사 X + logSuppressedMovement(fg-arvlcd)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs({ speedMps: 0 })));

      await waitFor(() =>
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg-arvlcd',
            stationName: onRouteStation.name,
            kind: 'station-passed',
            reason: 'movement-static-speed',
          }),
        ),
      );
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('dismiss silence 활성 시 fast path 발사 X + logSuppressedDismissSilence(fg-arvlcd)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });
      useAlarmEventStore.setState({
        dismissSilence: {
          sinceTs: Date.now(),
          sinceLat: 37.5,
          sinceLng: 127,
        },
      });

      renderHook(() =>
        useStationAlarm(fastPathInputs({ userLocation: { lat: 37.5, lng: 127 } })),
      );

      await waitFor(() =>
        expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg-arvlcd',
            stationName: onRouteStation.name,
            kind: 'station-passed',
          }),
        ),
      );
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('hydration 미완료 시 fast path 보류 (firedHydrated=false)', async () => {
      mockGetFiredAlarms.mockReturnValue(new Promise(() => {})); // 영원히 pending
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      await Promise.resolve();
      // hydration 보류 — fast path는 firedHydrated 가드로 early return.
      // #1272 (N8) — destinationId 기반 lock mirror effect는 hydration과 무관하게 destinationId
      // 설정 시 lock을 prefetch하므로 getBoardingLock 호출 자체는 발생할 수 있다. 단 fast path
      // 발사는 발생하지 않음(logFiredStationPassed fg-arvlcd 호출 0).
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('내부 storage read/send 실패 시 catch로 swallow (logger.error 분기 커버)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      // getLastNotifiedStationId가 throw → fast path 내부 try/catch가 흡수.
      // GPS path는 자체 try/catch가 있어 같은 에러로 둘 다 차단되지만 본 테스트는 fast path
      // 분기 커버가 목적.
      mockGetLastNotifiedStationId.mockRejectedValue(new Error('disk error'));
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      // 에러 발생해도 unhandled rejection 없이 완료. fast path는 logFiredStationPassed 미호출.
      await waitFor(() => expect(mockGetLastNotifiedStationId).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('effect cleanup (unmount) 후엔 후속 작업이 fast path 발사 안 함', async () => {
      // #1236 — GPS path도 getBoardingLock을 호출하므로 mockImplementation으로 모든 호출 pending.
      // arvlCd path의 `if (cancelled) return;` 분기 커버.
      const resolvers: Array<(v: typeof activeLock | null) => void> = [];
      mockGetBoardingLock.mockImplementation(
        () =>
          new Promise<typeof activeLock | null>((r) => {
            resolvers.push(r);
          }),
      );
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      const { unmount } = renderHook(() => useStationAlarm(fastPathInputs()));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      // GPS path + arvlCd path 둘 다 getBoardingLock pending에 도달.
      await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(2));
      unmount();
      resolvers.forEach((r) => r(activeLock));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      // fast path의 logFiredStationPassed('fg-arvlcd', ...)이 호출되지 않아야 한다.
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('getLastNotifiedStationId 후 cleanup 되면 dedup/send 분기 진입 안 함 (cancelled gate line 720)', async () => {
      // GPS effect와 fast path effect 둘 다 호출 가능 — mockImplementation으로 모든 호출 pending.
      const resolvers: Array<(v: string | null) => void> = [];
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockImplementation(
        () =>
          new Promise<string | null>((r) => {
            resolvers.push(r);
          }),
      );
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      const { unmount } = renderHook(() => useStationAlarm(fastPathInputs()));
      // fast path는 getBoardingLock(resolved) → findSignal(sync) → gates(sync) → getLastNotifiedStationId(pending).
      // 첫 mock 호출은 GPS effect일 수 있어 fast path가 자기 호출에 도달하도록 충분히 await.
      await waitFor(() => expect(mockGetLastNotifiedStationId.mock.calls.length).toBeGreaterThanOrEqual(2));
      // 추가 microtask flush로 두 effect 모두 await 지점에 도달했음을 보장.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      unmount();
      resolvers.forEach((r) => r(null));
      // resolve 후 microtask 충분히 돌려 `if (cancelled) return;` 진입(line 720).
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
      // dedup 로그도 호출되지 않아야 한다 (cancelled로 early return).
      const arvlCdDedups = mockLogSuppressedDedupStation.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdDedups).toHaveLength(0);
    });

    // #2064 — 이 위치에 있던 'sendStationPassedNotification 후 cleanup 되면 setLastNotifiedStationId
    // 미호출' 테스트는 옛 dispatchStationPassed의 notify await 경계를 이용해 cancel-mid-flight를
    // 재현했다. 로컬 알림 호출 자체가 제거되어 그 경계가 사라졌고(mockSendStationPassedNotification이
    // 더 이상 호출되지 않아 waitFor가 타임아웃), 새 코드의 유일한 cancelled 재확인 지점은
    // getLastNotifiedStationId await 직후로 옮겨갔다 — 바로 위 'getLastNotifiedStationId 후
    // cleanup 되면 dedup/send 분기 진입 안 함' 테스트가 GPS+fast-path 양쪽 모두에 대해 이미
    // 이 경계를 검증하므로 중복 제거.

    it('destination 변경 직후 firedAlarmsRef.destId 미일치 시점에는 fast path 보류 (line 671)', async () => {
      // hydration mock: 첫 destination에 대해 hydrate 완료 → ref id 일치.
      // 그 후 destination 변경 시 새 hydrate 진행 중인 짧은 시점에 fast path effect deps 재실행 →
      // ref.current는 아직 old destination id라 새 destination.id와 불일치 → early return.
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      // 첫 destination 정상 hydrate.
      mockGetFiredAlarms.mockResolvedValueOnce(new Set<string>());
      // 두 번째 destination는 hydrate를 pending으로 두어 ref.id가 갱신 전 상태 유지.
      mockGetFiredAlarms.mockReturnValueOnce(new Promise(() => {}));

      const { rerender } = renderHook(
        ({ dest }: { dest: Station }) => useStationAlarm(fastPathInputs({ destination: dest })),
        { initialProps: { dest: destination } },
      );

      // 첫 destination hydrate 완료 대기.
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());

      // destination 교체. 새 destination의 hydrate는 pending → firedHydrated=false 또는 ref.id 불일치.
      // #2064 — 첫 destination의 정상 dispatch가 이미 setLastNotifiedStationId를 1회 호출했을 수
      // 있으므로(로컬 알림 대신 dedup bookkeeping이 proxy) rerender 전 호출 기록을 clear해
      // "교체 직후에는 추가 호출이 없다"만 검증한다.
      mockSetLastNotifiedStationId.mockClear();
      rerender({ dest: altDestination });
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

  });

  // #1266 (Epic #1204 D2 follow-up) — fast-path도 hop window 게이트 적용.
  // 회귀 evidence: 2026-06-12 22:31 사용자 trip [Img1] — 신당(+6 hop) + 왕십리(+4 hop) 동시 fire.
  // GPS station-passed effect는 D2(#1208) 게이트로 차단됐으나 fg-arvlcd fast-path는 같은
  // 게이트가 없어 fusion이 미래 arc station에 jitter landing + lock.trainCode 일치 시
  // 미래 hop fire 가능. 본 회귀 가드는 fast-path D2 gate 우회 시 fail by design.
  //
  // 독립 describe로 분리 — 직전 #917 fast path 블록 일부 케이스가 pending promise 등을
  // 리킹해 fast-path effect가 통과 안 하는 leakage 회피.
  describe('#1266 fast-path hop window 게이트 (Epic #1204 D2 follow-up)', () => {
    // 직전 #917/#1012 등 일부 케이스가 mockReturnValueOnce(pending promise) 또는
    // mockImplementation(pending)을 queue에 남길 수 있어 본 describe 진입 시 명시적 reset.
    // clearAllMocks(top-level beforeEach)는 호출 기록만 clear하고 queued 반환값/
    // mockImplementation은 보존되기 때문.
    beforeEach(() => {
      mockGetFiredAlarms.mockReset();
      mockGetFiredAlarms.mockResolvedValue(new Set<string>());
      mockSendStationPassedNotification.mockReset();
      mockSendStationPassedNotification.mockResolvedValue(undefined);
    });

    const route1266 = makeDirectRoute(3, '2');
    const activeLock1266 = {
      destinationId: 'D1',
      trainCode: 'T-LOCK',
      boardingStationId: 'S0',
      boardingLine: '2' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };
    const dummyArrival = { up: [], down: [], isMock: false };
    // arcStations: 7개 (A0~A6), 모두 line='2' — route('2')와 일치.
    const arcLine2: Station[] = Array.from({ length: 7 }, (_, i) =>
      makeStation(`FP-A${i}`, `FPSname${i}`, 37.5 + i * 0.001, 127.0 + i * 0.001),
    );

    function inputs1266(overrides: Partial<UseStationAlarmInputs>): UseStationAlarmInputs {
      return defaultInputs({
        route: route1266,
        destination,
        nearestStation: arcLine2[0],
        speedMps: 5,
        accuracyMeters: 50,
        currentStationArrival: dummyArrival,
        ...overrides,
      });
    }

    it('22:31 회귀 차단 — currentHopIndex=0 + nearestStation=arc[4] (+4 hop 미래) → fast-path suppressed', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          inputs1266({
            nearestStation: arcLine2[4],
            currentHopIndex: 0,
            arcStations: arcLine2,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg-arvlcd',
          stationName: arcLine2[4].name,
          currentHopIndex: 0,
          candidateIndex: 4,
        });
      });
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('22:31 회귀 차단 — currentHopIndex=0 + nearestStation=arc[6] (+6 hop 미래) → fast-path suppressed', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          inputs1266({
            nearestStation: arcLine2[6],
            currentHopIndex: 0,
            arcStations: arcLine2,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg-arvlcd',
          stationName: arcLine2[6].name,
          currentHopIndex: 0,
          candidateIndex: 6,
        });
      });
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('정상 case — currentHopIndex=3 + nearestStation=arc[3] (동일 hop) → fast-path fire (정상 동작 보존)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          inputs1266({
            nearestStation: arcLine2[3],
            currentHopIndex: 3,
            arcStations: arcLine2,
          }),
        ),
      );

      // #1515 — cross-category dedup으로 GPS path/fast-path 중 먼저 reservation 점유한 쪽만
      // dedup bookkeeping 완료. #2064 — 로컬 알림(logFiredStationPassed)은 제거되어 미호출.
      await waitFor(() =>
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, arcLine2[3].id),
      );
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
    });

    it('estimator null + firedAlarms 빈 set → no-source 적재 + fast-path 게이트 미적용 (graceful fallback)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          inputs1266({
            nearestStation: arcLine2[0],
            currentHopIndex: null,
            arcStations: arcLine2,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledWith({
          source: 'fg-arvlcd',
          stationName: arcLine2[0].name,
        });
      });
      // 게이트 미적용이므로 정상 감지. #1515 — GPS path/fast-path 중 reservation을 먼저 잡은 쪽만
      // dedup bookkeeping 완료. #2064 — 로컬 알림은 제거되어 미호출.
      await waitFor(() =>
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, arcLine2[0].id),
      );
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
    });

    it('#1806 fast-path 60s dedup — no-source가 60s 내 재발사 시 두 번째 적재 skip', async () => {
      const T1 = 1_700_000_000_000;
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(T1);
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });
      // currentStationArrival 객체 참조를 매 rerender마다 교체해 fg-arvlcd effect deps 재발사 유도.
      // GPS path는 currentStationArrival을 dep으로 사용하지 않으므로 재발사 여부에 영향 없음.
      const makeInputs = (tick: number) =>
        inputs1266({
          nearestStation: arcLine2[0],
          currentHopIndex: null,
          arcStations: arcLine2,
          // 새 객체 참조 → currentStationArrival dep 변경 → fg-arvlcd effect 재실행.
          currentStationArrival: { ...dummyArrival, _tick: tick } as unknown as typeof dummyArrival,
        });
      const { rerender } = renderHook((tick: number) => useStationAlarm(makeInputs(tick)), {
        initialProps: 0,
      });
      try {
        // 첫 번째 cycle: T1 - 0(초기ref) >= 60_000 → fg-arvlcd path 적재됨.
        await waitFor(() =>
          expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledWith({
            source: 'fg-arvlcd',
            stationName: arcLine2[0].name,
          }),
        );
        const callCountAfterFirst =
          mockLogSuppressedHopWindowNoSource.mock.calls.filter(
            (c) => c[0].source === 'fg-arvlcd',
          ).length;
        // T1 + 30s (60s 이내) → fg-arvlcd dedup skip.
        dateNowSpy.mockReturnValue(T1 + 30_000);
        rerender(1);
        await new Promise<void>((r) => setTimeout(r, 50));
        expect(
          mockLogSuppressedHopWindowNoSource.mock.calls.filter(
            (c) => c[0].source === 'fg-arvlcd',
          ).length,
        ).toBe(callCountAfterFirst);
        // T1 + 61s (60s 초과) → fg-arvlcd 새 적재.
        dateNowSpy.mockReturnValue(T1 + 61_000);
        rerender(2);
        await waitFor(() =>
          expect(
            mockLogSuppressedHopWindowNoSource.mock.calls.filter(
              (c) => c[0].source === 'fg-arvlcd',
            ).length,
          ).toBeGreaterThan(callCountAfterFirst),
        );
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('arcStations 빈 배열 → 게이트 자체 미적용 (기존 동작 보존)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock1266);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          inputs1266({
            currentHopIndex: 99,
            arcStations: [],
          }),
        ),
      );

      // #1515 — GPS path/fast-path 중 reservation을 먼저 잡은 쪽만 dedup bookkeeping 완료.
      // #2064 — 로컬 알림은 제거되어 미호출.
      await waitFor(() =>
        expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, arcLine2[0].id),
      );
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindowNoSource).not.toHaveBeenCalled();
    });
  });

  // #1012 (H5) — hydration state machine: pre-hydrate → hydrating → storage-synced → ready.
  // 'ready' 도달 전 phase 알람 발사가 보류되는지, transition이 alarmLog로 측정되는지 검증.
  describe('#1012 hydration state machine (H5)', () => {
    it('4 phase transition이 순서대로 logHydrationTransition으로 적재된다', async () => {
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // 'ready' 도달까지 대기 — hydration 완료 후에만 사이클이 끝난다.
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());

      const phases = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phases).toEqual(['pre-hydrate', 'hydrating', 'storage-synced', 'ready']);
      // 모든 transition은 같은 destinationId로 묶인다.
      for (const call of mockLogHydrationTransition.mock.calls) {
        expect(call[1]).toBe(destination.id);
      }
    });

    it("'ready' 도달 전(drain pending)에는 phase 알람 발사 보류", async () => {
      // drain을 영원히 pending → storage-synced에 도달 못함 → 'ready' 도달 못함.
      mockAwaitInitialScheduledAlarmDrain.mockReturnValueOnce(new Promise(() => {}));
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      // pre-hydrate / hydrating까지만 sync 적재 — storage-synced/ready 없음.
      await Promise.resolve();
      await Promise.resolve();
      const phases = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phases).toContain('pre-hydrate');
      expect(phases).toContain('hydrating');
      expect(phases).not.toContain('storage-synced');
      expect(phases).not.toContain('ready');
      // 'ready' 미도달 → phase 알람 보류.
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it("'ready' 도달 후에만 phase 알람 발사 허용", async () => {
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // 'ready' 도달 후 발사.
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
      const phases = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phases[phases.length - 1]).toBe('ready');
    });

    it("destination 전환 시 state machine 재시작 (새 destinationId로 4 phase 재적재)", async () => {
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      const { rerender } = renderHook(
        ({ dest }: { dest: Station }) =>
          useStationAlarm(defaultInputs({ route, destination: dest })),
        { initialProps: { dest: destination } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalledWith(destination.id));

      mockLogHydrationTransition.mockClear();
      rerender({ dest: altDestination });

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalledWith(altDestination.id));
      const phases = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phases).toEqual(['pre-hydrate', 'hydrating', 'storage-synced', 'ready']);
      for (const call of mockLogHydrationTransition.mock.calls) {
        expect(call[1]).toBe(altDestination.id);
      }
    });

    it('drain 완료 후 destination 전환 → getFiredAlarms resolve 시 cancelled로 ready 미적재', async () => {
      const route = makeDirectRoute(1, '2');
      // 첫 destination: getFiredAlarms를 controllable promise로 보류.
      let resolveFired = (_s: Set<string>): void => {};
      mockGetFiredAlarms.mockReturnValueOnce(
        new Promise<Set<string>>((resolve) => {
          resolveFired = resolve;
        }),
      );

      const { rerender } = renderHook(
        ({ dest }: { dest: Station }) =>
          useStationAlarm(defaultInputs({ route, destination: dest })),
        { initialProps: { dest: destination } },
      );
      // drain 통과 → storage-synced 적재까지 진행.
      await waitFor(() =>
        expect(
          mockLogHydrationTransition.mock.calls.some((c) => c[0] === 'storage-synced'),
        ).toBe(true),
      );

      // destination 교체 → 첫 effect cleanup → cancelled=true.
      rerender({ dest: altDestination });
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalledWith(altDestination.id));

      mockLogHydrationTransition.mockClear();
      // 첫 effect의 getFiredAlarms 뒤늦게 resolve → cancelled 가드로 ready 적재 안 됨.
      resolveFired(new Set<string>());
      await Promise.resolve();
      await Promise.resolve();
      const phasesAfterStale = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phasesAfterStale).not.toContain('ready');
    });

    it('destination 전환으로 effect cleanup → drain 완료 후 setState 호출되지 않음 (cancelled gate)', async () => {
      const route = makeDirectRoute(1, '2');
      // drain을 controllable promise로 보류.
      let resolveDrain = (): void => {};
      mockAwaitInitialScheduledAlarmDrain.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveDrain = () => resolve();
        }),
      );

      const { rerender, unmount } = renderHook(
        ({ dest }: { dest: Station }) =>
          useStationAlarm(defaultInputs({ route, destination: dest })),
        { initialProps: { dest: destination } },
      );

      // 첫 destination 효과는 pre-hydrate + hydrating까지만 적재.
      await Promise.resolve();
      // destination 교체 → 첫 effect cleanup, 두 번째 effect는 즉시 drain resolve된 default mock 사용.
      rerender({ dest: altDestination });
      // 두 번째 effect는 정상 사이클 완료.
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalledWith(altDestination.id));

      mockLogHydrationTransition.mockClear();
      // 첫 effect의 drain promise 뒤늦게 resolve → cancelled 가드로 storage-synced/ready 적재 안 됨.
      resolveDrain();
      await Promise.resolve();
      await Promise.resolve();
      const phasesAfterStaleResolve = mockLogHydrationTransition.mock.calls.map((c) => c[0]);
      expect(phasesAfterStaleResolve).not.toContain('storage-synced');
      expect(phasesAfterStaleResolve).not.toContain('ready');
      unmount();
    });
  });

  describe('#1208 (Epic #1204 D2) station-passed hop window 게이트', () => {
    // arcStations: 7개 (S0~S6), 모두 line='2' — isStationOnRoute(direct, '2') 통과.
    const arc: Station[] = Array.from({ length: 7 }, (_, i) =>
      makeStation(`A${i}`, `Sname${i}`, 37.5 + i * 0.001, 127.0 + i * 0.001),
    );
    const directRouteOnLine2 = makeDirectRoute(6, '2');

    it('22:11:56 사가정 회귀 차단 — lockless + currentHopIndex=2 + candidate arc[6] → suppressed', async () => {
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[6],
            currentHopIndex: 2,
            arcStations: arc,
            // station-passed effect 통과 조건 — accuracy 통과.
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arc[6].name,
          currentHopIndex: 2,
          candidateIndex: 6,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('13:28:35 성수 fire 차단 — lockless + currentHopIndex=2 + candidate arc[6] (=현재+4) → suppressed', async () => {
      // 4정거장 미래 — currentHopIndex=2면 window [1,3]이라 candidate 6은 차단.
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[6],
            currentHopIndex: 2,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('lock 활성 + 정상 hop (currentHopIndex=3, candidate arc[3]) → 통과 (기존 동작 보존)', async () => {
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[3],
            currentHopIndex: 3,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
    });

    it('estimator null + firedAlarms 빈 set + candidate arc[0] → pass (graceful fallback no-source)', async () => {
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 6,
        isTransfer: false,
        stopsToDestination: 6,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[0],
            currentHopIndex: null,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arc[0].name,
        });
      });
      // 게이트 미적용이므로 알람은 정상 발사된다.
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('arcStations 빈 배열 → 게이트 자체 미적용 (기존 동작 보존)', async () => {
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 1,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[0],
            currentHopIndex: 5,
            arcStations: [],
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindowNoSource).not.toHaveBeenCalled();
    });

    it('firedAlarms fallback — fired set의 station이 arc 밖이면 inferred=-1 → no-source 적재 + 게이트 미적용', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set<string>(['early:OFFROUTE_STATION']));
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 1,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[0],
            currentHopIndex: null,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalled();
      });
      // 게이트 미적용 → 알람 정상 발사.
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('#1806 60s dedup — no-source가 60s 내 재발사 시 두 번째 적재 skip', async () => {
      const T1 = 1_700_000_000_000;
      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(T1);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 1,
      });
      // userLocation.lat 변경으로 GPS station-passed effect deps 재발사 유도.
      const makeInputs = (lat: number) =>
        defaultInputs({
          route: directRouteOnLine2,
          destination,
          nearestStation: arc[0],
          currentHopIndex: null,
          arcStations: arc,
          userLocation: { lat, lng: 127.0 },
          speedMps: 10,
          accuracyMeters: 50,
        });
      const { rerender } = renderHook((lat: number) => useStationAlarm(makeInputs(lat)), {
        initialProps: 37.5,
      });
      try {
        // 첫 번째 cycle: T1 - 0(초기ref) = T1 >= 60_000 → 적재됨.
        await waitFor(() => expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledTimes(1));
        // T1 + 30s (60s 이내) → dedup skip.
        dateNowSpy.mockReturnValue(T1 + 30_000);
        rerender(37.501);
        // 30s 후 재발사해도 여전히 1건만.
        await new Promise<void>((r) => setTimeout(r, 50));
        expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledTimes(1);
        // T1 + 61s (60s 초과) → 새 적재.
        dateNowSpy.mockReturnValue(T1 + 61_000);
        rerender(37.502);
        await waitFor(() => expect(mockLogSuppressedHopWindowNoSource).toHaveBeenCalledTimes(2));
      } finally {
        dateNowSpy.mockRestore();
      }
    });

    it('firedAlarms fallback — fired set의 max station이 arc 마지막이면 inferred는 arc 마지막에 cap', async () => {
      // arc[6] (마지막) 발사 기록 → inferred = min(6+1, 6) = 6. window [5,7] → arc[5] 통과.
      mockGetFiredAlarms.mockResolvedValue(new Set<string>([`early:${arc[6].name}`]));
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 1,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[5],
            currentHopIndex: null,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
    });

    it('firedAlarms fallback — fired set에 arc[2] station 포함 시 inferred hop=3 → arc[5] 차단 / arc[3] 통과', async () => {
      // firedAlarms에 "early:Sname2" 적재 → arc index 2가 max → inferred = 3.
      // window [2,4]이므로 arc[5]는 차단, arc[3]은 통과.
      mockGetFiredAlarms.mockResolvedValue(new Set<string>([`early:${arc[2].name}`]));
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[5],
            currentHopIndex: null,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arc[5].name,
          currentHopIndex: 3,
          candidateIndex: 5,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1922 (M1+M3) — transfer route에서 시간 적분 estimator가 stuck돼도 candidate(실측)는 fire 허용.
  // 환승 leg 진입 직후 estimator가 idx=2 (1번째 leg 마지막)로 stuck하고, 실제 사용자는 leg 2 진행해
  // candidate idx=4(2번째 leg 1정거장 진행)인 경우, 기본 windowSize=1로는 |4-2|=2 > 1이라 reject.
  // computeHopWindowSize가 transfer crossover를 감지해 windowSize를 동적 확장해 통과.
  describe('#1922 (M1+M3) transfer leg hop window 동적 확장', () => {
    // arc 구성: [S0, S1, T(line=2), T(line=4), S4, S5]
    // S0~T(line=2)는 line 2, T(line=4)~S5는 line 4. T가 transfer crossover.
    const buildTransferArc = (): Station[] => [
      { id: 'X-0', name: 'S0', line: '2', lineColor: '#x', lat: 37.5, lng: 127.0 },
      { id: 'X-1', name: 'S1', line: '2', lineColor: '#x', lat: 37.501, lng: 127.001 },
      { id: 'X-2', name: 'TP', line: '2', lineColor: '#x', lat: 37.502, lng: 127.002 },
      { id: 'X-3', name: 'TP', line: '4', lineColor: '#x', lat: 37.502, lng: 127.002 },
      { id: 'X-4', name: 'S4', line: '4', lineColor: '#x', lat: 37.503, lng: 127.003 },
      { id: 'X-5', name: 'S5', line: '4', lineColor: '#x', lat: 37.504, lng: 127.004 },
    ];
    const transferRoute = makeTransferRoute({
      transferName: 'TP',
      fromLine: '2',
      toLine: '4',
      stopsToTransfer: 2,
      stopsFromTransfer: 2,
    });

    it('M1: transfer route + estimator stuck(time-integration) + crossover → windowSize 확장으로 통과', async () => {
      // estimator stuck at idx=2 (1번째 leg 마지막), candidate at idx=4 (2번째 leg 진행).
      // 기본 windowSize=1로는 |4-2|=2 > 1 → reject. M1으로 확장 후 통과.
      const arcWithTransfer = buildTransferArc();
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: transferRoute,
            destination,
            nearestStation: arcWithTransfer[4],
            currentHopIndex: 2,
            arcStations: arcWithTransfer,
            currentHopStrategy: 'lockless-route-hop',
            userLocation: { lat: 37.503, lng: 127.003 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
    });

    it('M3 신뢰도 게이트: live-position strategy면 확장 X → 격차 ≥ 2일 때 정상 reject', async () => {
      // live-position(실측)에서 격차 2 = abnormal jump 신호 (GPS jitter / wrong train) → 확장 금지.
      const arcWithTransfer = buildTransferArc();
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: transferRoute,
            destination,
            nearestStation: arcWithTransfer[4],
            currentHopIndex: 2,
            arcStations: arcWithTransfer,
            currentHopStrategy: 'live-position',
            userLocation: { lat: 37.503, lng: 127.003 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arcWithTransfer[4].name,
          currentHopIndex: 2,
          candidateIndex: 4,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('direct route → 확장 X (M1 게이트 조건 미충족) → 격차 ≥ 2일 때 정상 reject', async () => {
      // direct route는 환승 없음 → 확장 의미 없음. 기존 동작 보존.
      const arc7 = Array.from({ length: 7 }, (_, i) =>
        makeStation(`DR-A${i}`, `DRname${i}`, 37.5 + i * 0.001, 127.0 + i * 0.001),
      );
      const directRoute = makeDirectRoute(6, '2');
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRoute,
            destination,
            nearestStation: arc7[4],
            currentHopIndex: 2,
            arcStations: arc7,
            currentHopStrategy: 'lockless-route-hop',
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arc7[4].name,
          currentHopIndex: 2,
          candidateIndex: 4,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('transfer route + crossover 없음(같은 leg 내 격차) → 확장 X', async () => {
      // 같은 leg 내 격차는 정상 estimator 진행으로 처리해야 함. transfer point 끼어 있지 않음.
      // arc[1] → arc[3] 사이에는 transfer 있지만, arc[0] → arc[1]은 leg 1 내. estimator 0 + candidate 1
      // 은 격차 1이라 windowSize=1로도 통과 (M1 트리거 자체 안 됨).
      // 격차 ≥ 2 + 같은 leg 격차 케이스: candidate=arc[1] (leg 1) + estimator=arc[0] (leg 1) — 격차 1 통과.
      // 격차 2 + 같은 leg: 환승 leg는 4 stops밖에 안 되므로 leg 1 내 격차 2가 nontrivial.
      // 검증: arc 길이 6 (S0~S5), candidate=arc[5] (leg 2 끝), estimator=arc[3] (leg 2 시작). 격차 2.
      // arc[3]과 arc[5] 사이에 transfer crossover 없음 → 확장 X → reject.
      const arcWithTransfer = buildTransferArc();
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: transferRoute,
            destination,
            nearestStation: arcWithTransfer[5],
            currentHopIndex: 3,
            arcStations: arcWithTransfer,
            currentHopStrategy: 'lockless-route-hop',
            userLocation: { lat: 37.504, lng: 127.004 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arcWithTransfer[5].name,
          currentHopIndex: 3,
          candidateIndex: 5,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('currentHopStrategy 미전달 → 기본 windowSize 유지 (backward-compat)', async () => {
      // currentHopStrategy=null → live-position 검사도 안 되지만, 동시에 dynamic 확장 자체 트리거 안 됨.
      // 실제로는 strategy unset이면 M3 게이트 통과해서 M1 격차 확장 가능.
      // 본 테스트는 backward-compat 확인 — strategy 없이 transfer route + crossover이면 확장 동작.
      const arcWithTransfer = buildTransferArc();
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: transferRoute,
            destination,
            nearestStation: arcWithTransfer[4],
            currentHopIndex: 2,
            arcStations: arcWithTransfer,
            // currentHopStrategy 생략
            userLocation: { lat: 37.503, lng: 127.003 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // strategy 미전달은 live-position 아니므로 M3 게이트 통과 → M1 확장 적용 → 통과.
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedHopWindow).not.toHaveBeenCalled();
    });

    it('candidate가 arc 밖(arcIndexOf=-1) → 기본 windowSize → isStationWithinHopWindow가 false 처리', async () => {
      // candidate가 route line에는 있지만 arc 안에는 없는 케이스(예: boarding 이전 / destination 이후 역).
      // computeHopWindowSize의 candidateIndex < 0 가드가 LOCKLESS_HOP_WINDOW_DEFAULT 반환.
      // isStationWithinHopWindow가 candidate가 arc에 없으면 false → reject 정상 처리.
      const arcWithTransfer = buildTransferArc();
      const offArcButOnLine: Station = {
        id: 'X-99',
        name: 'OffArc',
        line: '2',
        lineColor: '#x',
        lat: 37.6,
        lng: 127.1,
      };
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: transferRoute,
            destination,
            nearestStation: offArcButOnLine,
            currentHopIndex: 2,
            arcStations: arcWithTransfer,
            currentHopStrategy: 'lockless-route-hop',
            userLocation: { lat: 37.6, lng: 127.1 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // candidate is off-arc → isStationWithinHopWindow false → suppress.
      await waitFor(() => {
        expect(mockLogSuppressedHopWindow).toHaveBeenCalled();
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1514 — 2026-06-19 용마산 회귀: lockless trip 출발역(arc[0]) station-passed false fire 차단.
  // GPS path에서 currentHopIndex=0 + candidateIndex=0이면 estimator default-hop 신호이므로
  // lock 부재 시 fire 차단. lock 활성은 boardingStationId 기준 origin 알림이 정당이라 우회.
  describe('#1514 lockless origin hop 차단 (출발역 자기 자신)', () => {
    const arcOrigin: Station[] = Array.from({ length: 5 }, (_, i) =>
      makeStation(`OH-A${i}`, `OHname${i}`, 37.6 + i * 0.001, 127.1 + i * 0.001),
    );
    const routeDirectOrigin = makeDirectRoute(4, '2');

    const renderOriginHopCase = (nearestIndex: number, currentHopIndex: number) =>
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirectOrigin,
            destination,
            nearestStation: arcOrigin[nearestIndex],
            currentHopIndex,
            arcStations: arcOrigin,
            userLocation: { lat: 37.6, lng: 127.1 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

    const mockNextTargetStops = (stops: number) => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: stops,
        isTransfer: false,
        stopsToDestination: stops,
      });
    };

    it('lockless + currentHopIndex=0 + candidate arc[0] → suppressed (lockless-no-user-intent, #1816 broad guard)', async () => {
      // #1816 — lock=null 시 origin hop 여부와 무관하게 lockless-no-user-intent 가드로 차단.
      // 기존 gate-origin-hop-lockless(#1514)는 lockless-no-user-intent broad guard의 subset이 됨.
      mockGetBoardingLock.mockResolvedValue(null);
      renderOriginHopCase(0, 0);
      await waitFor(() => {
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: arcOrigin[0].name,
            kind: 'station-passed',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredStationPassed).not.toHaveBeenCalledWith('fg', arcOrigin[0]);
      // broad guard가 앞서 차단하므로 narrow origin-hop guard는 호출 안 됨.
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
    });

    // #1630 — lockless mode는 estimator(시간 적분)가 idx를 임의 진행할 수 있으므로 출발역
    // 머무는 동안에도 effectiveHopIndex >= 1이 정상 산출됨 (2026-06-22 08:34:18 용마산 evidence).
    // candidate가 arc[0]이면 effectiveHopIndex 값과 무관하게 차단해야 한다 (ADR-014 §4).
    // effectiveHopIndex가 hop window 범위(±1)를 넘으면 별도 gate-hop-window 가드가 먼저 차단하므로
    // 본 가드 직접 cover는 effectiveHopIndex=1 케이스 (직전 trip evidence와 정합).
    it('#1630 lockless + currentHopIndex=1 + candidate arc[0] → suppressed (lockless-no-user-intent, #1816 broad guard)', async () => {
      // #1816 — lock=null 시 candidate index와 무관하게 lockless-no-user-intent 가드로 차단.
      mockGetBoardingLock.mockResolvedValue(null);
      renderOriginHopCase(0, 1);
      await waitFor(() => {
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: arcOrigin[0].name,
            kind: 'station-passed',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
    });

    // #1630 회귀 가드 — lock 활성 + currentHopIndex=1 + candidate arc[0]: isOriginHopCandidate=true이지만
    // IIFE 내 `!lock` 조건에 걸려 #1514 lockless 가드 미발사 + #1599 lock-origin 가드로 차단해야 함.
    // (이번 fix로 lock 활성에서 영향 받지 않음을 명시 검증)
    it('#1630 lock 활성 + currentHopIndex=1 + candidate arc[0] → #1599 lock-origin 가드로 차단 (lockless 가드 미발사)', async () => {
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-LOCK',
        boardingStationId: arcOrigin[0].id,
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      });
      mockNextTargetStops(4);
      renderOriginHopCase(0, 1);
      await waitFor(() => {
        expect(mockLogSuppressedPassedEventOnLockOrigin).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arcOrigin[0].name,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
    });

    it('#1599 band-aid — lock 활성 + currentHopIndex=0 + candidate arc[0] (= boardingStationId) → 차단 (passed-event-on-lock-origin)', async () => {
      // ADR-014 §4 "lock origin은 정당 신호" 명제는 2026-06-20 용마산 evidence(lock 1초 후 origin 자체에
      // station-passed fire = X1 wrong-station-alarm)로 반증됨. #1596(autoLock multi-signal consensus)이
      // 머지될 때까지 origin candidate는 차단 — 출발역에서 출발하면 첫 hop은 "다음 역"이지 origin 자체가 아님.
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-LOCK',
        boardingStationId: arcOrigin[0].id,
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 600_000,
      });
      mockNextTargetStops(4);
      renderOriginHopCase(0, 0);
      await waitFor(() => {
        expect(mockLogSuppressedPassedEventOnLockOrigin).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arcOrigin[0].name,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
    });

    it('lockless + currentHopIndex=0 + candidate arc[1] (다음 hop) → lockless-no-user-intent 차단 (#1816)', async () => {
      // #1816 — lock=null이면 candidate index와 무관하게 lockless-no-user-intent 가드로 차단.
      // 기존: 다음 hop은 통과(origin hop만 차단). 변경: lockless trip 자체가 fire X.
      mockGetBoardingLock.mockResolvedValue(null);
      mockNextTargetStops(3);
      renderOriginHopCase(1, 0);
      await waitFor(() => {
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'fg', kind: 'station-passed' }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('lockless + currentHopIndex=2 + candidate arc[2] (중간 hop) → lockless-no-user-intent 차단 (#1816)', async () => {
      // #1816 — lock=null이면 중간 hop도 lockless-no-user-intent 가드로 차단.
      mockGetBoardingLock.mockResolvedValue(null);
      mockNextTargetStops(2);
      renderOriginHopCase(2, 2);
      await waitFor(() => {
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'fg', kind: 'station-passed' }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1236 (Epic #1204 D8 wire) — FG dispatch path가 station-passed sleep 룰 게이트를 호출한다.
  // 2026-06-12 22:11:56 사가정 station-passed 회귀 재현 차단 evidence.
  // D8(#1227)이 shouldSuppressBySleepRule을 station-passed로 확장했고, 본 PR이 FG GPS / arvlCd
  // fast path 양쪽에서 게이트를 호출하도록 wire.
  describe('#1236 sleep 룰 게이트 — station-passed (FG dispatch wire)', () => {
    const onRouteStation = makeStation('S-PASS', '사가정', 37.5, 127.0);
    const routeDirect = makeDirectRoute(3, '2');
    const lockOnSagajeong = {
      destinationId: destination.id,
      trainCode: 'T-LOCK',
      // candidate.id === boardingStationId → isStationPassedFirstHop(lock active) true.
      boardingStationId: onRouteStation.id,
      boardingLine: '2' as const,
      boardedAt: Date.now(),
      expectedDurationMs: 60 * 60_000,
    };

    function withSleepGateInputs(
      overrides: Partial<UseStationAlarmInputs> = {},
    ): UseStationAlarmInputs {
      return defaultInputs({
        route: routeDirect,
        destination,
        nearestStation: onRouteStation,
        userLocation: { lat: 37.5, lng: 127.0 },
        speedMps: 10,
        accuracyMeters: 50,
        ...overrides,
      });
    }

    type ExpectGate = 'lockless' | 'lock-origin' | 'none';
    it.each([
      {
        // #1816 — lockless trip은 sleep gate 진입 전에 lockless-no-user-intent 가드가 먼저 차단.
        // 기존: 'sleep gate로 차단' → 변경: 'lockless-no-user-intent로 차단'.
        name: 'FG GPS path — lockless + sleep ON + currentHopIndex=0 → lockless-no-user-intent 차단 (#1816)',
        sleepMode: true,
        lockValue: null as typeof lockOnSagajeong | null,
        currentHopIndex: 0 as number | null,
        expectGate: 'lockless' as ExpectGate,
      },
      {
        // #1599 band-aid — lock 활성 + candidate=boardingStation은 sleep gate 진입 전에
        // passed-event-on-lock-origin 가드가 먼저 차단. 다른 가드(#1236 sleep)는 호출되지 않음.
        name: 'FG GPS path — lock 활성 + sleep ON + candidate=boardingStation → #1599 lock-origin 가드로 차단 (sleep gate 전)',
        sleepMode: true,
        lockValue: lockOnSagajeong,
        currentHopIndex: null,
        expectGate: 'lock-origin' as ExpectGate,
      },
      {
        // #1816 — lockless trip은 sleep OFF여도 lockless-no-user-intent 가드로 차단.
        name: 'FG GPS path — sleep OFF + lockless + currentHopIndex=0 → lockless-no-user-intent 차단 (#1816)',
        sleepMode: false,
        lockValue: null as typeof lockOnSagajeong | null,
        currentHopIndex: 0 as number | null,
        expectGate: 'lockless' as ExpectGate,
      },
      {
        // #1816 — lockless trip은 hop index와 무관하게 lockless-no-user-intent 가드로 차단.
        name: 'FG GPS path — sleep ON + lockless + currentHopIndex=3 → lockless-no-user-intent 차단 (#1816)',
        sleepMode: true,
        lockValue: null as typeof lockOnSagajeong | null,
        currentHopIndex: 3 as number | null,
        expectGate: 'lockless' as ExpectGate,
      },
      {
        name: 'FG GPS path — sleep ON + lock 활성 + candidate≠boardingStation → 정상 발사',
        sleepMode: true,
        lockValue: { ...lockOnSagajeong, boardingStationId: 'S-OTHER' },
        currentHopIndex: null,
        expectGate: 'none' as ExpectGate,
      },
    ])('$name', async ({ sleepMode, lockValue, currentHopIndex, expectGate }) => {
      useSettingsStore.setState({ sleepMode });
      mockGetBoardingLock.mockResolvedValue(lockValue);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });

      renderHook(() => useStationAlarm(withSleepGateInputs({ currentHopIndex })));

      if (expectGate === 'lockless') {
        await waitFor(() =>
          expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'fg', kind: 'station-passed' }),
          ),
        );
        expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
        expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
        // lockless guard가 앞서 차단하므로 sleep gate는 호출 안 됨.
        expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
      } else if (expectGate === 'lock-origin') {
        await waitFor(() =>
          expect(mockLogSuppressedPassedEventOnLockOrigin).toHaveBeenCalledWith({
            source: 'fg',
            stationName: onRouteStation.name,
          }),
        );
        expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
        expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
        // lock-origin guard는 sleep gate보다 위에 있어 sleep stamp는 발생하지 않음.
        expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
      } else {
        // #2064 — station-passed 감지 성공은 dedup bookkeeping으로 검증(로컬 알림 미발사).
        await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
        expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
        expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
        expect(mockLogSuppressedPassedEventOnLockOrigin).not.toHaveBeenCalled();
      }
    });

    // #1599 band-aid: arvlCd fast path에서 lock 활성 + candidate=boardingStation은
    // sleep 무관 항상 lock-origin 가드가 먼저 차단. 사용자 의향 가장 강한 가드이므로
    // sleep ON/OFF 모두 적용 (it.each로 매트릭스 검증).
    it.each([
      { sleepMode: true, label: 'sleep ON (sleep gate 전 차단)' },
      { sleepMode: false, label: 'sleep OFF (사용자 의향 강한 가드)' },
    ])(
      'FG arvlCd fast path — lock 활성 + first hop + $label → #1599 lock-origin 가드로 차단',
      async ({ sleepMode }) => {
        useSettingsStore.setState({ sleepMode });
        mockGetBoardingLock.mockResolvedValue(lockOnSagajeong);
        mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });
        mockGetLastNotifiedStationId.mockResolvedValue(null);

        renderHook(() =>
          useStationAlarm(
            withSleepGateInputs({
              currentHopIndex: null,
              currentStationArrival: { up: [], down: [] } as unknown as Parameters<
                typeof useStationAlarm
              >[0]['currentStationArrival'],
            }),
          ),
        );

        await waitFor(() => {
          const calls = mockLogSuppressedPassedEventOnLockOrigin.mock.calls;
          expect(calls.some((c) => c[0]?.source === 'fg-arvlcd')).toBe(true);
        });
        expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
        expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
        // lock-origin guard가 sleep gate보다 위에 있어 sleep stamp는 발생하지 않음.
        expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
      },
    );

    it('GPS station-passed IIFE: getBoardingLock 후 cleanup → 후속 dispatch 미실행 (cancelled guard)', async () => {
      // #1236 — GPS path에 추가된 lock fetch IIFE의 `if (cancelled) return;` 분기 커버.
      const resolvers: Array<(v: typeof lockOnSagajeong | null) => void> = [];
      mockGetBoardingLock.mockImplementation(
        () =>
          new Promise<typeof lockOnSagajeong | null>((r) => {
            resolvers.push(r);
          }),
      );
      useSettingsStore.setState({ sleepMode: false });

      const { unmount } = renderHook(() =>
        useStationAlarm(withSleepGateInputs({ currentHopIndex: null })),
      );
      await waitFor(() => expect(mockGetBoardingLock).toHaveBeenCalled());
      unmount();
      // unmount 후 lock resolve → IIFE의 `if (cancelled) return;`이 후속 dispatch를 차단.
      resolvers.forEach((r) => r(null));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
    });
  });

  // #1290/#1298 — subsurfaceStationDetected verdict 기반 station-passed 발사.
  // GPS 거리/정확도 게이트 우회 — fusion 레이어가 이미 ≥2 신호 합의 + 역 근접 통과시킨 신호.
  describe('#1298 subsurfaceStationDetected → station-passed 발사', () => {
    const routeDirect = makeDirectRoute(3, '2');
    const onRouteStation = makeStation('S-SUB', '봉은사', 37.5, 127.0);

    function subsurfaceInputs(
      overrides: Partial<UseStationAlarmInputs> = {},
    ): UseStationAlarmInputs {
      return defaultInputs({
        route: routeDirect,
        destination,
        nearestStation: onRouteStation,
        // GPS 게이트 차단 상태 (accuracy 불량) — subsurface path는 이 게이트를 우회해야 함
        accuracyMeters: 500,
        userLocation: null,
        speedMps: null,
        subsurfaceStationDetected: true,
        ...overrides,
      });
    }

    it('subsurfaceStationDetected=true + 새 station → station-passed 발사 (GPS 게이트 무관)', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });

      renderHook(() => useStationAlarm(subsurfaceInputs()));

      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      // GPS phase 알람은 accuracyMeters=500으로 차단
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + 이미 발사한 station → dedup으로 미발사', async () => {
      // lastNotifiedStationId가 이미 onRouteStation.id → 중복 차단
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(subsurfaceInputs()));

      await waitFor(() => expect(mockLogSuppressedDedupStation).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=false → 기존 GPS path 동작 유지 (회귀 없음)', () => {
      renderHook(() =>
        useStationAlarm(
          subsurfaceInputs({
            subsurfaceStationDetected: false,
          }),
        ),
      );

      // GPS 게이트 차단(accuracyMeters=500) + subsurface=false → 어떤 경로도 발화 안 함
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected 미전달(undefined) → 기존 동작 유지 (graceful fallback)', () => {
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500,
          }),
        ),
      );

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + nearestStation이 route 위에 없음(다른 노선) → 미발사', async () => {
      // routeDirect는 line='2' 기반. 다른 노선 역은 isStationOnRoute에서 false.
      const offRouteStation: Station = { ...makeStation('S-OFF', '노원', 37.655, 127.061), line: '7' };

      renderHook(() =>
        useStationAlarm(
          subsurfaceInputs({
            nearestStation: offRouteStation,
          }),
        ),
      );

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + route=null → 미발사 (guard)', async () => {
      renderHook(() =>
        useStationAlarm(
          subsurfaceInputs({
            route: null,
          }),
        ),
      );

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + destination=null → 미발사 (guard)', async () => {
      renderHook(() =>
        useStationAlarm(
          subsurfaceInputs({
            destination: null,
          }),
        ),
      );

      // destination=null이면 hydration도 complete되지 않으므로 waitFor 없이 검증
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + nearestStation=null → 미발사 (guard)', async () => {
      renderHook(() =>
        useStationAlarm(
          subsurfaceInputs({
            nearestStation: null,
          }),
        ),
      );

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + hydrationPhase 미완료(pre-hydrate) → 미발사', () => {
      // awaitInitialScheduledAlarmDrain을 pending 상태로 두면 hydrationPhase가 ready 미진입
      mockAwaitInitialScheduledAlarmDrain.mockReturnValue(new Promise(() => {}));
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      renderHook(() => useStationAlarm(subsurfaceInputs()));

      // hydration 미완료이므로 발사 안 됨
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + destination 교체 직후(ref mismatch) → logRefMismatch + 미발사', async () => {
      // 1) 첫 destination hydration 완료 후 subsurface 발사 확인.
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });

      const { rerender } = renderHook(
        ({ dest }: { dest: Station }) =>
          useStationAlarm(subsurfaceInputs({ destination: dest })),
        { initialProps: { dest: destination } },
      );
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();

      // 2) destination 교체 → hydration 리셋(pre-hydrate). pending getFiredAlarms로 ready 미진입.
      mockGetFiredAlarms.mockReturnValue(new Promise(() => {}));
      mockSendStationPassedNotification.mockClear();
      mockLogRefMismatch.mockClear();

      rerender({ dest: altDestination });
      // hydration이 pending이라 ref는 아직 destination.id. subsurface effect가 altDestination.id ≠ ref → logRefMismatch.
      await waitFor(() => expect(mockLogRefMismatch).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('subsurfaceStationDetected=true + IIFE 중 cleanup → 후속 dispatch 미실행 (cancelled guard)', async () => {
      const resolvers: Array<(v: null) => void> = [];
      mockGetBoardingLock.mockImplementation(
        () =>
          new Promise<null>((r) => {
            resolvers.push(r);
          }),
      );
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      const { unmount } = renderHook(() => useStationAlarm(subsurfaceInputs()));
      await waitFor(() => expect(mockGetBoardingLock).toHaveBeenCalled());
      unmount();
      resolvers.forEach((r) => r(null));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1572 (T9, ADR-017) — SSoT fire gate wire 통합 acceptance.
  describe('#1572 SSoT fire gate (Path A / B / C / D wire)', () => {
    const arc: Station[] = Array.from({ length: 7 }, (_, i) =>
      makeStation(`A${i}`, `Sname${i}`, 37.5 + i * 0.001, 127.0 + i * 0.001),
    );
    const directRouteOnLine2 = makeDirectRoute(6, '2');

    beforeEach(() => {
      mockEvaluateSsotFireGate.mockReset();
      mockLogSuppressedSsotFireGate.mockReset();
      // 기본: mirror-missing graceful pass.
      mockEvaluateSsotFireGate.mockResolvedValue({ blocked: false, reason: 'mirror-missing' });
    });

    it('Path A (FG GPS station-passed): SSoT 게이트 block 시 dispatch X + logSuppressedSsotFireGate 호출', async () => {
      mockEvaluateSsotFireGate.mockResolvedValueOnce({
        blocked: true,
        reason: 'gate-station-already-passed',
      });
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[2],
            currentHopIndex: 2,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedSsotFireGate).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            reason: 'gate-station-already-passed',
            stationName: arc[2].name,
            kind: 'station-passed',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('Path A: SSoT 게이트 no-block (mirror-missing) → 정상 dispatch (회귀 차단)', async () => {
      mockEvaluateSsotFireGate.mockResolvedValue({ blocked: false, reason: 'mirror-missing' });
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[2],
            currentHopIndex: 2,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedSsotFireGate).not.toHaveBeenCalled();
    });

    it('Path B (FG arvlCd fast-path): SSoT 게이트 block 시 dispatch X', async () => {
      mockEvaluateSsotFireGate.mockResolvedValue({
        blocked: true,
        reason: 'gate-alarm-already-decided',
      });
      const onRouteStation = makeStation('S-시청', '시청');
      const activeLock = {
        destinationId: 'D1',
        trainCode: 'T-LOCK',
        boardingStationId: 'S0',
        boardingLine: '2' as const,
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValue(activeLock);
      // GPS path는 dedup으로 막아 fast-path만 본 게이트에 도달하도록.
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: makeDirectRoute(3, '2'),
            destination,
            nearestStation: onRouteStation,
            speedMps: 5,
            accuracyMeters: 50,
            currentStationArrival: { up: [], down: [], isMock: false },
          }),
        ),
      );

      await waitFor(() => {
        const fastPathBlocks = mockLogSuppressedSsotFireGate.mock.calls.filter(
          (c) => c[0].source === 'fg-arvlcd',
        );
        expect(fastPathBlocks.length).toBeGreaterThan(0);
      });
    });

    it('Path D (fireAndLog phase): SSoT 게이트 block 시 phase 알람 dispatch X', async () => {
      mockEvaluateSsotFireGate.mockResolvedValue({
        blocked: true,
        reason: 'gate-alarm-already-decided',
      });
      // phase 알람을 트리거하기 위한 evaluateAlarmPhase 반환.
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'imminent',
        type: 'destination',
        stationName: destination.name,
      });
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[3],
            currentHopIndex: 3,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => {
        const phaseBlocks = mockLogSuppressedSsotFireGate.mock.calls.filter(
          (c) => c[0].kind === 'destination' || c[0].kind === 'transfer',
        );
        expect(phaseBlocks.length).toBeGreaterThan(0);
      });
      // phase 알람 dispatch(sendAlarmNotification) 미호출.
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('Path C (subsurface verdict): SSoT 게이트 block 시 dispatch X', async () => {
      mockEvaluateSsotFireGate.mockResolvedValue({
        blocked: true,
        reason: 'gate-alarm-already-decided',
      });
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });
      const onRouteStation = makeStation('S-SUB', '봉은사', 37.5, 127.0);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: makeDirectRoute(3, '2'),
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500, // GPS 차단 → subsurface path만 활성
            userLocation: null,
            speedMps: null,
            subsurfaceStationDetected: true,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedSsotFireGate).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            reason: 'gate-alarm-already-decided',
            stationName: onRouteStation.name,
            kind: 'station-passed',
          }),
        );
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('Path B (arvlCd) evaluateSsotFireGate pending 중 unmount → cancelled guard (line 1157)', async () => {
      const resolvers: Array<(v: { blocked: boolean; reason: 'mirror-missing' }) => void> = [];
      mockEvaluateSsotFireGate.mockImplementation(
        () =>
          new Promise((r) => {
            resolvers.push(r);
          }),
      );
      const onRouteStation = makeStation('S-시청', '시청');
      const activeLock = {
        destinationId: 'D1',
        trainCode: 'T-LOCK',
        boardingStationId: 'S0',
        boardingLine: '2' as const,
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 600_000,
      };
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      const { unmount } = renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: makeDirectRoute(3, '2'),
            destination,
            nearestStation: onRouteStation,
            speedMps: 5,
            accuracyMeters: 50,
            currentStationArrival: { up: [], down: [], isMock: false },
          }),
        ),
      );
      await waitFor(() =>
        expect(mockEvaluateSsotFireGate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
      unmount();
      resolvers.forEach((r) => r({ blocked: false, reason: 'mirror-missing' }));
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // arvlCd fast-path silent — dispatch X
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('Path C (subsurface) evaluateSsotFireGate pending 중 unmount → cancelled guard (line 1245)', async () => {
      const resolvers: Array<(v: { blocked: boolean; reason: 'mirror-missing' }) => void> = [];
      mockEvaluateSsotFireGate.mockImplementation(
        () =>
          new Promise((r) => {
            resolvers.push(r);
          }),
      );
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });
      const onRouteStation = makeStation('S-SUB', '봉은사', 37.5, 127.0);

      const { unmount } = renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: makeDirectRoute(3, '2'),
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 500, // GPS 차단 → subsurface path만 활성
            userLocation: null,
            speedMps: null,
            subsurfaceStationDetected: true,
          }),
        ),
      );
      await waitFor(() =>
        expect(mockEvaluateSsotFireGate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
      unmount();
      resolvers.forEach((r) => r({ blocked: false, reason: 'mirror-missing' }));
      for (let i = 0; i < 12; i++) await Promise.resolve();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('evaluateSsotFireGate pending 중 unmount → cancelled guard 진입 (Path A/B/C 동시 cover)', async () => {
      // #1572 (T9) — 3 fire path 모두 `await evaluateSsotFireGate` 직후 `if (cancelled) return;` 가드.
      // pending 동안 unmount → 모든 path가 cancelled=true 분기로 silence. dispatch/log 모두 X.
      const resolvers: Array<(v: { blocked: boolean; reason: 'mirror-missing' }) => void> = [];
      mockEvaluateSsotFireGate.mockImplementation(
        () =>
          new Promise((r) => {
            resolvers.push(r);
          }),
      );
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      const { unmount } = renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: directRouteOnLine2,
            destination,
            nearestStation: arc[2],
            currentHopIndex: 2,
            arcStations: arc,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );
      // 모든 fire path가 evaluateSsotFireGate await 지점에 도달하도록 충분히 microtask flush.
      await waitFor(() =>
        expect(mockEvaluateSsotFireGate.mock.calls.length).toBeGreaterThanOrEqual(1),
      );
      for (let i = 0; i < 12; i++) await Promise.resolve();
      unmount();
      // resolve 후 cancelled guard로 dispatch 진입 안 함.
      resolvers.forEach((r) => r({ blocked: false, reason: 'mirror-missing' }));
      for (let i = 0; i < 12; i++) await Promise.resolve();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
    });
  });

  // V/X acceptance 임계 직접 검증 (feedback_v_x_acceptance_full_table)
  // NOTE: mockEvaluateSsotFireGate는 jest.clearAllMocks() 후 구현이 초기화되므로
  //       각 describe에서 명시적으로 no-block 응답으로 재설정한다.
  describe('V4 — N개 역 통과 → station-passed 정확히 N회 (count == 통과 역 수)', () => {
    beforeEach(() => {
      mockEvaluateSsotFireGate.mockResolvedValue({ blocked: false, reason: 'mirror-missing' as const });
    });

    // #2064 (Phase 1-device) — 로컬 알림(sendStationPassedNotification) 제거로 순차 통과 카운트
    // 검증은 dedup bookkeeping(setLastNotifiedStationId) 호출 횟수로 대체한다. N개 역 순차 감지가
    // 정확히 N회 bookkeeping을 수행하고(누락 없음) 초과 호출이 없음(spam 없음)을 그대로 보존한다.
    it('3개 역 순차 통과 → setLastNotifiedStationId 정확히 3회 (알림은 항상 미발사)', async () => {
      const route = makeDirectRoute(3, '2');
      const nextTarget = {
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      };
      const stations = [
        makeStation('S1', '역삼'),
        makeStation('S2', '선릉'),
        makeStation('S3', '삼성'),
      ];
      mockResolveNextTarget.mockReturnValue(nextTarget);

      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: stations[0] } },
      );
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1));

      rerender({ s: stations[1] });
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(2));

      rerender({ s: stations[2] });
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(3));

      // 정확히 3회 — 초과 없음 (X4 spam 보조 검증). 로컬 알림은 한 번도 발사되지 않는다.
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(3);
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  describe('X4 — 같은 역 re-render 시 station-passed 중복 발사 없음 (lastNotifiedStationId dedup)', () => {
    beforeEach(() => {
      mockEvaluateSsotFireGate.mockResolvedValue({ blocked: false, reason: 'mirror-missing' as const });
    });

    it('lastNotifiedStationId가 이미 현재 역 ID면 station-passed 추가 발사 없음', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      const nextTarget = {
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      };
      mockResolveNextTarget.mockReturnValue(nextTarget);
      // storage에 이미 S1이 통지된 것으로 설정 — 즉시 dedup 적용.
      mockGetLastNotifiedStationId.mockResolvedValue('S1');

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );
      await waitFor(() => expect(mockGetLastNotifiedStationId).toHaveBeenCalled());
      // dedup 적용 → 발사 없음.
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  describe('#1817 — estimatorIsTimeIntegration gate (destination/transfer early false fire 차단)', () => {
    it('estimatorIsTimeIntegration=true → evaluateAlarmPhase 미호출 + gate 로그 기록 (phase ETA effect 차단)', async () => {
      // Day 1 evidence: 13:49:38 fu=마장 gp=왕십리 mismatch → 마장 destination early false fire (1m 36s).
      // lockless-route-hop 시간 적분으로 fusion=마장이 됐지만 GPS=왕십리인 상황.
      // hydration 완료 후 estimatorIsTimeIntegration 게이트가 phase ETA effect를 차단한다.
      const route = makeDirectRoute(3, '2');
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
            estimatorIsTimeIntegration: true,
          }),
        ),
      );
      // hydration 완료 후 gate 로그 확인 — 게이트 차단 시 evaluateAlarmPhase 미호출.
      await waitFor(() =>
        expect(mockLogSuppressedPhaseGate).toHaveBeenCalledWith(
          'gate-phase-time-integration',
          expect.any(String),
        ),
      );
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('estimatorIsTimeIntegration=false → evaluateAlarmPhase 정상 호출 (실관측 advance)', async () => {
      // 시간 적분 비활성 — 실관측(boarding-lock / backend-ssot 등) advance 시 phase fire 허용.
      const route = makeDirectRoute(3, '2');
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
            estimatorIsTimeIntegration: false,
          }),
        ),
      );
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
    });

    it('estimatorIsTimeIntegration 미전달(기본=false) → evaluateAlarmPhase 정상 호출 (기존 동작 유지)', async () => {
      // 기존 caller에 prop 미전달 시 기존 동작 보존 — graceful fallback.
      const route = makeDirectRoute(3, '2');
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 100,
          }),
        ),
      );
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
    });

    it('estimatorIsTimeIntegration=true → station-passed(GPS path)는 차단되지 않음 (phase 게이트만 적용)', async () => {
      // phase ETA 게이트는 station-passed effect에 영향 없음. 독립적 차단.
      const route = makeDirectRoute(1, '2');
      const onRouteStation = makeStation('S2-DST', '강남');
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 100,
            estimatorIsTimeIntegration: true,
          }),
        ),
      );
      // station-passed는 별도 effect — 시간 적분 게이트 영향 없이 발화.
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      // phase alarm은 차단.
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });
  });

  // #1816 (paradigm shift Phase 1 보강) — lockless trip + 사용자 명시 의향 없음 시 FG device fire path 차단.
  // Acceptance:
  //   1. lockless + 사용자 명시 의향 X → station-passed / transfer / destination fire = 0건
  //   2. lock 활성 trip → 기존 fire 흐름 유지 (backward compat)
  describe('#1816 lockless-no-user-intent 가드 (paradigm shift Phase 1 보강)', () => {
    const onRouteStation = makeStation('S-PASS', '한양대', 37.5, 127.0);
    const routeDirect = makeDirectRoute(3, '2');

    it('lockless + 사용자 명시 의향 X → station-passed FG GPS path fire X (logSuppressedLocklessNoUserIntent)', async () => {
      // Day 1 trip evidence: 13:46:32 fg fired station-passed 한양대 (lock=null, boardingPrompt=0).
      mockGetBoardingLock.mockResolvedValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '왕십리',
        stopsToNextStation: 1,
        isTransfer: false,
        stopsToDestination: 3,
      });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 50,
            speedMps: 10,
          }),
        ),
      );

      await waitFor(() =>
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: onRouteStation.name,
            kind: 'station-passed',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('lockless + 사용자 명시 의향 X → transfer phase ETA fire X (logSuppressedLocklessNoUserIntent)', async () => {
      // Day 1 trip evidence: 13:46:37 fg fired transfer early 왕십리 (lock=null, boardingPrompt=0).
      // earlyTransfer mock은 stationName='시청'으로 고정 — evaluateAlarmPhase mock이 반환하는 값.
      mockGetBoardingLock.mockResolvedValue(null);
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer); // earlyTransfer.stationName = '시청'

      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '5',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.5, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() =>
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg-evaluated',
            stationName: '시청',
            kind: 'transfer',
          }),
        ),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('lockless + 사용자 명시 의향 X → destination phase ETA fire X (logSuppressedLocklessNoUserIntent)', async () => {
      // Day 1 trip evidence: 13:49:38 fg fired destination early 마장 (lock=null, boardingPrompt=0).
      mockGetBoardingLock.mockResolvedValue(null);
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            userLocation: { lat: 37.498, lng: 127.028 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() =>
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg-evaluated',
            stationName: destination.name,
            kind: 'destination',
          }),
        ),
      );
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('lock 활성 trip → station-passed FG GPS path 정상 발사 (backward compat)', async () => {
      // lock !== null = 사용자 명시 의향(BoardingTrainList 탭 / boardingPrompt 응답).
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-ACTIVE',
        boardingStationId: 'S-BOARD',
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 60_000,
      });
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockResolveNextTarget.mockReturnValue({
        nextStationName: '강남',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            nearestStation: onRouteStation,
            accuracyMeters: 50,
            speedMps: 10,
          }),
        ),
      );

      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedLocklessNoUserIntent).not.toHaveBeenCalled();
    });

    it('lock 활성 trip → destination phase ETA 정상 발사 (backward compat)', async () => {
      mockGetBoardingLock.mockResolvedValue({
        destinationId: destination.id,
        trainCode: 'T-ACTIVE',
        boardingStationId: 'S-BOARD',
        boardingLine: '2' as const,
        boardedAt: Date.now(),
        expectedDurationMs: 60_000,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            userLocation: { lat: 37.498, lng: 127.028 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      expect(mockLogSuppressedLocklessNoUserIntent).not.toHaveBeenCalled();
    });

    it('lockless + 사용자 명시 의향 X → subsurface station-passed fire X (subsurface path guard)', async () => {
      // subsurface verdict path: subsurfaceStationDetected=true 시 lock=null 차단.
      mockGetBoardingLock.mockResolvedValue(null);
      const subsurfaceStation = makeStation('S-SUB', '지하역', 37.5, 127.0);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route: routeDirect,
            destination,
            nearestStation: subsurfaceStation,
            subsurfaceStationDetected: true,
          }),
        ),
      );

      await waitFor(() =>
        expect(mockLogSuppressedLocklessNoUserIntent).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: subsurfaceStation.name,
            kind: 'station-passed',
          }),
        ),
      );
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1984 (Phase 1-4, ADR-022 B3) — flag ON 시 unified fire ledger가 Phase ETA +
  // API imminent 두 useEffect의 동일 (station+line+kind+phase) 재발사를 sync entry-guard로 차단.
  // 회귀 evidence: 2026-07-01 08:32:09 성수 fg fired station-passed 2건 (#1980 코멘트 케이스 1).
  // #2002 — 임시 setter 대신 `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` env 로 flag 게이트.
  describe('#1984 isSimpleArchEnabled unified fire path', () => {
    const route = makeDirectRoute(3, '2');
    const station = makeStation('S1', '시청');

    it('flag OFF (기본): Phase ETA fire 정상 — fireAlarmOnce dedup 미적용 (backward-compat)', async () => {
      delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
      mockEvaluateAlarmPhase.mockReturnValue(imminentDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
      // fire ledger 미개입 확인 — logSuppressedFireAlarmOnce 미호출.
      expect(mockLogSuppressedFireAlarmOnce).not.toHaveBeenCalled();
    });

    it('flag ON: 첫 fire 정상 발사 + logFiredAlarm', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      mockEvaluateAlarmPhase.mockReturnValue(imminentDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      await waitFor(() =>
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ phaseId: 'imminent', stationName: '강남', type: 'destination' }),
          'eta',
        ),
      );
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
      expect(mockLogSuppressedFireAlarmOnce).not.toHaveBeenCalled();
    });

    it('flag ON: ledger에 이미 stamp된 (station+line+kind+phase) 조합의 Phase ETA fire는 차단', async () => {
      // 같은 초 race 시나리오 재현: ledger가 다른 fire path(예: 앞서 실행된 다른 useEffect 또는
      // 채널)로 이미 stamp된 상태에서 Phase ETA useEffect가 같은 조합으로 dispatch 시도 → 차단.
      // 사용자 evidence(2026-07-01 08:32:09 성수 fg fired 2건)의 두 번째 fire 차단 검증.
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      // ledger에 imminent destination 강남 (line=2) fire를 사전 stamp — 다른 채널이 먼저 발사한 상황.
      await fireAlarmOnce(
        {
          stationName: '강남',
          line: '2',
          kind: 'destination',
          phase: 'imminent',
        },
        () => Promise.resolve(),
      );

      // Phase ETA useEffect가 같은 조합의 imminentDest를 evaluate → fireViaUnifiedGate → ledger dedup.
      mockEvaluateAlarmPhase.mockReturnValue(imminentDest);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: station,
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      // 두 번째 fire는 ledger dedup → logSuppressedFireAlarmOnce 적재.
      await waitFor(() =>
        expect(mockLogSuppressedFireAlarmOnce).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
          }),
        ),
      );
      // 사용자에게 노출된 알람 0건 — ledger가 fire callback 실행 자체를 차단.
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      // logFiredAlarm도 미호출 (fireAndLog 진입 X).
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('flag ON: 다른 phase(early → imminent) 진행은 정상 통과 (정상 phase 진행 보존)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      const { rerender } = renderHook(
        ({ input }: { input: UseStationAlarmInputs }) => useStationAlarm(input),
        {
          initialProps: {
            input: defaultInputs({
              route,
              destination,
              userLocation: { lat: 37.4, lng: 127.0 },
              speedMps: 10,
              accuracyMeters: 50,
            }),
          },
        },
      );

      // 첫 fire: early destination.
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      rerender({
        input: defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.401, lng: 127.0 },
          speedMps: 10,
          accuracyMeters: 50,
        }),
      });
      await waitFor(() =>
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ phaseId: 'early' }),
          'eta',
        ),
      );

      // 두 번째 fire: imminent destination — phase 다르므로 unified ledger 통과.
      mockEvaluateAlarmPhase.mockReturnValue(imminentDest);
      rerender({
        input: defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.402, lng: 127.0 },
          speedMps: 10,
          accuracyMeters: 50,
        }),
      });
      await waitFor(() =>
        expect(mockLogFiredAlarm).toHaveBeenCalledWith(
          'fg',
          expect.objectContaining({ phaseId: 'imminent' }),
          'eta',
        ),
      );
      // 정상 progression — dedup 로그 없어야 함.
      expect(mockLogSuppressedFireAlarmOnce).not.toHaveBeenCalled();
    });

    it('flag ON: rawEvent에 line=null 상황도 방어적 stringify로 정상 dedup', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      // nearestStation 미제공 + lock.boardingLine 미설정 → resolveCurrentLine = null.
      mockGetBoardingLock.mockResolvedValue({
        destinationId: 'D1',
        trainCode: 'T-DEFAULT',
        boardingStationId: 'S-DEFAULT',
        boardingLine: null as unknown as '2',
        boardedAt: 0,
        expectedDurationMs: 60_000,
      });
      mockEvaluateAlarmPhase.mockReturnValue(imminentDest);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            // nearestStation 없음
            userLocation: { lat: 37.4, lng: 127.0 },
            speedMps: 10,
            accuracyMeters: 50,
          }),
        ),
      );

      // line=null이어도 fire 정상 진행 — 방어적 stringify로 dedup key 산출.
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1));
    });
  });

  // ADR-022 Phase 4-3 (#2005) — motion gate dormant 통합 검증.
  // flag OFF (기본) 시 motion=stationary 로 발사 차단 (#728) — 기존 동작 유지.
  // flag ON 시 evaluateMovement 가 항상 reliable=true 를 반환해 motion gate 를 전면 bypass.
  // 정적 상태(motion=stationary, speed=0)에서도 알람이 정상 발사되어야 한다 — arrival API SSoT.
  describe('#2005 Phase 4-3 motionGate dormant flag', () => {
    const route = makeDirectRoute(1, '2');
    const onRouteStation = makeStation('S2-DST', '강남');

    it('flag OFF (기본) + motionStationary=true → 기존 동작 (motion gate 차단 + movement-motion-stationary 적재)', async () => {
      delete process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY];
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0,
            accuracyMeters: 50,
            motionStationary: true,
          }),
        ),
      );

      await waitFor(() => {
        expect(mockLogSuppressedMovement).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'movement-motion-stationary',
          }),
        );
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('flag ON + motionStationary=true → motion gate bypass → 정상 발사 (arrival API SSoT)', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0, // 정적
            accuracyMeters: 50,
            motionStationary: true, // OS 가속도계 정적 확정
          }),
        ),
      );

      // motion=stationary인데도 알람 발사 — arrival API SSoT 아키텍처는 arvlCd 단독 신호로 판정.
      await waitFor(() => expect(mockLogFiredAlarm).toHaveBeenCalled());
      // movement 게이트 skip 로그 미적재 (dormant).
      expect(mockLogSuppressedMovement).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'movement-motion-stationary' }),
      );
    });

    it('flag ON + speed=0 + station-passed → motion gate bypass → 정상 발사', async () => {
      process.env[SIMPLE_ARRIVAL_ARCH_ENV_KEY] = 'true';
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      renderHook(() =>
        useStationAlarm(
          defaultInputs({
            route,
            destination,
            nearestStation: onRouteStation,
            speedMps: 0, // 정적
            accuracyMeters: 50,
          }),
        ),
      );

      // speed=0인데도 station-passed 알람 발사 — flag ON 이면 movement gate 미적용.
      // #2064 — 로컬 알림 제거. dedup bookkeeping(setLastNotifiedStationId)으로 성공을 검증.
      await waitFor(() => expect(mockSetLastNotifiedStationId).toHaveBeenCalled());
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedMovement).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'movement-static-speed' }),
      );
    });
  });
});
