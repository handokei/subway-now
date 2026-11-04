/* eslint-disable import/no-restricted-paths --
 * Cross-feature: #3086(구 #3080) regression guard — clear된 customOrigin이 AppState 'active'
 * rehydrate(loadCustomOrigin)와 fire-and-forget removeItem 경합으로 부활하는 회귀.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../useDestinationStore';
import { CUSTOM_ORIGIN_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../../../alarm/store/tripBoundCleanups', () => ({
  runTripBoundCleanups: jest.fn().mockResolvedValue(undefined),
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

const origin = {
  id: '5-035',
  name: '마장',
  line: '5' as const,
  lat: 37.5634,
  lng: 127.0419,
  lineColor: '#996CAC',
};

/** removeItem을 release할 때까지 보류 — "완료 전 hydrate" 창을 재현. */
function deferRemoveItem(): { release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key: string) => {
    await gate;
    return AsyncStorage.multiRemove([key]);
  });
  return { release };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('#3086 customOrigin rehydrate vs clear race', () => {
  beforeEach(async () => {
    jest.restoreAllMocks();
    await flush();
    await AsyncStorage.clear();
    useDestinationStore.setState({ destination: null, customOrigin: null, originEpoch: 0 });
  });

  it('clear 직후(removeItem 완료 전) hydrate가 들어와도 customOrigin은 null로 남는다', async () => {
    useDestinationStore.getState().setCustomOrigin(origin);
    await flush();
    expect(await AsyncStorage.getItem(CUSTOM_ORIGIN_KEY)).not.toBeNull();

    const { release } = deferRemoveItem();
    useDestinationStore.getState().setCustomOrigin(null);
    const loading = useDestinationStore.getState().loadCustomOrigin();
    release();
    await loading;
    await flush();

    expect(useDestinationStore.getState().customOrigin).toBeNull();
    expect(await AsyncStorage.getItem(CUSTOM_ORIGIN_KEY)).toBeNull();
  });

  it('hydrate getItem이 in-flight인 동안 clear돼도 stale 값으로 부활시키지 않는다', async () => {
    await AsyncStorage.setItem(CUSTOM_ORIGIN_KEY, JSON.stringify(origin));
    const loading = useDestinationStore.getState().loadCustomOrigin();
    useDestinationStore.getState().setCustomOrigin(null);
    await loading;
    await flush();

    expect(useDestinationStore.getState().customOrigin).toBeNull();
  });

  it('SSOT override clear 직후 hydrate도 부활시키지 않는다', async () => {
    useDestinationStore.getState().setCustomOrigin(origin);
    await flush();
    const { release } = deferRemoveItem();
    const cleared = useDestinationStore
      .getState()
      .clearCustomOriginForSsotOverride({ ...origin, id: '5-036', name: '답십리' });
    expect(cleared).toBe(true);
    const loading = useDestinationStore.getState().loadCustomOrigin();
    release();
    await loading;

    expect(useDestinationStore.getState().customOrigin).toBeNull();
  });

  it('setDestination(null) trip 종료 clear 직후 hydrate도 부활시키지 않는다', async () => {
    useDestinationStore.getState().setCustomOrigin(origin);
    await flush();
    const { runTripBoundCleanups } = require('../../../alarm/store/tripBoundCleanups');
    const { release } = deferRemoveItem();
    (runTripBoundCleanups as jest.Mock).mockImplementation(() =>
      AsyncStorage.removeItem(CUSTOM_ORIGIN_KEY),
    );
    useDestinationStore.setState({ destination: origin });
    useDestinationStore.getState().setDestination(null);
    const loading = useDestinationStore.getState().loadCustomOrigin();
    release();
    await loading;
    await flush();

    expect(useDestinationStore.getState().customOrigin).toBeNull();
  });

  it('거부 케이스: clear하지 않았으면 hydrate가 저장값을 정상 복원한다', async () => {
    await AsyncStorage.setItem(CUSTOM_ORIGIN_KEY, JSON.stringify(origin));
    await useDestinationStore.getState().loadCustomOrigin();

    expect(useDestinationStore.getState().customOrigin).toEqual(origin);
  });

  it('거부 케이스: clear 후 다시 set(persist)한 값은 이후 hydrate에서 유지된다', async () => {
    useDestinationStore.getState().setCustomOrigin(null);
    useDestinationStore.getState().setCustomOrigin(origin);
    await flush();
    useDestinationStore.setState({ customOrigin: null });
    await useDestinationStore.getState().loadCustomOrigin();

    expect(useDestinationStore.getState().customOrigin).toEqual(origin);
  });
});
