/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useStationAlarm은 본질적 orchestrator. useStationAlarm.test.ts와 동일한
 * opt-in 사유.
 */
// #2940 (plan W3) 후속 — 코디네이터 지적: useStationAlarm.test.ts는 recentLocalStationFires
// 모듈 자체를 jest.mock으로 가로채(`markLocalStationFired`), 유예 타이머가 "실제 마커 저장소를
// 조회해 backend 수신 여부를 올바르게 판정하는가"를 전혀 거치지 않는다
// (lesson_parts_green_whole_inert_last_consumer / lesson_ci_tests_parts_not_wire).
//
// 이 파일은 그 gap을 메운다 — recentLocalStationFires와 stationNotification을 둘 다 **mock하지
// 않고** 실제 구현을 그대로 태운다. AsyncStorage만 jest-expo preset의 공식 in-memory mock
// (`@react-native-async-storage/async-storage/jest/async-storage-mock`)으로 격리한다(CLAUDE.md
// "Mock 원칙" — AsyncStorage는 항상 mock 대상. 이 mock은 진짜 get/set/remove 동작을 메모리에서
// 재현하므로 markLocalStationFired → hasRecentLocalStationFire 왕복이 실제로 성립한다).
//
// live-activity(네이티브 브릿지)·liveActivityPushChannel·alarmSound·tts는 fireFgAuxStationPassedNotification
// 경로가 호출하지 않지만 stationNotification.ts 모듈 최상단 import라 로드만은 돼야 한다 —
// stationNotification.test.ts와 동일한 mock(네이티브 모듈이라 실모듈 로드 시 Jest에서 throw)으로
// 격리한다.
jest.mock('expo-notifications');

jest.mock('live-activity', () => ({
  startLiveActivity: jest.fn().mockResolvedValue(undefined),
  updateLiveActivity: jest.fn().mockResolvedValue(undefined),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  isLiveActivityEnabled: jest.fn().mockReturnValue(true),
  hasActiveLiveActivity: jest.fn().mockReturnValue(true),
}));

jest.mock('../../utils/liveActivityPushChannel', () => ({
  ensureLiveActivityRegistered: jest.fn().mockResolvedValue(undefined),
  endLiveActivityWithDeregister: jest.fn().mockResolvedValue(undefined),
  shouldSkipDeviceLiveActivityWrite: jest.fn().mockReturnValue(false),
  startAmbientLiveActivityTokenRegistration: jest.fn(() => () => undefined),
}));

jest.mock('../../utils/alarmSound', () => ({
  vibrateAlarm: jest.fn(),
  stopVibration: jest.fn(),
}));

jest.mock('../../utils/tts', () => ({
  speakAlarm: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStationAlarm, type UseStationAlarmInputs } from '../useStationAlarm';
import { _resetFireAlarmOnceForTests } from '../../utils/fireAlarmOnce';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useAlarmEventStore } from '../../store/useAlarmEventStore';
import { useUserIntentStore } from '../../store/useUserIntentStore';
import type { Station } from '../../../../shared/types/station';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import {
  markLocalStationFired,
  LOCAL_FIRE_DEFER_GRACE_MS,
} from '../../utils/recentLocalStationFires';
import { APNS_TOKEN_KEY } from '../../../../shared/constants/storageKeys';

// 아래 2개 모듈은 useStationAlarm.ts가 호출 여부/배선을 보기 위해 mock하지만(기존
// useStationAlarm.test.ts와 동일 패턴), **`stationNotification`과 `recentLocalStationFires`는
// 의도적으로 mock하지 않는다** — 이 파일의 핵심 목적.
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

// alarmLog도 mock한다 — logFiredStationPassed('device-proxy-fired', ...) 호출 여부를 직접
// assert하기 위해(useStationAlarm.test.ts와 동일 패턴). fireFgAuxStationPassedNotification
// 자체는 alarmLog를 호출하지 않으므로(코드 확인) 이 mock이 그 함수의 실제 동작(실제
// hasRecentLocalStationFire 판정 → Notifications.scheduleNotificationAsync 호출 여부)에는
// 영향을 주지 않는다.
const mockLogFiredStationPassed = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logFiredAlarm: jest.fn(),
  logFiredAlarmsHydrate: jest.fn(),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logHydrationTransition: jest.fn(),
  logRefMismatch: jest.fn(),
  logSuppressedDedupAlarm: jest.fn(),
  logSuppressedDedupStation: jest.fn(),
  logSuppressedMovement: jest.fn(),
  logSuppressedPhaseGate: jest.fn(),
  logSuppressedSleepFirstTransfer: jest.fn(),
  logSuppressedSleepStationPassed: jest.fn(),
  logSuppressedDismissSilence: jest.fn(),
  logSuppressedStationPassedWarmup: jest.fn(),
  logSuppressedHopWindow: jest.fn(),
  logSuppressedHopWindowNoSource: jest.fn(),
  logSuppressedOriginHopLockless: jest.fn(),
  logSuppressedPassedEventOnLockOrigin: jest.fn(),
  logSuppressedCrossCategoryDedup: jest.fn(),
  logSuppressedCrossCategoryRecent: jest.fn(),
  logSuppressedPhaseToPhaseDedup: jest.fn(),
  logSuppressedChannelAgnosticDedup: jest.fn(),
  logFiredAlarmsTripBoundaryReset: jest.fn(),
  logSuppressedSsotFireGate: jest.fn(),
  logSuppressedLocklessNoUserIntent: jest.fn(),
  logSuppressedPendingLockUnresolved: jest.fn(),
  logSuppressedFireAlarmOnce: jest.fn(),
  logSuppressedNotDeparted: jest.fn(),
  logEtaSource: jest.fn(),
  logLockExemptGate: jest.fn(),
  // stationNotification.ts(real)이 import하는 값 — 이 경로에서 호출되지 않으므로 no-op으로 충분.
  logLiveActivityUpdated: jest.fn(),
}));

const mockGetTripStartedAt = jest.fn().mockResolvedValue(null);
jest.mock('../../utils/tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

import type { SsotFireGateInput, SsotFireGateOutcome } from '../../utils/ssotFireGate';
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

const mockFindFgArvlCdFireSignal = jest.fn();
jest.mock('../../utils/fgArvlCdFastPath', () => ({
  findFgArvlCdFireSignal: (...args: unknown[]) => mockFindFgArvlCdFireSignal(...args),
}));

const mockUseArrivalInfo = jest.fn();
jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: (...args: unknown[]) => mockUseArrivalInfo(...args),
}));

function setAppState(state: 'active' | 'background' | 'inactive'): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

const makeStation = (id: string, name: string, lat = 37.5, lng = 127.0): Station => ({
  id,
  name,
  line: '2',
  lineColor: '#33A23D',
  lat,
  lng,
});

const station = makeStation('S1', '중곡', 37.5, 127.0);
const destination = makeStation('D1', '강남', 37.498, 127.028);

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
    skipWarmupGuard: true,
    ...overrides,
  };
}

describe('#2940 후속 — 유예 타이머 × 실제 recentLocalStationFires 마커 저장소 양방향 통합', () => {
  // useStationAlarm.ts/useStationAlarm.test.ts와 동일한 setTimeout 캡처 패턴 — 15s 실대기 없이
  // scheduleDeferredStationPassedFire의 콜백을 수동으로 flush한다.
  let capturedTimer: { cb: () => void; delay: number } | null = null;

  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    setAppState('active');
    useSettingsStore.setState({ sleepMode: false, allowSpeaker: true });
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    useUserIntentStore.setState({ infoModeEnabled: false });
    mockEvaluateAlarmPhase.mockReturnValue(null);
    mockResolveAlarmDirection.mockReturnValue(undefined);
    mockResolveNextTarget.mockReturnValue({
      nextStationName: destination.name,
      stopsToNextStation: 1,
      isTransfer: false,
      stopsToDestination: 1,
    });
    mockGetLastNotifiedStationId.mockResolvedValue(null);
    mockSetLastNotifiedStationId.mockResolvedValue(undefined);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockUseArrivalInfo.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockGetBoardingLock.mockResolvedValue(DEFAULT_LOCK);
    mockFindFgArvlCdFireSignal.mockReturnValue(null);
    mockAwaitInitialScheduledAlarmDrain.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
    _resetFireAlarmOnceForTests();
    // 실제 fireFgAuxStationPassedNotification이 device token 미보유 early-return(스킵)으로
    // 빠지지 않도록 — collapse-id를 만들 token을 미리 적재한다(#2122 가드).
    await AsyncStorage.setItem(APNS_TOKEN_KEY, 'a'.repeat(64));

    capturedTimer = null;
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
      capturedTimer = { cb, delay: delay ?? 0 };
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    (global.setTimeout as unknown as jest.Mock).mockRestore();
  });

  async function flushDeferredTimer(): Promise<void> {
    if (!capturedTimer) {
      throw new Error('#2940 — setTimeout이 등록되지 않음(유예 타이머 미호출)');
    }
    await act(async () => {
      capturedTimer?.cb();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function renderStationPassed() {
    return renderHook(() =>
      useStationAlarm(
        defaultInputs({ route: makeDirectRoute(1, '2'), destination, nearestStation: station }),
      ),
    );
  }

  // 방향 B(plan #2940 거부 케이스 ⓐ) — backend가 유예 중 끝내 아무것도 마킹하지 않은 트립
  // (미전달 시뮬레이션). 실제 markLocalStationFired를 전혀 호출하지 않는다 — 저장소가 비어
  // 있으므로 real hasRecentLocalStationFire(station, 'station-passed')는 false를 반환해야 하고,
  // 그 결과 fireFgAuxStationPassedNotification이 실제로 Notifications.scheduleNotificationAsync를
  // 호출해야 한다.
  it('방향 B(미전달) — 아무것도 마킹하지 않으면 유예 만료 후 실제 Notifications.scheduleNotificationAsync가 호출되고 device-proxy-fired로 기록된다', async () => {
    renderStationPassed();

    await waitFor(() => {
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
    });
    expect(capturedTimer?.delay).toBe(LOCAL_FIRE_DEFER_GRACE_MS);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();

    await flushDeferredTimer();

    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(mockLogFiredStationPassed).toHaveBeenCalledWith('device-proxy-fired', station.name);
  });

  // 방향 A(plan #2940 거부 케이스 ⓑ) — backend push가 유예 중 먼저 표시된 트립. 실제
  // markLocalStationFired(station.name, 'station-passed')를 유예 만료 "전"에 호출해 같은
  // AsyncStorage-backed 저장소에 마커를 남긴다(이게 markRemoteShownForBidirectionalDedup이
  // 실제로 쓰는 것과 동일한 함수·동일한 key 규칙). 유예 만료 시 real
  // hasRecentLocalStationFire가 이 마커를 읽어 true를 반환해야 하고, 그 결과
  // fireFgAuxStationPassedNotification이 실제로 스킵(Notifications.scheduleNotificationAsync
  // 미호출)해야 한다 — mock 경계 없이 "타이머가 실제 마커 저장소를 올바르게 재확인하는가"를
  // 검증.
  it('방향 A(정상 전달) — 유예 만료 전 실제 markLocalStationFired로 backend 표시를 마킹하면 Notifications.scheduleNotificationAsync가 호출되지 않고 device-proxy-fired도 기록되지 않는다', async () => {
    renderStationPassed();

    await waitFor(() => {
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(destination.id, station.id);
    });
    expect(capturedTimer?.delay).toBe(LOCAL_FIRE_DEFER_GRACE_MS);

    // backend alert push가 유예 중 먼저 도착해 표시됨을 시뮬레이션 — 프로덕션에서
    // markRemoteShownForBidirectionalDedup(stationNotification.ts)이 호출하는 바로 그 함수.
    await markLocalStationFired(station.name, 'station-passed');

    await flushDeferredTimer();

    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
  });
});
