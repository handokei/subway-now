/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useStationAlarm은 본질적 orchestrator(본체에도 file-level disable 있음).
 * settings store(sleepMode/allowSpeaker)에 의존하는 분기를 검증하려면 같은 import 필요.
 * ADR Phase 5 (#890) orchestration 컨벤션.
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useStationAlarm, type UseStationAlarmInputs } from '../useStationAlarm';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useAlarmEventStore } from '../../store/useAlarmEventStore';
import type { Station } from '../../../../shared/types/station';
import type { AlarmEvent } from '../../utils/stationAlarm';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

const mockSendAlarmNotification = jest.fn().mockResolvedValue(undefined);
const mockSendStationPassedNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
}));

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
const mockLogSuppressedSsotFireGate = jest.fn();
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
  logSuppressedSsotFireGate: (...args: unknown[]) =>
    mockLogSuppressedSsotFireGate(...args),
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
    useSettingsStore.setState({ sleepMode: false, allowSpeaker: true });
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    mockEvaluateAlarmPhase.mockReturnValue(null);
    mockResolveAlarmDirection.mockReturnValue(undefined);
    mockResolveNextTarget.mockReturnValue(null);
    mockGetLastNotifiedStationId.mockResolvedValue(null);
    mockSetLastNotifiedStationId.mockResolvedValue(undefined);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockIsImminentByArrivalCode.mockReturnValue(false);
    mockGetStoredTripTrainCode.mockResolvedValue(null);
    mockUseArrivalInfo.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockGetBoardingLock.mockResolvedValue(null);
    mockFindFgArvlCdFireSignal.mockReturnValue(null);
    mockAwaitInitialScheduledAlarmDrain.mockResolvedValue(undefined);
    // #1515 — cross-category dedup 모듈 in-memory 상태 리셋. mock하지 않은 실모듈 사용.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
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

    it('GPS 게이트 차단 + arrivalConfidence=arrival-confirmed → station-passed 알람 발화', async () => {
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
      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
      // Phase 알람은 GPS 필요하므로 호출 안 됨
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it('GPS 게이트 차단 + arrivalConfidence=boarding-lock → station-passed 알람 발화 (#584 PR D2)', async () => {
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
      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, true, undefined),
    );
  });

  it('attaches direction to the alarm event when nearestStation is set and direction resolves', async () => {
    const route = makeDirectRoute(1, '2');
    const station = makeStation('S1', '역삼');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    mockResolveAlarmDirection.mockReturnValue('up');
    renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
    await waitFor(() =>
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(
        { ...earlyDest, direction: 'up' },
        false,
        true,
        undefined,
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
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyTransfer, false, true, undefined),
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
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyTransfer, false, true, undefined),
    );
  });

  it('does not fire the same alarm twice', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
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
      expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(earlyDest, false, true, undefined),
    );

    mockEvaluateAlarmPhase.mockReturnValueOnce(imminentDest);
    rerender({
      inputs: defaultInputs({ route, destination, userLocation: { lat: 37.49, lng: 127.025 }, speedMps: 20 }),
    });
    await waitFor(() =>
      expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(imminentDest, false, true, undefined),
    );
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2);
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
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('destination 변경 시 새 destinationId로 re-hydrate 한다 (#462 destination scoped)', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(
      ({ dest }: { dest: Station }) => useStationAlarm(defaultInputs({ route, destination: dest })),
      { initialProps: { dest: destination } },
    );
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
    expect(mockGetFiredAlarms).toHaveBeenCalledWith(destination.id);

    const altEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '잠실' };
    mockEvaluateAlarmPhase.mockReturnValue(altEvent);
    rerender({ dest: altDestination });
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2));
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(altEvent, false, true, undefined);
    // destination 변경 → 새 id로 storage 재읽기 (저장된 entry는 옛 destinationId라 빈 set 반환 → 자동 isolation).
    expect(mockGetFiredAlarms).toHaveBeenCalledWith(altDestination.id);
  });

  it('passes sleepMode to sendAlarmNotification', async () => {
    useSettingsStore.setState({ sleepMode: true });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, true, true, undefined),
    );
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
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('passes allowSpeaker=false from store', async () => {
    useSettingsStore.setState({ allowSpeaker: false });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, false, undefined),
    );
  });

  it('does not re-fire when sleepMode toggles after first fire', async () => {
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));

    useSettingsStore.setState({ sleepMode: true });
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('handles sendAlarmNotification rejection gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    expect(() => renderHook(() => useStationAlarm(defaultInputs({ route, destination })))).not.toThrow();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    // Sonar cpd 통합 — sleep OFF는 lock 유무와 무관하게 게이트 비활성 → 정상 발사.
    // #1214 (Epic #1204 D8): lock=null 조기 종료가 제거됐으므로 "sleep ON + lock null" 케이스는
    // 별도 신규 케이스(아래)에서 suppress=true 로 검증.
    it.each([
      { name: 'sleep OFF + lock 활성 + 첫 hop transfer → 정상 발사', sleepMode: false, lockValue: lock },
      { name: 'sleep OFF + lock null + 첫 hop transfer → 정상 발사', sleepMode: false, lockValue: null },
    ])('$name', async ({ sleepMode, lockValue }) => {
      useSettingsStore.setState({ sleepMode });
      mockGetBoardingLock.mockResolvedValue(lockValue);
      const route = makeTransferRoute({
        transferName: '시청',
        fromLine: '2',
        toLine: '1',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock null + 첫 hop transfer → suppress (#1214 lockless 적용)', async () => {
      // #1214 (Epic #1204 D8): 사용자 명시 의향 trip(lockless)도 lock 활성과 동급 정확도 보장.
      // getFirstLeg.endName === stationName 이면 lockless에서도 isFirstHop=true → suppress.
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
        expect(mockLogSuppressedSleepFirstTransfer).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'fg',
            stationName: '시청',
            phaseId: 'early',
          }),
        ),
      );
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + destination 카테고리 → 정상 발사 (transfer 외 영향 없음)', async () => {
      useSettingsStore.setState({ sleepMode: true });
      mockGetBoardingLock.mockResolvedValue(lock);
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

    it('fires when nearest station changes (notificationState dedup)', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));

      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', directTarget, undefined);
      });
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, 'S1');
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

    it('fires again when nearest station changes to a different one', async () => {
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
        expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
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
        expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(2);
      });
      expect(mockSendStationPassedNotification).toHaveBeenLastCalledWith('선릉', '강남', nextTarget, undefined);
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

    it('passes null target when resolveNextTarget returns null', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(null);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', null, undefined);
      });
    });

    it('handles sendStationPassedNotification rejection gracefully', async () => {
      mockSendStationPassedNotification.mockRejectedValueOnce(new Error('알림 실패'));
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      expect(() =>
        renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station }))),
      ).not.toThrow();
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
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
        expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
      });
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('서울', '강남', transferTarget, undefined);
    });

    it('알림 발송 후에만 notificationState에 저장한다 (실패 시 재시도 가능)', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);
      mockSendStationPassedNotification.mockRejectedValueOnce(new Error('알림 발송 실패'));

      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));

      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
      // 알림 발송 실패 시 storage write를 하지 않아 다음 폴링에서 재시도 가능
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });

    it('알림 발송이 성공하면 그 후에 notificationState에 저장한다', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);

      const callOrder: string[] = [];
      mockSendStationPassedNotification.mockImplementationOnce(async () => {
        callOrder.push('notify');
      });
      mockSetLastNotifiedStationId.mockImplementationOnce(async () => {
        callOrder.push('write');
      });

      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));

      await waitFor(() => {
        expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      });
      expect(callOrder).toEqual(['notify', 'write']);
    });

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
        expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
      });
      // 처음 두 IIFE는 cancelled 가드에 막혀 마지막(A) 한 번만 알림 발사
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('강남A', '강남', directTarget, undefined);
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

    it('cancel 플래그: notify 완료 전 언마운트되면 storage write를 하지 않는다', async () => {
      const route = makeDirectRoute(3, '2');
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(directTarget);

      const notify = deferred<void>();
      mockSendStationPassedNotification.mockReturnValueOnce(notify.promise);

      const { unmount } = renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      // notify가 시작될 때까지 기다림
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });

      unmount();
      notify.resolve();

      await Promise.resolve();
      await Promise.resolve();

      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    });
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
    });

    it('FG에서 phase 발화 시 setFiredAlarms(destinationId, set)로 동기화한다 (#462)', async () => {
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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

    it('역 통과 알림 발사 시 logFiredStationPassed(fg, station)을 호출한다', async () => {
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
        expect(mockLogFiredStationPassed).toHaveBeenCalledWith('fg', station);
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
      expect(mockSendAlarmNotification).toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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

      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
        expect(mockSendAlarmNotification).toHaveBeenCalledWith(
          expect.objectContaining({ direction: 'up' }),
          expect.anything(),
          expect.anything(),
          undefined,
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
        expect(mockSendAlarmNotification).toHaveBeenCalled();
      });
      // nearestStation null이면 direction 분기를 거치지 않음
      const apiSendCall = mockSendAlarmNotification.mock.calls[0];
      expect(apiSendCall[0]).not.toHaveProperty('direction');
    });

    it('sendAlarmNotification rejection은 logger.error로 swallowed (회귀 가드)', async () => {
      mockSendAlarmNotification.mockRejectedValueOnce(new Error('boom'));
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);

      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
      );

      await waitFor(() => {
        expect(mockSendAlarmNotification).toHaveBeenCalled();
      });
      // rejection이 swallow돼 후속 로깅이 정상 호출되는지 확인
      await waitFor(() => {
        const apiCalls = mockLogFiredAlarm.mock.calls.filter((c) => c[2] === 'api');
        expect(apiCalls.length).toBeGreaterThan(0);
      });
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

  describe('fusionSource 라벨 전파 (#327)', () => {
    it('fusionSource=gps 전달 시 sendAlarmNotification에 gpsOnly가 4번째 인자로 전달된다', async () => {
      const route = makeDirectRoute(5, '2');
      const destination = makeStation('D1', '강남');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() =>
        useStationAlarm(defaultInputs({ route, destination, fusionSource: 'gps' })),
      );
      await waitFor(() =>
        expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, true, 'gpsOnly'),
      );
    });

    it('locationUncertain=true 전달 시 source 무시하고 uncertain 전달', async () => {
      const route = makeDirectRoute(5, '2');
      const destination = makeStation('D1', '강남');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderHook(() =>
        useStationAlarm(
          defaultInputs({ route, destination, fusionSource: 'position-train', locationUncertain: true }),
        ),
      );
      await waitFor(() =>
        expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, true, 'uncertain'),
      );
    });

    it('역 통과 알림에도 notificationSource가 전달된다', async () => {
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
        expect(mockSendStationPassedNotification).toHaveBeenCalledWith(
          '역삼',
          '강남',
          directTarget,
          'routeProgress',
        ),
      );
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
      expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
    });

    it('setFiredAlarms가 reject되어도 notification은 발사된다 (영속화 실패 graceful)', async () => {
      mockSetFiredAlarms.mockRejectedValueOnce(new Error('storage 실패'));
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
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

  // #670/#672/#1316 — phase 알람 warmup 가드. 하이드레이션 완료 후 HYDRATE_WARMUP_MS(30s) 시간 window
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

    it('warmup window 경과 후 좌표 갱신 시 evaluate 호출됨 (hydratedAt + 30s 이후)', async () => {
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
      nowSpy.mockReturnValue(baseTs + 30_001);
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
    });

    it('조기 발사로 오염되지 않아 window 경과 후 실제 도착에서 destination 정상 발사', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      mockGetBoardingLock.mockResolvedValue(null);
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();

      // 실제 도착 시점: window 경과 + 좌표 갱신. firedAlarms가 비어 있으므로 dedup 없이 발사돼야 한다.
      nowSpy.mockReturnValue(baseTs + 30_001);
      rerender({ loc: { lat: 37.498, lng: 127.028 } });

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
    });

    it('Phase rawEvent 있음 + speed>=0.5(이동)이면 정상 발사 (positionStability=static 무시)', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderPhaseHook({ speedMps: 5, positionStability: 'static' });

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

    it('station-passed + 정적 신호 + arrivalConfirmed면 movement gate skip → 정상 발사', async () => {
      renderStationPassedHook({ speedMps: 0, arrivalConfidence: 'arrival-confirmed' });

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
    });

    it('station-passed + 이동 신호(speed=5)면 정상 발사', async () => {
      renderStationPassedHook({ speedMps: 5 });

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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

    it('motionStationary=false면 차단 안 함 (이동 신호 정상)', async () => {
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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
    });

    it('motionStationary 미전달 — 기존 동작 유지 (graceful fallback)', async () => {
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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
    });

    it('station-passed + motionStationary=true + arrivalConfirmed면 motion gate skip → 정상 발사', async () => {
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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
    });

    it('station-passed + motionStationary=true + trainProgressing=true → 정상 발사', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      renderTrainProgressingAlarm({
        speedMps: 0.69,
        accuracyMeters: 50,
        motionStationary: true,
        trainProgressing: true,
      });

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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

    it('skipWarmupGuard=true면 warmup window 안에서도 즉시 발사', async () => {
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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
    });

    it('warmup window 경과 후 발사 허용 (hydratedAt + 30s 이후)', async () => {
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
      nowSpy.mockReturnValue(baseTs + 30_001);
      rerender({ s: station });

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
    });
  });

  // #754 — fireAndLog dedup race: await getBoardingLock() 동안 effect가 재실행돼
  // 같은 rawEvent로 in-flight fireAndLog가 다수 누적되어도 사용자에게는 1회만 노출.
  describe('#754 fireAndLog dedup race', () => {
    it('진입 시 firedAlarmsRef에 키가 이미 있으면 즉시 return (in-flight entry dedup)', async () => {
      // race 시뮬레이션: evaluateAlarmPhase mock이 firedAlarms를 honor 안 함으로써 같은
      // rawEvent를 매 evaluation마다 반환 (production race에서 in-flight fireAndLog가 add 전에
      // 다음 evaluation이 들어오는 상황과 동치). fireAndLog 진입 가드가 차단해야 한다.
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      mockGetBoardingLock.mockResolvedValue(null);
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
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // mock이 firedAlarms를 무시하므로 evaluateAlarmPhase는 다시 같은 rawEvent 반환 → fireAndLog 호출.
      // 진입 가드(has(key)=true)가 catch하지 않으면 88회 burst 회귀 — 추가 발사 없어야 한다.
      rerender({ lat: 37.50001 });
      rerender({ lat: 37.50002 });
      rerender({ lat: 37.50003 });

      // microtask + effect 사이클 flush. setTimeout(0)으로 macrotask queue까지 비운다.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();

      // sleep OFF 토글 → firedAlarms.delete가 sync 적용됐다면 다음 evaluation은 정상 발사.
      // delete가 빠지면 같은 키가 firedAlarms에 남아 진입 가드가 영구 봉쇄 → 회귀.
      useSettingsStore.setState({ sleepMode: false });
      rerender({ lat: 37.50001 });

      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
      expect(setStateSpy).toHaveBeenCalled();
      setStateSpy.mockRestore();
    });

    it('API imminent path: silence 만료(시간) 시 clear 호출 + 정상 발사', async () => {
      const clearSpy = jest.spyOn(useAlarmEventStore.getState(), 'clearDismissSilence');
      seedExpiredSilence();
      setupApiImminent();
      renderForSilence();
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
    });

    it('silence state 없음 → 게이트 통과 (정상 발사)', async () => {
      useAlarmEventStore.setState({ dismissSilence: null });
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
      renderForSilence();
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
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

    it('lock 활성 + arvlCd 신호 → station-passed 알림 발사 + lastNotifiedStationId 갱신', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      // #1515 — cross-category station-level dedup으로 GPS path와 fast-path 중 먼저 reservation을
      // 점유한 쪽만 발사된다(같은 station, 같은 destination, 30s 윈도우). 발사 1회 + 호출 인자만 검증.
      await waitFor(() => expect(mockLogFiredStationPassed).toHaveBeenCalled());
      expect(mockLogFiredStationPassed).toHaveBeenCalledTimes(1);
      expect(mockLogFiredStationPassed).toHaveBeenCalledWith(
        expect.stringMatching(/^fg(-arvlcd)?$/),
        onRouteStation,
      );
      expect(mockSendStationPassedNotification).toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, onRouteStation.id);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('#640 회귀 가드 — findFgArvlCdFireSignal이 null 반환(trainCode 불일치/arvlCd 불일치)면 발사 X', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue(null);

      renderHook(() => useStationAlarm(fastPathInputs()));

      await waitFor(() => expect(mockGetBoardingLock).toHaveBeenCalled());
      await Promise.resolve();
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('lastNotifiedStationId가 같은 station.id면 fast path dedup → fg-arvlcd dedup 로그', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      await waitFor(() =>
        expect(mockLogSuppressedDedupStation).toHaveBeenCalledWith('fg-arvlcd', onRouteStation),
      );
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('currentStationArrival null이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(fastPathInputs({ currentStationArrival: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      await Promise.resolve();
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('nearestStation null이면 fast path no-op (fire 대상 station 결정 불가)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      // #1272 (N8) — destinationId 기반 lock mirror effect가 destinationId 설정 시 lock을
      // 1회 prefetch 한다. fast path 발사 자체는 nearestStation null이므로 발생하지 않음.
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('nearestStation이 route 밖이면(line 불일치) fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: offRouteStation })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

    it('route 또는 destination 미설정이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ route: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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

      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
      // dedup 로그도 호출되지 않아야 한다 (cancelled로 early return).
      const arvlCdDedups = mockLogSuppressedDedupStation.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdDedups).toHaveLength(0);
    });

    it('sendStationPassedNotification 후 cleanup 되면 setLastNotifiedStationId 미호출 (cancelled gate line 736)', async () => {
      // send pending 동안 unmount → setLastNotifiedStationId 미호출 + logFiredStationPassed 미호출.
      // GPS effect와 fast path effect 둘 다 send 호출하므로 mockImplementation으로 전체 pending.
      const resolvers: Array<() => void> = [];
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });
      mockSendStationPassedNotification.mockImplementation(
        () =>
          new Promise<void>((r) => {
            resolvers.push(r);
          }),
      );

      const { unmount } = renderHook(() => useStationAlarm(fastPathInputs()));
      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
      unmount();
      // 모든 pending send를 해제 — 각 effect는 cancelled=true를 보고 setLastNotifiedStationId skip.
      resolvers.forEach((r) => r());
      await Promise.resolve();
      await Promise.resolve();

      // setLastNotifiedStationId와 logFiredStationPassed('fg-arvlcd', ...) 모두 미호출.
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
    });

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
      mockLogFiredStationPassed.mockClear();
      rerender({ dest: altDestination });
      await Promise.resolve();
      await Promise.resolve();

      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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

      // #1515 — cross-category dedup으로 GPS path/fast-path 중 먼저 reservation 점유한 쪽만 발사.
      await waitFor(() => expect(mockLogFiredStationPassed).toHaveBeenCalled());
      expect(mockLogFiredStationPassed).toHaveBeenCalledWith(
        expect.stringMatching(/^fg(-arvlcd)?$/),
        arcLine2[3],
      );
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
      // 게이트 미적용이므로 정상 발사. #1515 — GPS path/fast-path 중 reservation을 먼저 잡은 쪽만 fire.
      await waitFor(() => expect(mockLogFiredStationPassed).toHaveBeenCalled());
      expect(mockLogFiredStationPassed).toHaveBeenCalledWith(
        expect.stringMatching(/^fg(-arvlcd)?$/),
        arcLine2[0],
      );
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

      // #1515 — GPS path/fast-path 중 reservation을 먼저 잡은 쪽만 fire.
      await waitFor(() => expect(mockLogFiredStationPassed).toHaveBeenCalled());
      expect(mockLogFiredStationPassed).toHaveBeenCalledWith(
        expect.stringMatching(/^fg(-arvlcd)?$/),
        arcLine2[0],
      );
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
    });

    it("'ready' 도달 후에만 phase 알람 발사 허용", async () => {
      const route = makeDirectRoute(1, '2');
      mockEvaluateAlarmPhase.mockReturnValue(earlyDest);

      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));

      // 'ready' 도달 후 발사.
      await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1));
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
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
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
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
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
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
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
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
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
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
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

    it('lockless + currentHopIndex=0 + candidate arc[0] → suppressed (gate-origin-hop-lockless)', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      renderOriginHopCase(0, 0);
      await waitFor(() => {
        expect(mockLogSuppressedOriginHopLockless).toHaveBeenCalledWith({
          source: 'fg',
          stationName: arcOrigin[0].name,
        });
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogFiredStationPassed).not.toHaveBeenCalledWith('fg', arcOrigin[0]);
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

    it('lockless + currentHopIndex=0 + candidate arc[1] (다음 hop) → 통과 (정상 진행 신호)', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      mockNextTargetStops(3);
      renderOriginHopCase(1, 0);
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
    });

    it('lockless + currentHopIndex=2 + candidate arc[2] (중간 hop origin 아님) → 통과 (기존 동작 보존)', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      mockNextTargetStops(2);
      renderOriginHopCase(2, 2);
      await waitFor(() => {
        expect(mockSendStationPassedNotification).toHaveBeenCalled();
      });
      expect(mockLogSuppressedOriginHopLockless).not.toHaveBeenCalled();
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

    type ExpectGate = 'sleep' | 'lock-origin' | 'none';
    it.each([
      {
        name: 'FG GPS path — lockless + sleep ON + currentHopIndex=0 → station-passed 차단 (사가정 22:11:56 evidence)',
        sleepMode: true,
        lockValue: null,
        currentHopIndex: 0 as number | null,
        expectGate: 'sleep' as ExpectGate,
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
        name: 'FG GPS path — sleep OFF + lockless + currentHopIndex=0 → 정상 발사',
        sleepMode: false,
        lockValue: null,
        currentHopIndex: 0 as number | null,
        expectGate: 'none' as ExpectGate,
      },
      {
        name: 'FG GPS path — sleep ON + lockless + currentHopIndex=3 → 정상 발사 (첫 hop 아님)',
        sleepMode: true,
        lockValue: null,
        currentHopIndex: 3 as number | null,
        expectGate: 'none' as ExpectGate,
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

      if (expectGate === 'sleep') {
        await waitFor(() =>
          expect(mockLogSuppressedSleepStationPassed).toHaveBeenCalledWith({
            source: 'fg',
            stationName: onRouteStation.name,
          }),
        );
        expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
        expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
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
        await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
        const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter(
          (c) => c[0] === 'fg-arvlcd',
        );
        expect(arvlCdFires).toHaveLength(0);
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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());

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

      await waitFor(() => expect(mockSendStationPassedNotification).toHaveBeenCalled());
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
      expect(mockSendAlarmNotification).not.toHaveBeenCalled();
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
      const arvlCdFires = mockLogFiredStationPassed.mock.calls.filter((c) => c[0] === 'fg-arvlcd');
      expect(arvlCdFires).toHaveLength(0);
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
});
