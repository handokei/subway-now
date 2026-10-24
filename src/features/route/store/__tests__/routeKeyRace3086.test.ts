/* eslint-disable import/no-restricted-paths --
 * Cross-feature: #3086 ROUTE_KEY race — 실 useDestinationStore + 실 runTripBoundCleanups.
 * HomeScreen의 route setItem이 destination-switch cleanup의 늦은 removeItem에 지워지는지 검증.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore, persistRouteAfterTransition } from '../useDestinationStore';
import { ROUTE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-notifications');
jest.mock('live-activity', () => ({ endLiveActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../widget/api/widgetStorage', () => ({
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));

// recall 업로드(네트워크)는 수 초 걸릴 수 있다 — deferred로 제어해 cleanup removeItem 시점을 늦춘다.
let releaseRecall: () => void = () => {};
jest.mock('../../../alarm/utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: jest.fn(
    () =>
      new Promise((resolve) => {
        releaseRecall = () => resolve({ uploaded: false });
      }),
  ),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  setTripStartedAt: jest.fn().mockResolvedValue(undefined),
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../alarm/utils/tripEndOffer', () => ({
  scheduleTripEndOffer: jest.fn().mockResolvedValue(undefined),
  cancelTripEndOffer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: jest.fn(),
}));

const stationA = { id: '5-035', name: '마장', line: '5' as const, lat: 37.56, lng: 127.04, lineColor: '#996CAC' };
const stationB = { id: '5-036', name: '답십리', line: '5' as const, lat: 37.57, lng: 127.05, lineColor: '#996CAC' };
const routeToB = { stations: [stationA, stationB] };

async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

// HomeScreen(~723)이 InteractionManager 후 호출하는 경로.
function homeScreenPersistRoute(): void {
  persistRouteAfterTransition(routeToB);
}

describe('#3086 ROUTE_KEY race (destination-switch cleanup vs HomeScreen setItem)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useDestinationStore.setState({ destination: stationA });
  });

  it('목적지 전환 후 HomeScreen이 쓴 route가 늦게 도는 cleanup removeItem에 지워지지 않는다', async () => {
    useDestinationStore.getState().setDestination(stationB);
    await flush();
    // 사용자 화면: 새 목적지 route 계산 완료 → 저장 (cleanup은 recall 대기 중이라 아직 removeItem 전)
    homeScreenPersistRoute();
    await flush();

    releaseRecall(); // recall 끝 → cleanup(destination-switch) 진행
    await flush();

    // 사용자 결과: 지도 탭이 읽는 ROUTE_KEY에 새 목적지 경로가 남아 있어야 한다.
    const raw = await AsyncStorage.getItem(ROUTE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(routeToB);
  });

  it('A: 큐에 persist(X) 대기 중 사용자가 Y 탭 -> 최종 ROUTE_KEY는 Y (X 부활 금지)', async () => {
    const routeY = { stations: [stationB, stationA] };
    useDestinationStore.getState().setDestination(stationB);
    await flush();
    persistRouteAfterTransition(routeToB); // X
    persistRouteAfterTransition(routeY); // 사용자 탭 Y
    releaseRecall();
    await flush();
    expect(JSON.parse((await AsyncStorage.getItem(ROUTE_KEY)) as string)).toEqual(routeY);
  });

  it('B: route 없음(null) 저장은 removeItem이며 cleanup 뒤 stale route를 부활시키지 않는다', async () => {
    await AsyncStorage.setItem(ROUTE_KEY, JSON.stringify(routeToB));
    useDestinationStore.getState().setDestination(stationB);
    await flush();
    persistRouteAfterTransition(null);
    releaseRecall();
    await flush();
    expect(await AsyncStorage.getItem(ROUTE_KEY)).toBeNull();
  });

  it('배선 가드: HomeScreen은 ROUTE_KEY를 큐 밖에서 직접 쓰/지우지 않고 헬퍼만 호출한다', () => {
    const src = readFileSync(join(__dirname, '../../../../screens/HomeScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/AsyncStorage\.setItem\(\s*ROUTE_KEY/);
    expect(src).not.toMatch(/AsyncStorage\.removeItem\(\s*ROUTE_KEY/);
    expect(src.match(/persistRouteAfterTransition\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
