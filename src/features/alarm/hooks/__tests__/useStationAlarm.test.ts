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
const mockLogRefMismatch = jest.fn();
const mockLogSuppressedDedupAlarm = jest.fn();
const mockLogSuppressedDedupStation = jest.fn();
const mockLogSuppressedMovement = jest.fn();
const mockLogSuppressedSleepFirstTransfer = jest.fn();
const mockLogSuppressedDismissSilence = jest.fn();
const mockLogSuppressedStationPassedWarmup = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logFiredAlarm: (...args: unknown[]) => mockLogFiredAlarm(...args),
  logFiredAlarmsHydrate: (...args: unknown[]) => mockLogFiredAlarmsHydrate(...args),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logRefMismatch: (...args: unknown[]) => mockLogRefMismatch(...args),
  logSuppressedDedupAlarm: (...args: unknown[]) => mockLogSuppressedDedupAlarm(...args),
  logSuppressedDedupStation: (...args: unknown[]) => mockLogSuppressedDedupStation(...args),
  logSuppressedMovement: (...args: unknown[]) => mockLogSuppressedMovement(...args),
  logSuppressedSleepFirstTransfer: (...args: unknown[]) =>
    mockLogSuppressedSleepFirstTransfer(...args),
  logSuppressedDismissSilence: (...args: unknown[]) => mockLogSuppressedDismissSilence(...args),
  logSuppressedStationPassedWarmup: (...args: unknown[]) =>
    mockLogSuppressedStationPassedWarmup(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
}));

jest.mock('../../utils/scheduledAlarmReceiver', () => ({
  awaitInitialScheduledAlarmDrain: jest.fn().mockResolvedValue(undefined),
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

    // Sonar cpd 통합 — sleep OFF/lock 활성 vs sleep ON/lock null 모두 게이트 비활성 → 정상 발사.
    it.each([
      { name: 'sleep OFF + 첫 hop transfer → 정상 발사', sleepMode: false, lockValue: lock },
      { name: 'sleep ON + lock null → 게이트 비활성, 정상 발사', sleepMode: true, lockValue: null },
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

  describe('#670/#672 첫 evaluation suppress 가드', () => {
    const route = makeDirectRoute(3, '2');
    // skipWarmupGuard 미전달 → production default(false) 적용. 첫 evaluation 보류 동작 확인.
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

    it('다음 deps 변경(좌표 갱신) 후 evaluate 호출됨', async () => {
      const { rerender } = renderHook(
        ({ loc }: { loc: { lat: number; lng: number } }) =>
          useStationAlarm(inputsWithGuardDefault(loc)),
        { initialProps: { loc: { lat: 37.4, lng: 127.0 } } },
      );
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
      // 첫 suppress 이후 좌표가 한 번 더 갱신되면 evaluate 진입.
      rerender({ loc: { lat: 37.41, lng: 127.01 } });
      await waitFor(() => expect(mockEvaluateAlarmPhase).toHaveBeenCalled());
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

    it('lock 활성 + arvlCd 신호 → station-passed 알림 발사 + lastNotifiedStationId 갱신 + fg-arvlcd source 적재', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      renderHook(() => useStationAlarm(fastPathInputs()));

      await waitFor(() =>
        expect(mockLogFiredStationPassed).toHaveBeenCalledWith('fg-arvlcd', onRouteStation),
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

    it('currentStationArrival 미전달(undefined)이면 fast path no-op (getBoardingLock 미호출)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(fastPathInputs({ currentStationArrival: undefined })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      // mockEvaluateAlarmPhase=null & isImminentByArrivalCode=false → fireAndLog 미호출 →
      // 본 hook에서 getBoardingLock 호출자는 fast path뿐. fast path가 early return하면 호출 0.
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('currentStationArrival null이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);
      mockGetLastNotifiedStationId.mockResolvedValue(onRouteStation.id);

      renderHook(() => useStationAlarm(fastPathInputs({ currentStationArrival: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('nearestStation null이면 fast path no-op (fire 대상 station 결정 불가)', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('nearestStation이 route 밖이면(line 불일치) fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ nearestStation: offRouteStation })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('route 또는 destination 미설정이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ route: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
    });

    it('destination 미설정이면 fast path no-op', async () => {
      mockGetBoardingLock.mockResolvedValue(activeLock);

      renderHook(() => useStationAlarm(fastPathInputs({ destination: null })));

      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      await Promise.resolve();
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
      expect(mockGetBoardingLock).not.toHaveBeenCalled();
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
      // getBoardingLock을 지연 resolve로 cleanup 시점을 끼워 넣음.
      let resolveLock: (v: typeof activeLock) => void = () => {};
      mockGetBoardingLock.mockReturnValueOnce(
        new Promise<typeof activeLock>((r) => {
          resolveLock = r;
        }),
      );
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockFindFgArvlCdFireSignal.mockReturnValue({ trainCode: 'T-LOCK', arvlCd: 0 });

      const { unmount } = renderHook(() => useStationAlarm(fastPathInputs()));
      await waitFor(() => expect(mockGetFiredAlarms).toHaveBeenCalled());
      unmount();
      resolveLock(activeLock);
      await Promise.resolve();
      await Promise.resolve();

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
});
