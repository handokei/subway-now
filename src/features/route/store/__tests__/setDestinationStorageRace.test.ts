/* eslint-disable import/no-restricted-paths --
 * Cross-feature: #1379 regression guard — setDestination의 storage race 재발 방지.
 * DESTINATION_KEY가 cleanup chain의 removeItem에 의해 지워지는 회귀를 검증.
 *
 * 설계 원칙:
 *   - AsyncStorage는 memory-backed mock 사용 → 실제 stored value 검증 가능.
 *   - runTripBoundCleanups를 wrapping mock으로 교체. 내부에서 DESTINATION_KEY / TRIP_ORIGIN_KEY의
 *     removeItem만 실행해 race를 재현한다. 나머지 OS/notification side effect는 차단.
 *   - 개별 helper mock 대신 tripBoundCleanups 단위로 mock해야 useDestinationStore.test.ts의
 *     removeItem spy count를 오염시키지 않는다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../useDestinationStore';
import {
  DESTINATION_KEY,
  TRIP_ORIGIN_KEY,
} from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// tripBoundCleanups 전체를 wrapping mock.
// runTripBoundCleanups의 실제 구현은 beforeEach에서 mockImplementation으로 복구한다.
jest.mock('../../../alarm/store/tripBoundCleanups', () => ({
  runTripBoundCleanups: jest.fn(),
  cancelTripBoundOsQueue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  setTripStartedAt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../alarm/utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: jest.fn().mockResolvedValue({ uploaded: false }),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));

// #1379 핵심 시뮬레이션: runTripBoundCleanups가 DESTINATION_KEY를 제거하는 동작.
// 이 구현을 beforeEach에서 매 테스트 전에 세팅해 jest.clearAllMocks 초기화를 복구한다.
async function runTripBoundCleanupsMockImpl(): Promise<void> {
  await AsyncStorage.removeItem(DESTINATION_KEY);
  await AsyncStorage.removeItem(TRIP_ORIGIN_KEY);
}

const mockStation = {
  id: '5-035',
  name: '마장',
  line: '5' as const,
  lat: 37.5634,
  lng: 127.0419,
  lineColor: '#996CAC',
};

const mockStationB = {
  id: '5-036',
  name: '답십리',
  line: '5' as const,
  lat: 37.5655,
  lng: 127.0523,
  lineColor: '#996CAC',
};

async function flushMicrotasks(): Promise<void> {
  // triggerTripEndRecall → runTripBoundCleanups → setItem chain을 충분히 drain한다.
  // tripTransitionQueue chain은 최대 4단계(then×4) 깊이. 50회로 넉넉하게.
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

describe('#1379 setDestination storage race 회귀 가드', () => {
  beforeEach(async () => {
    // 직전 테스트의 tripTransitionQueue 잔여 chain drain.
    await flushMicrotasks();
    await AsyncStorage.clear();
    useDestinationStore.setState({
      destination: null,
      recentDestinations: [],
      customOrigin: null,
      tripOrigin: null,
      routePreference: 'optimal',
    });
    jest.clearAllMocks();
    // jest.clearAllMocks가 mock 구현도 초기화 — 각 mock의 Promise 반환 복구.
    const { triggerTripEndRecall } = require('../../../alarm/utils/triggerTripEndRecall');
    const { setTripStartedAt } = require('../../../alarm/utils/tripStartStorage');
    const { runTripBoundCleanups } = require('../../../alarm/store/tripBoundCleanups');
    (triggerTripEndRecall as jest.Mock).mockResolvedValue({ uploaded: false });
    (setTripStartedAt as jest.Mock).mockResolvedValue(undefined);
    // #1379 핵심: cleanup chain이 DESTINATION_KEY + TRIP_ORIGIN_KEY를 removeItem하는 동작 유지.
    (runTripBoundCleanups as jest.Mock).mockImplementation(runTripBoundCleanupsMockImpl);
  });

  it('P0 (#1379): setDestination(station) 후 DESTINATION_KEY가 storage에 남아 있어야 한다', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);

    await flushMicrotasks();

    const stored = await AsyncStorage.getItem(DESTINATION_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).id).toBe('5-035');
  });

  it('switch: setDestination(A) → setDestination(B) 후 최종 DESTINATION_KEY == B', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    // cleanup chain이 in-flight인 상태에서 바로 switch.
    setDestination(mockStationB);

    await flushMicrotasks();

    const stored = await AsyncStorage.getItem(DESTINATION_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!).id).toBe('5-036');
  });

  it('end: setDestination(A) → setDestination(null) 후 DESTINATION_KEY == null', async () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    await flushMicrotasks();

    setDestination(null);
    await flushMicrotasks();

    const storedDest = await AsyncStorage.getItem(DESTINATION_KEY);
    expect(storedDest).toBeNull();
  });

  it('end: setDestination(A) → setDestination(null) 후 TRIP_ORIGIN_KEY도 storage에서 제거된다 (#700)', async () => {
    const { setDestination, setTripOrigin } = useDestinationStore.getState();
    setDestination(mockStation);
    await flushMicrotasks();
    // trip 도중 origin 캡처.
    setTripOrigin(mockStation);
    const originBefore = await AsyncStorage.getItem(TRIP_ORIGIN_KEY);
    expect(originBefore).not.toBeNull();

    setDestination(null);
    await flushMicrotasks();

    const storedOrigin = await AsyncStorage.getItem(TRIP_ORIGIN_KEY);
    expect(storedOrigin).toBeNull();
  });
});
