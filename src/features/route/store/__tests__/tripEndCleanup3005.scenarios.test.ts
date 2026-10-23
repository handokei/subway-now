/* eslint-disable import/no-restricted-paths --
 * Cross-feature scenario test: setDestination(route) -> 종료 정리 체인(alarm) -> backend DELETE(alarm api)
 * -> launch reconciliation(alarm hook)을 한 흐름으로 묶는다. 본질이 cross-feature.
 */
/**
 * #3005 acceptance — 트립 종료 정리가 **새 트립을 지우지 않는다** (device 시나리오 S1~S3).
 *
 * 이 파일은 fix 전에 박는 시나리오 테스트다. 구현을 보고 기대값을 맞춘 것이 아니라 이슈 #3005
 * 코멘트("fix plan v2: verify-plan 반증 5건")의 사용자 관점 결과에서 나왔다.
 *   S1  대기(destination=null)에서 새 목적지 선택 -> 새 트립이 정리 체인에 지워지지 않는다 (10-18 실측)
 *   S2  종료 `setDestination(null)` 직후, 정리 체인이 끝나기 전에 `setDestination(X)` (경합)
 *   S3  직전 트립 종료 뒤 도착한 silent push stamp가 새 트립 Signal 4 자가 종료를 일으키지 않는다
 *
 * 설계 원칙 (이슈 코멘트 반증 1: "테스트도 flush를 넣고 있어서 이 경합을 재현하지 못합니다"):
 *   - `runTripBoundCleanups`는 **실제 구현**을 쓴다. (setDestinationStorageRace.test.ts는 이것을 mock해서
 *     "새 트립의 ACTIVE_TRIP/corrId/trackingOptIn을 지우는" 동작 자체가 테스트에 존재하지 않는다.)
 *   - 정리 체인의 첫 await(`triggerTripEndRecall`, 실제로는 recall/dump 업로드로 수 초)를 **pending promise로
 *     붙잡아** 체인이 멈춘 사이에 사용자·등록 hook이 하는 일을 끼워 넣는다. 중간에 flush를 넣지 않는다.
 *   - 새 트립의 backend 등록 ack(`useApnsTripRegistration.ts` ACTIVE_TRIP_KEY write)는 AsyncStorage write로 재현.
 *   - backend DELETE는 `clearActiveTrip` mock 호출(토큰, reason)로 관측한다 -> 'X에 대한 DELETE 0회'.
 *
 * 근거 실측: tasks/evidence-2026-10-23-trip-self-delete-d1.json id 1021~1026
 *   (trip-register 33249495 -> ... -> trip-end reason=destination-switch 33252955, 같은 token_hash b00dd879).
 *   즉 새 트립이 등록(1021)된 지 3.4초 뒤 `destination-switch` DELETE(1026)가 그 트립을 지웠다.
 *
 * 현재 코드에서 실패하는 시나리오는 `it.failing`(jest의 it.fails 등가) — fix PR이 `.failing`을 제거한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../useDestinationStore';
import {
  ACTIVE_TRIP_KEY,
  LAST_SILENT_PUSH_RECEIVED_AT_KEY,
  TRIP_STARTED_AT_KEY,
} from '../../../../shared/constants/storageKeys';
import { SIGNAL_4_SILENT_PUSH_TIMEOUT_MS } from '../../../../shared/constants/realtime';
import { useUserIntentStore } from '../../../alarm/store/useUserIntentStore';
import { __resetDefensiveCancelForTest } from '../../../alarm/store/tripBoundCleanups';
import { runLaunchTripReconciliation } from '../../../alarm/hooks/useLaunchTripReconciliation';
import { setLastSilentPushReceivedAt } from '../../../alarm/utils/lastSilentPushReceivedAt';
import { getCurrentTripCorrIdSync, __resetTripCorrIdForTests__ } from '../../../observability/utils/tripCorrId';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-notifications');
jest.mock('live-activity', () => ({ endLiveActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../widget/api/widgetStorage', () => ({
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../alarm/utils/liveActivityPushChannel', () => ({
  resetLiveActivityChannelAfterExternalEnd: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));
// 정리 체인의 첫 await. 실제로는 recall/dump 업로드(수 초) — 각 테스트가 deferred로 붙잡는다.
jest.mock('../../../alarm/utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: jest.fn(),
}));
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: jest.fn().mockResolvedValue(undefined),
}));
// backend DELETE /trips/:token 관측점. 그 외 alarmBackend export는 실제 구현 유지.
jest.mock('../../../alarm/api/alarmBackend', () => ({
  ...jest.requireActual('../../../alarm/api/alarmBackend'),
  clearActiveTrip: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
}));
// Signal 4 경로의 네트워크/알림 경계만 격리 (판정 로직은 실제 구현).
jest.mock('../../../alarm/api/tripStatus', () => ({
  fetchTripStatus: jest.fn().mockResolvedValue({ status: 'active' }),
}));
jest.mock('../../../alarm/api/signalDumpBackend', () => ({
  flushSignalDumpOutbox: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../alarm/utils/tripEndedNotification', () => ({
  notifyTripEnded: jest.fn().mockResolvedValue(undefined),
}));

const { triggerTripEndRecall } = jest.requireMock('../../../alarm/utils/triggerTripEndRecall') as {
  triggerTripEndRecall: jest.Mock;
};
const { clearActiveTrip } = jest.requireMock('../../../alarm/api/alarmBackend') as {
  clearActiveTrip: jest.Mock;
};
const { notifyTripEnded } = jest.requireMock('../../../alarm/utils/tripEndedNotification') as {
  notifyTripEnded: jest.Mock;
};
const { getAllScheduledNotificationsAsync, getPresentedNotificationsAsync } = jest.requireMock('expo-notifications') as {
  getAllScheduledNotificationsAsync: jest.Mock;
  getPresentedNotificationsAsync: jest.Mock;
};

/** triggerTripEndRecall을 호출될 때마다 pending promise로 붙잡는다. release()로 해제. */
function holdRecall(): { release: () => void; calls: () => number } {
  const releases: Array<() => void> = [];
  triggerTripEndRecall.mockImplementation(
    () => new Promise((resolve) => releases.push(() => resolve({ uploaded: false }))),
  );
  return {
    release: () => releases.splice(0).forEach((r) => r()),
    calls: () => triggerTripEndRecall.mock.calls.length,
  };
}

/** 체인 안의 모든 microtask/AsyncStorage promise가 소진될 때까지 양보한다. */
async function drain(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

const stationX = {
  id: '2-210',
  name: canonicalStationName('뚝섬', '2'),
  line: '2' as const,
  lat: 37.547,
  lng: 127.047,
  lineColor: '#00A84D',
};
const stationTrip1 = {
  id: '7-015',
  name: canonicalStationName('용마산', '7'),
  line: '7' as const,
  lat: 37.573,
  lng: 127.087,
  lineColor: '#747F00',
};

const TOKEN_X = 'trip-token-X-registered-after-select';
const TOKEN_TRIP1 = 'trip-token-1';

/** 새 트립 등록 ack — useApnsTripRegistration의 ACTIVE_TRIP_KEY write를 재현. */
async function registerAck(token: string): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, token);
}

/** X(새 트립)를 대상으로 한 backend DELETE 호출. */
function deletesFor(token: string): unknown[][] {
  return clearActiveTrip.mock.calls.filter(([t]) => t === token);
}

beforeEach(async () => {
  await drain();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  __resetDefensiveCancelForTest();
  __resetTripCorrIdForTests__();
  useDestinationStore.setState({
    destination: null,
    recentDestinations: [],
    customOrigin: null,
    tripOrigin: null,
  });
  useUserIntentStore.setState({ trackingOptIn: false });
  getAllScheduledNotificationsAsync.mockResolvedValue([]);
  getPresentedNotificationsAsync.mockResolvedValue([]);
  clearActiveTrip.mockResolvedValue({ ok: true, status: 200 });
  triggerTripEndRecall.mockResolvedValue({ uploaded: false });
  process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://backend.test';
});

afterEach(() => {
  __resetDefensiveCancelForTest();
  jest.useRealTimers();
});

/** 시나리오 종료 시점의 "사용자 관점" 관측값. 항목별로 it.failing을 분리해 실패 사유를 격리한다. */
interface TripSurvival {
  corrIdOfX: string | null;
  corrIdAfter: string | null;
  trackingOptInAfter: boolean;
  activeTripAfter: string | null;
  tripStartedAtAfter: string | null;
}

async function observe(corrIdOfX: string | null): Promise<TripSurvival> {
  return {
    corrIdOfX,
    corrIdAfter: getCurrentTripCorrIdSync(),
    trackingOptInAfter: useUserIntentStore.getState().trackingOptIn,
    activeTripAfter: await AsyncStorage.getItem(ACTIVE_TRIP_KEY),
    tripStartedAtAfter: await AsyncStorage.getItem(TRIP_STARTED_AT_KEY),
  };
}

/**
 * S1: 대기(prev===null) -> setDestination(X) -> 등록 ack -> (뒤늦게) 정리 체인 진행.
 * 10-18 실측(evidence id 1021~1026): 등록은 정리 체인(recall 업로드 await 수 초)보다 먼저 끝난다.
 */
async function runS1(): Promise<TripSurvival> {
  const recall = holdRecall();
  expect(useDestinationStore.getState().destination).toBeNull(); // 대기 상태 (prev === null)

  useDestinationStore.getState().setDestination(stationX);
  const corrIdOfX = getCurrentTripCorrIdSync();
  expect(corrIdOfX).not.toBeNull();
  expect(useUserIntentStore.getState().trackingOptIn).toBe(true);

  await registerAck(TOKEN_X);
  await drain();
  // 정리 체인이 있다면 지금 recall에서 멈춰 있다 (flush로 끝내지 않는다). fix가 체인을 건너뛰어도 무관.

  recall.release(); // 체인이 이제서야 진행: runTripBoundCleanups('destination-switch')
  await drain();
  return observe(corrIdOfX);
}

describe('#3005 S1 [10-18 실측] 대기 상태에서 새 목적지 선택 -> 새 트립이 정리 체인에 지워지지 않는다', () => {
  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('ACTIVE_TRIP(백엔드 트립 토큰)이 유지된다', async () => {
    expect((await runS1()).activeTripAfter).toBe(TOKEN_X);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('새 트립의 corrId가 유지된다', async () => {
    const { corrIdOfX, corrIdAfter } = await runS1();
    expect(corrIdAfter).toBe(corrIdOfX);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('trackingOptIn이 유지된다', async () => {
    expect((await runS1()).trackingOptInAfter).toBe(true);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('X를 대상으로 한 백엔드 DELETE(10-18의 destination-switch http-delete)가 0회다', async () => {
    await runS1();
    expect(deletesFor(TOKEN_X)).toHaveLength(0);
  });

  it('현재도 통과 — 새 트립의 tripStartedAt은 체인 마지막 단계에서 기록되어 남는다', async () => {
    expect((await runS1()).tripStartedAtAfter).not.toBeNull();
  });
});

/**
 * S2: 트립1 종료 setDestination(null) 직후, 체인1이 recall await 중인 사이에 setDestination(X).
 * 중간 flush 없음 — 체인1 -> 체인2가 큐로 직렬화돼 recall release 두 번으로 진행된다.
 */
async function runS2(): Promise<TripSurvival> {
  useDestinationStore.setState({ destination: stationTrip1 });
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN_TRIP1);
  const recall = holdRecall();

  useDestinationStore.getState().setDestination(null); // 트립1 종료 -> 체인1: recall pending
  expect(useDestinationStore.getState().destination).toBeNull(); // store는 동기로 null

  useDestinationStore.getState().setDestination(stationX); // 체인1이 끝나기 전에 X 선택
  const corrIdOfX = getCurrentTripCorrIdSync();
  expect(corrIdOfX).not.toBeNull();
  await registerAck(TOKEN_X); // 새 트립 등록 ack가 트립1의 ACTIVE_TRIP 값을 덮어쓴다
  await drain();
  expect(recall.calls()).toBeGreaterThanOrEqual(1); // 체인1은 recall에서 멈춰 있다 (경합 전제 성립 확인)

  recall.release(); // 체인1 진행
  await drain();
  recall.release(); // 체인2 진행
  await drain();
  return observe(corrIdOfX);
}

describe('#3005 S2 [경합] 종료 직후 정리 체인이 끝나기 전에 새 목적지 선택', () => {
  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('X의 ACTIVE_TRIP이 유지된다', async () => {
    expect((await runS2()).activeTripAfter).toBe(TOKEN_X);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('X의 corrId가 유지된다', async () => {
    const { corrIdOfX, corrIdAfter } = await runS2();
    expect(corrIdAfter).toBe(corrIdOfX);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('X의 trackingOptIn이 유지된다', async () => {
    expect((await runS2()).trackingOptInAfter).toBe(true);
  });

  // #3005 acceptance — fix PR이 .failing을 제거한다
  it.failing('X를 대상으로 한 백엔드 DELETE가 어느 체인에서도 0회다', async () => {
    await runS2();
    expect(deletesFor(TOKEN_X)).toHaveLength(0);
  });

  it('거부 케이스 — 종료(null)만 하면 트립1의 상태는 정리된다 (정리 자체는 여전히 동작)', async () => {
    useDestinationStore.setState({ destination: stationTrip1 });
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN_TRIP1);
    await AsyncStorage.setItem(TRIP_STARTED_AT_KEY, '1');

    useDestinationStore.getState().setDestination(null);
    await drain();

    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(TRIP_STARTED_AT_KEY)).toBeNull();
    // 종료된 트립1의 backend 트립은 정상 삭제된다 (user-clear). fix가 이것까지 막으면 안 된다.
    expect(clearActiveTrip).toHaveBeenCalledWith(TOKEN_TRIP1, 'user-clear');
  });

  it('거부 케이스 — 진행 중 트립1 -> X로 전환(switch)하면 트립1은 삭제되고 X는 유지된다', async () => {
    useDestinationStore.setState({ destination: stationTrip1 });
    await AsyncStorage.setItem(ACTIVE_TRIP_KEY, TOKEN_TRIP1);

    useDestinationStore.getState().setDestination(stationX);
    await drain(); // 체인 완주 (등록 ack는 체인 완료 후 도착 = 정상 순서)
    await registerAck(TOKEN_X);
    await drain();

    expect(clearActiveTrip).toHaveBeenCalledWith(TOKEN_TRIP1, 'destination-switch');
    expect(deletesFor(TOKEN_X)).toHaveLength(0);
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe(TOKEN_X);
  });
});

describe('#3005 S3 직전 트립 종료 뒤 도착한 silent push stamp가 새 트립 Signal 4를 일으키지 않는다', () => {
  // 현재 코드는 새 트립 시작 정리 체인(clearLastSilentPushReceivedAt)이 이 stamp를 마지막으로 지운다
  // (이슈 코멘트 반증 2). 그래서 현재도 통과한다 — "prev===null이면 체인을 건너뛴다"는 fix(PR-1)가
  // 이 장치를 없애는 순간 이 시나리오가 회귀를 잡는다.
  it('종료 뒤 늦게 도착한 stamp(30분+ 경과) + 새 트립 시작 -> launch reconciliation이 새 트립을 자가 종료하지 않는다', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T06:00:00Z') });

    // 트립1 종료 (체인 완주).
    useDestinationStore.setState({ destination: stationTrip1 });
    useDestinationStore.getState().setDestination(null);
    await drain();
    expect(await AsyncStorage.getItem(LAST_SILENT_PUSH_RECEIVED_AT_KEY)).toBeNull();

    // 종료 후 도착한 silent push가 stamp를 남긴다 (silentPushTask.ts: 트립 확인 없이 기록).
    await setLastSilentPushReceivedAt(Date.now());

    // SIGNAL_4_SILENT_PUSH_TIMEOUT_MS 넘게 지난 뒤 사용자가 새 목적지를 고르고 등록까지 끝낸다.
    jest.setSystemTime(Date.now() + SIGNAL_4_SILENT_PUSH_TIMEOUT_MS + 60_000);
    useDestinationStore.getState().setDestination(stationX);
    await drain();
    await registerAck(TOKEN_X);

    await runLaunchTripReconciliation();

    // 사용자 관점: 새 트립이 살아 있고 자가 종료 알림도 나가지 않았다.
    expect(await AsyncStorage.getItem(ACTIVE_TRIP_KEY)).toBe(TOKEN_X);
    expect(notifyTripEnded).not.toHaveBeenCalled();
    expect(deletesFor(TOKEN_X)).toHaveLength(0);
    expect(clearActiveTrip).not.toHaveBeenCalledWith(TOKEN_X, 'launch-backend-silent-timeout');
  });

  it('거부 케이스 — 같은 트립 안에서 silent push가 30분+ 끊기면 Signal 4는 여전히 자가 종료한다', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T06:00:00Z') });
    useDestinationStore.getState().setDestination(stationX);
    await drain();
    await registerAck(TOKEN_X);
    await setLastSilentPushReceivedAt(Date.now()); // 같은 트립 중 마지막 silent push

    jest.setSystemTime(Date.now() + SIGNAL_4_SILENT_PUSH_TIMEOUT_MS + 60_000);
    await runLaunchTripReconciliation();

    expect(notifyTripEnded).toHaveBeenCalledTimes(1);
    expect(clearActiveTrip).toHaveBeenCalledWith(TOKEN_X, 'launch-backend-silent-timeout');
  });
});
