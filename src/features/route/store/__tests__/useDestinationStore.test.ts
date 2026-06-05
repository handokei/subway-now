/* eslint-disable import/no-restricted-paths --
 * Cross-feature test: useDestinationStore 본체가 setDestination switch 분기에서
 * useAlarmEventStore의 alarmEvent/dismissSilence 메모리 mirror를 함께 클리어한다
 * (file-level disable 사용). 본 테스트도 같은 cross-feature 동작을 검증하므로 같은 import 필요.
 * ADR Phase 5 (#890) orchestration 컨벤션.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDestinationStore } from '../useDestinationStore';
import { useAlarmEventStore } from '../../../alarm/store/useAlarmEventStore';
import { Station } from '../../../../shared/types/station';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127276,
};

const mockStation2: Station = {
  id: '2-021',
  name: '역삼',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5006,
  lng: 127365,
};

describe('useDestinationStore', () => {
  beforeEach(() => {
    useDestinationStore.setState({
      destination: null,
      recentDestination: null,
      customOrigin: null,
      tripOrigin: null,
      routePreference: 'optimal',
    });
    useAlarmEventStore.setState({ alarmEvent: null, dismissSilence: null });
    jest.clearAllMocks();
  });

  // ── destination ──

  it('초기 목적지는 null이다', () => {
    const { destination } = useDestinationStore.getState();
    expect(destination).toBeNull();
  });

  it('setDestination: 목적지를 설정하면 상태가 업데이트된다', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);

    const { destination } = useDestinationStore.getState();
    expect(destination?.id).toBe('2-022');
  });

  it('setDestination: null을 설정하면 목적지가 초기화된다', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    setDestination(null);

    const { destination } = useDestinationStore.getState();
    expect(destination).toBeNull();
  });

  it('setDestination: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:destination',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setDestination(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:destination');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:fired-alarms');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:route');
    // #700 — trip 종료 시 tripOrigin도 atomic하게 클리어
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:trip-origin');
  });

  it('setDestination(#702): 목적지 switch 시 부수 storage(customOrigin/lock/scheduled/active-trip) 자동 클리어', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    // 다른 역으로 switch
    setDestination(mockStation2);

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:active-trip');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:fired-alarms');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:route');
  });

  it('setDestination(#702): null로 클리어 시에도 부수 storage 자동 클리어', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    setDestination(null);

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:active-trip');
  });

  // clearFiredPushIds는 firedPushIds 모듈의 write queue를 통과 — microtask flush 후 검증.
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  // #799: switch와 null 두 경로가 동일한 trip-bound cleanup을 트리거하므로 it.each로 통합.
  it.each<[string, 'switch' | 'null']>([
    ['switch', 'switch'],
    ['null clear', 'null'],
  ])('setDestination(#799): %s 시 silent push/알람 trip-bound state 정리', async (_, transition) => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    setDestination(transition === 'switch' ? mockStation2 : null);
    await flushMicrotasks();

    for (const key of [
      'subway-now:last-notified-station',
      'subway-now:last-fired-alarm-station-name',
      'subway-now:fired-push-ids',
      'subway-now:trip-train-code',
      'subway-now:alarm-event',
    ]) {
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(key);
    }
  });

  it('setDestination(#799): switch 시 alarmEvent 메모리 state도 null로 동기화', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    useAlarmEventStore.getState().setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '시청' });
    expect(useAlarmEventStore.getState().alarmEvent).not.toBeNull();

    setDestination(mockStation2);

    expect(useAlarmEventStore.getState().alarmEvent).toBeNull();
  });

  it('setDestination(#702/#799): 같은 목적지 재설정 시에는 trip-bound storage 전부 유지', () => {
    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    // 동일 station id 재설정 — switch 아님 → 모든 trip-bound cleanup 건너뜀.
    setDestination(mockStation);

    for (const key of [
      // #702 부수 storage
      'subway-now:custom-origin',
      'subway-now:boarding-lock',
      'subway-now:scheduled-notifications',
      'subway-now:active-trip',
      'subway-now:fired-alarms',
      'subway-now:route',
      // #799 silent push/알람 state
      'subway-now:last-notified-station',
      'subway-now:last-fired-alarm-station-name',
      'subway-now:fired-push-ids',
      'subway-now:trip-train-code',
      'subway-now:alarm-event',
    ]) {
      expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(key);
    }
  });

  it('setDestination(#702): switch 시 customOrigin 메모리 state도 null로 동기화', () => {
    const { setDestination, setCustomOrigin } = useDestinationStore.getState();
    setDestination(mockStation);
    setCustomOrigin(mockStation2);
    expect(useDestinationStore.getState().customOrigin?.id).toBe('2-021');

    setDestination(mockStation2);

    expect(useDestinationStore.getState().customOrigin).toBeNull();
  });

  it('setDestination(#702): loadDestination(hydration)은 부수 storage를 클리어하지 않는다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));
    jest.clearAllMocks();

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(useDestinationStore.getState().destination?.id).toBe('2-022');
  });

  it('setDestination: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    const setItemImpl = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
    const removeItemImpl = (AsyncStorage.removeItem as jest.Mock).getMockImplementation();
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    // setDestination(null) switch: DESTINATION + fired + route + customOrigin + lock + scheduled + active-trip + TRIP_ORIGIN = 8 removeItem
    for (let i = 0; i < 8; i++) {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));
    }

    const { setDestination } = useDestinationStore.getState();
    setDestination(mockStation);
    // catch(noop)로 에러가 무시되므로 에러가 던져지지 않아야 한다
    await new Promise((r) => setTimeout(r, 0));

    setDestination(null);
    await new Promise((r) => setTimeout(r, 0));
    // 에러 없이 완료 — implementation 복원 (다른 테스트 영향 방지)
    (AsyncStorage.setItem as jest.Mock).mockImplementation(setItemImpl);
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(removeItemImpl);
  });

  it('setDestination(null): tripOrigin도 함께 클리어된다 (#700)', () => {
    // tripOrigin이 trip 도중 캡처된 상태에서 trip 종료 시 stale origin이 남으면
    // 다음 trip 시작 시 잘못된 route가 잠깐 노출된다.
    const { setDestination, setTripOrigin } = useDestinationStore.getState();
    setDestination(mockStation);
    setTripOrigin(mockStation2);
    expect(useDestinationStore.getState().tripOrigin?.id).toBe('2-021');
    setDestination(null);
    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  it('loadDestination: AsyncStorage에 저장된 목적지를 상태로 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:destination');
    expect(useDestinationStore.getState().destination?.id).toBe('2-022');
  });

  it('loadDestination: 저장된 값이 없으면 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(useDestinationStore.getState().destination).toBeNull();
  });

  it('loadDestination: AsyncStorage 실패 시 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('읽기 실패'));

    const { loadDestination } = useDestinationStore.getState();
    await loadDestination();

    expect(useDestinationStore.getState().destination).toBeNull();
  });

  // ── recentDestination ──

  it('초기 recentDestination은 null이다', () => {
    const { recentDestination } = useDestinationStore.getState();
    expect(recentDestination).toBeNull();
  });

  it('setRecentDestination: 역을 설정하면 상태가 업데이트된다', () => {
    const { setRecentDestination } = useDestinationStore.getState();
    setRecentDestination(mockStation);

    const { recentDestination } = useDestinationStore.getState();
    expect(recentDestination?.id).toBe('2-022');
  });

  it('setRecentDestination: null을 설정하면 초기화된다', () => {
    const { setRecentDestination } = useDestinationStore.getState();
    setRecentDestination(mockStation);
    setRecentDestination(null);

    const { recentDestination } = useDestinationStore.getState();
    expect(recentDestination).toBeNull();
  });

  // ── customOrigin ──

  it('초기 customOrigin은 null이다', () => {
    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 출발역을 설정하면 상태가 업데이트된다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('setCustomOrigin: null을 설정하면 출발역이 초기화된다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    setCustomOrigin(null);

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:custom-origin',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setCustomOrigin(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
  });

  it('setCustomOrigin: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));

    const { setCustomOrigin } = useDestinationStore.getState();
    setCustomOrigin(mockStation);
    await new Promise((r) => setTimeout(r, 0));

    setCustomOrigin(null);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('loadCustomOrigin: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('loadCustomOrigin: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('loadCustomOrigin: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadCustomOrigin } = useDestinationStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useDestinationStore.getState();
    expect(customOrigin).toBeNull();
  });

  // ── #700 tripOrigin 영속화 ──

  it('초기 tripOrigin은 null이다', () => {
    const { tripOrigin } = useDestinationStore.getState();
    expect(tripOrigin).toBeNull();
  });

  it('setTripOrigin: 역을 설정하면 상태가 업데이트된다', () => {
    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);

    const { tripOrigin } = useDestinationStore.getState();
    expect(tripOrigin?.id).toBe('2-022');
  });

  it('setTripOrigin: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:trip-origin',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setTripOrigin(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:trip-origin');
  });

  it('setTripOrigin: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));

    const { setTripOrigin } = useDestinationStore.getState();
    setTripOrigin(mockStation);
    await new Promise((r) => setTimeout(r, 0));

    setTripOrigin(null);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('loadTripOrigin: AsyncStorage에서 영속화된 origin을 복원한다 (cold restart 회복)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:trip-origin');
    expect(useDestinationStore.getState().tripOrigin?.id).toBe('2-022');
  });

  it('loadTripOrigin: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  it('loadTripOrigin: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadTripOrigin } = useDestinationStore.getState();
    await loadTripOrigin();

    expect(useDestinationStore.getState().tripOrigin).toBeNull();
  });

  // ── routePreference ──

  it('초기 routePreference는 optimal이다', () => {
    const { routePreference } = useDestinationStore.getState();
    expect(routePreference).toBe('optimal');
  });

  it('setRoutePreference: 상태를 업데이트한다', async () => {
    const { setRoutePreference } = useDestinationStore.getState();
    await setRoutePreference('minTransfer');
    expect(useDestinationStore.getState().routePreference).toBe('minTransfer');
  });

  it('setRoutePreference: AsyncStorage에 저장한다', async () => {
    const { setRoutePreference } = useDestinationStore.getState();
    await setRoutePreference('minTransfer');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:route-preference',
      JSON.stringify('minTransfer'),
    );
  });

  it('loadRoutePreference: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('minTransfer'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('minTransfer');
  });

  it('loadRoutePreference: 유효하지 않은 값이면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('invalid'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage가 비어있으면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage 오류 시 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useDestinationStore.getState().loadRoutePreference();
    expect(useDestinationStore.getState().routePreference).toBe('optimal');
  });

  // ── setDestination cross-feature cleanup (alarmEvent + dismissSilence) ──

  it('setDestination 으로 새 destination 설정 시 dismissSilence는 즉시 클리어', async () => {
    await useAlarmEventStore.getState().setDismissSilence(1, { lat: 0, lng: 0 });
    expect(useAlarmEventStore.getState().dismissSilence).not.toBeNull();
    // 새 destination 진입 (switch).
    useDestinationStore.getState().setDestination(mockStation);
    expect(useAlarmEventStore.getState().dismissSilence).toBeNull();
  });

  it('setDestination: 같은 destination 재설정(isSwitch=false)이면 dismissSilence 유지', async () => {
    useDestinationStore.setState({ destination: mockStation });
    await useAlarmEventStore.getState().setDismissSilence(1, { lat: 0, lng: 0 });
    // 같은 destination 재설정 — storage clear 분기는 미실행.
    useDestinationStore.getState().setDestination(mockStation);
    expect(useAlarmEventStore.getState().dismissSilence).toEqual({
      sinceTs: 1,
      sinceLat: 0,
      sinceLng: 0,
    });
  });
});
