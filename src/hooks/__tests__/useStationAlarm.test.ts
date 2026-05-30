import { renderHook, waitFor } from '@testing-library/react-native';
import { useStationAlarm, type UseStationAlarmInputs } from '../useStationAlarm';
import { useAppStore } from '../../store/useAppStore';
import type { Station } from '../../types/station';
import type { AlarmEvent } from '../../utils/stationAlarm';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

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

jest.mock('../../utils/logger', () => ({
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
const mockLogSuppressedDedupAlarm = jest.fn();
const mockLogSuppressedDedupStation = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logFiredAlarm: (...args: unknown[]) => mockLogFiredAlarm(...args),
  logFiredAlarmsHydrate: (...args: unknown[]) => mockLogFiredAlarmsHydrate(...args),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logSuppressedDedupAlarm: (...args: unknown[]) => mockLogSuppressedDedupAlarm(...args),
  logSuppressedDedupStation: (...args: unknown[]) => mockLogSuppressedDedupStation(...args),
}));

jest.mock('../../utils/scheduledAlarmReceiver', () => ({
  awaitInitialScheduledAlarmDrain: jest.fn().mockResolvedValue(undefined),
}));

const mockIsImminentByArrivalCode = jest.fn();
jest.mock('../../utils/imminentArrivalSignal', () => ({
  isImminentByArrivalCode: (...args: unknown[]) => mockIsImminentByArrivalCode(...args),
}));

const mockGetStoredTripTrainCode = jest.fn();
jest.mock('../../utils/tripTrainCode', () => ({
  getStoredTripTrainCode: (...args: unknown[]) => mockGetStoredTripTrainCode(...args),
}));

const mockUseArrivalInfo = jest.fn();
jest.mock('../useArrivalInfo', () => ({
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
    useAppStore.setState({ sleepMode: false, allowSpeaker: true, alarmEvent: null });
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
    useAppStore.setState({ sleepMode: true });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() =>
      expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, true, true, undefined),
    );
  });

  it('sets alarmEvent in store when sleepMode is on', async () => {
    useAppStore.setState({ sleepMode: true });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(useAppStore.getState().alarmEvent).toEqual(earlyDest));
  });

  it('does not set alarmEvent when sleepMode is off', async () => {
    useAppStore.setState({ sleepMode: false });
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    await waitFor(() => expect(mockSendAlarmNotification).toHaveBeenCalled());
    expect(useAppStore.getState().alarmEvent).toBeNull();
  });

  it('passes allowSpeaker=false from store', async () => {
    useAppStore.setState({ allowSpeaker: false });
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

    useAppStore.setState({ sleepMode: true });
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('handles sendAlarmNotification rejection gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route = makeDirectRoute(1, '2');
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    expect(() => renderHook(() => useStationAlarm(defaultInputs({ route, destination })))).not.toThrow();
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
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith('S1');
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
        useStationAlarm(defaultInputs({ route, destination, nearestStation: station })),
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
      useAppStore.setState({ sleepMode: true });
      mockGetStoredTripTrainCode.mockResolvedValue('TRAIN-1');
      mockIsImminentByArrivalCode.mockReturnValue(true);
      const setAlarmEventSpy = jest.spyOn(useAppStore.getState(), 'setAlarmEvent');

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
});
