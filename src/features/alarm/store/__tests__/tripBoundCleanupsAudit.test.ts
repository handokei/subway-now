/* eslint-disable import/no-restricted-paths --
 * Cross-feature audit test: 본 회귀 가드는 settings → alarm (PR-β B1) 및
 * route → alarm (setDestination → runTripBoundCleanups) 두 orchestration 경로의
 * cleanup contract를 한 자리에서 단언한다. 실제 코드처럼 cross-feature 호출 자체가
 * 의도된 행동이므로 store mock을 위해 양쪽 store를 직접 import한다.
 */
/**
 * #1176 (Epic #1008 — Epic C 단기 12번) — tripBoundCleanups 누락 case 회귀 가드.
 *
 * 목적: lockless ↔ lock 전이에서 `runTripBoundCleanups` 호출 contract가 의도대로 유지되는지
 * 영구 가드한다. 잘못된 누락/오버-클리닝이 PR을 거쳐 머지될 때 즉시 실패 신호를 낸다.
 *
 * Audit 결과 — 전이 case별 의도된 cleanup contract:
 *
 *  1. lockless → lock (`createLock` from prompt/controller):
 *     - 단순 lock 생성 — `clearDismissSilence` 1건만. trip은 살아있으므로
 *       `runTripBoundCleanups` 호출 금지(destination/route 살아남아야 함).
 *
 *  2. lock active → toggle OFF (B1 / PR-β):
 *     - `setLocklessStationPassed(false)` → `releaseLock()`만. trip 유지.
 *       `runTripBoundCleanups`는 호출 금지(destination 사용자 의도 보존).
 *
 *  3. lock active → toggle ON (사용자가 다시 ON):
 *     - 상태/storage 갱신만. lock 자동 재생성/cleanup 모두 금지(사용자 명시 탑승 의사 필요).
 *
 *  4. lock active → auto-release (도착/환승역 grace):
 *     - `releaseLock()`만. trip 종료는 destination 변경 경로가 책임.
 *
 *  5. trip-end (destination switch/null):
 *     - `useDestinationStore.setDestination`이 `triggerTripEndRecall`
 *       → `runTripBoundCleanups` → `setTripStartedAt(if station)` 체인 호출.
 *
 *  6. trip-end (silent push):
 *     - `silentPushTask`가 `runTripBoundCleanups()` 직접 호출.
 *
 * 본 테스트는 1·2·5 경로의 호출 contract를 단언한다(3·4·6은 기존 테스트가 커버).
 * 새 cleanup 항목이 `TRIP_BOUND_CLEANUPS`에 추가될 때 lock-only 전이 경로가 실수로
 * 그 함수를 직접 호출하기 시작하면 본 가드가 빨갛게 깨진다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// settings store는 BoardingLockStore를 직접 호출하지만 (B1, PR-β), 본 테스트는
// 그 호출이 `runTripBoundCleanups`로 확산되지 않는다는 negative contract를 가드한다.
const mockReleaseLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../useBoardingLockStore', () => ({
  useBoardingLockStore: {
    getState: jest.fn(() => ({ releaseLock: mockReleaseLock })),
  },
}));

jest.mock('../../../../shared/infra/monitoring/sentryInit', () => ({
  getSentryOptIn: jest.fn().mockResolvedValue(false),
  setSentryOptIn: jest.fn().mockResolvedValue(undefined),
}));

// useDestinationStore가 사용하는 alarm-side 의존성도 격리 — 본 테스트의 관심사는
// "runTripBoundCleanups가 호출되는가" 단언이므로 실제 cleanup 구현체는 mock.
const mockRunTripBoundCleanups = jest.fn().mockResolvedValue(undefined);
const mockTriggerTripEndRecall = jest.fn().mockResolvedValue(undefined);
const mockSetTripStartedAt = jest.fn().mockResolvedValue(undefined);

jest.mock('../tripBoundCleanups', () => ({
  runTripBoundCleanups: (...args: unknown[]) => mockRunTripBoundCleanups(...args),
}));
jest.mock('../../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));
jest.mock('../../utils/tripStartStorage', () => ({
  setTripStartedAt: (...args: unknown[]) => mockSetTripStartedAt(...args),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));

// 동적 import — mock이 hoist된 뒤 store를 로드해야 한다.
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import type { Station } from '../../../../shared/types/station';

const station: Station = {
  id: 'stn-1',
  name: '강남',
  line: '2',
  lineColor: '#00A84D',
  lat: 37.4979,
  lng: 127.0276,
};
const otherStation: Station = {
  id: 'stn-2',
  name: '역삼',
  line: '2',
  lineColor: '#00A84D',
  lat: 37.5006,
  lng: 127.0366,
};

// #1321 — setDestination chain(triggerTripEndRecall → runTripBoundCleanups → setTripStartedAt)이
// tripTransitionQueue에 직렬화돼 시작이 한 microtask 늦고 단계 사이 .catch가 microtask를 더한다.
// 넉넉히 flush해 chain을 끝까지 진행시킨다(주 store 테스트의 flushMicrotasks와 동일 패턴).
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

describe('#1176 tripBoundCleanups audit — lockless ↔ lock 전이 회귀 가드', () => {
  beforeEach(async () => {
    // #1321 — 직전 테스트가 enqueue한 tripTransitionQueue chain이 남아 있으면 다음 테스트의
    // (clear된) mock으로 늦게 발사돼 호출 카운트를 오염시킨다. clearAllMocks 전에 먼저 drain.
    await flushMicrotasks();
    jest.clearAllMocks();
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    useSettingsStore.setState({ locklessStationPassed: true });
    useDestinationStore.setState({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
  });

  // ── case 2: lock active → toggle OFF (B1 / PR-β) ─────────────────────────────

  it('case 2: setLocklessStationPassed(false)은 releaseLock만 호출하고 runTripBoundCleanups를 호출하지 않는다', async () => {
    // PR-β의 B1 결정: 토글 OFF는 lock만 정리하고 destination/route는 유지한다.
    // 누군가 실수로 setLocklessStationPassed(false) → runTripBoundCleanups()를 추가하면
    // 사용자의 destination이 사라지는 회귀가 즉시 빨갛게 잡힌다.
    await useSettingsStore.getState().setLocklessStationPassed(false);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
  });

  it('case 3: setLocklessStationPassed(true)은 releaseLock도 runTripBoundCleanups도 호출하지 않는다', async () => {
    // 토글 ON 전환은 backend register payload flag만 갱신하는 의미. lock 자동 재생성은
    // 사용자 명시 탑승 의사를 요구하므로 여기서 어떤 cleanup도 일어나면 안 된다.
    useSettingsStore.setState({ locklessStationPassed: false });
    await useSettingsStore.getState().setLocklessStationPassed(true);
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
  });

  // ── case 5: trip-end via destination switch/null ─────────────────────────────

  it('case 5a: setDestination(null) (trip 종료) — triggerTripEndRecall → runTripBoundCleanups 순서로 호출되고 setTripStartedAt은 호출되지 않는다', async () => {
    useDestinationStore.setState({ destination: station });
    useDestinationStore.getState().setDestination(null);
    // #1321 — chain이 tripTransitionQueue에 enqueue돼 한 microtask 늦게 시작하므로 넉넉히 flush.
    await flushMicrotasks();

    expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    // station === null 경로에서는 새 tripStart 기록 안 함.
    expect(mockSetTripStartedAt).not.toHaveBeenCalled();
  });

  it('case 5b: setDestination(switch) (목적지 교체) — runTripBoundCleanups + setTripStartedAt 모두 호출된다', async () => {
    useDestinationStore.setState({ destination: station });
    useDestinationStore.getState().setDestination(otherStation);
    // #1321 — chain은 triggerTripEndRecall → runTripBoundCleanups → setTripStartedAt 3단 await이며
    // tripTransitionQueue 직렬화로 시작이 한 hop 늦다. 넉넉히 flush해 끝까지 진행시킨다.
    await flushMicrotasks();

    expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
    expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
    expect(mockSetTripStartedAt).toHaveBeenCalledTimes(1);
  });

  it('case 5c: setDestination(same id) (재설정) — switch 분기 미진입 → cleanup 0건', async () => {
    // 같은 destination 재설정은 진행 중인 trip/lock/스케줄을 유지하는 것이 의도.
    // 누군가 isSwitch 비교를 (id 무시하고) 항상 true로 만들면 본 가드가 깨진다.
    useDestinationStore.setState({ destination: station });
    useDestinationStore.getState().setDestination({ ...station });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    expect(mockSetTripStartedAt).not.toHaveBeenCalled();
  });

  // ── orthogonality: settings 토글이 destination chain을 invoke하지 않는다 ─────

  it('orthogonality: 토글 OFF가 destination chain(triggerTripEndRecall/setTripStartedAt)을 건드리지 않는다', async () => {
    // settings → alarm cross-feature는 의도된 orchestration이지만, 그 효과가
    // destination layer까지 확산되면 안 된다. settings → route 호출은 금지.
    useDestinationStore.setState({ destination: station });
    await useSettingsStore.getState().setLocklessStationPassed(false);
    await Promise.resolve();

    expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
    expect(mockSetTripStartedAt).not.toHaveBeenCalled();
    expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
    // destination 자체는 살아있어야 한다.
    expect(useDestinationStore.getState().destination).toEqual(station);
  });
});
