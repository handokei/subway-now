import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppStore } from '../useAppStore';
import { Station } from '../../types/station';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const mockStation2: Station = {
  id: '2-021',
  name: '역삼',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5006,
  lng: 127.0365,
};

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState({ favorites: [], destination: null, recentDestination: null, sleepMode: false, customOrigin: null, alarmEvent: null });
    jest.clearAllMocks();
  });

  it('초기 즐겨찾기 목록은 비어있다', () => {
    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('즐겨찾기를 추가하면 목록에 추가된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].id).toBe('2-022');
  });

  it('동일한 역을 중복 추가해도 한 번만 저장된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
  });

  it('즐겨찾기를 삭제하면 목록에서 제거된다', async () => {
    const { addFavorite, removeFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await removeFavorite(mockStation.id);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('존재하지 않는 역 삭제 시 목록이 변하지 않는다', async () => {
    const { addFavorite, removeFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await removeFavorite('non-existent-id');

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
  });

  it('addFavorite 호출 시 AsyncStorage에 저장한다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:favorites',
      JSON.stringify([mockStation])
    );
  });

  it('removeFavorite 호출 시 AsyncStorage에 저장한다', async () => {
    const { addFavorite, removeFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation2);
    await removeFavorite(mockStation.id);

    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:favorites',
      JSON.stringify([mockStation2])
    );
  });

  it('loadFavorites: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([mockStation])
    );

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].id).toBe('2-022');
  });

  it('loadFavorites: AsyncStorage가 비어있으면 빈 배열을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('loadFavorites: AsyncStorage 오류 시 빈 배열을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('초기 목적지는 null이다', () => {
    const { destination } = useAppStore.getState();
    expect(destination).toBeNull();
  });

  it('setDestination: 목적지를 설정하면 상태가 업데이트된다', () => {
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);

    const { destination } = useAppStore.getState();
    expect(destination?.id).toBe('2-022');
  });

  it('setDestination: null을 설정하면 목적지가 초기화된다', () => {
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    setDestination(null);

    const { destination } = useAppStore.getState();
    expect(destination).toBeNull();
  });

  it('setDestination: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:destination',
      JSON.stringify(mockStation),
    );

    jest.clearAllMocks();
    setDestination(null);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:destination');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:fired-alarms');
  });

  it('setDestination: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));

    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    // catch(noop)로 에러가 무시되므로 에러가 던져지지 않아야 한다
    await new Promise((r) => setTimeout(r, 0));

    setDestination(null);
    await new Promise((r) => setTimeout(r, 0));
    // 에러 없이 완료
  });

  it('초기 recentDestination은 null이다', () => {
    const { recentDestination } = useAppStore.getState();
    expect(recentDestination).toBeNull();
  });

  it('setRecentDestination: 역을 설정하면 상태가 업데이트된다', () => {
    const { setRecentDestination } = useAppStore.getState();
    setRecentDestination(mockStation);

    const { recentDestination } = useAppStore.getState();
    expect(recentDestination?.id).toBe('2-022');
  });

  it('setRecentDestination: null을 설정하면 초기화된다', () => {
    const { setRecentDestination } = useAppStore.getState();
    setRecentDestination(mockStation);
    setRecentDestination(null);

    const { recentDestination } = useAppStore.getState();
    expect(recentDestination).toBeNull();
  });

  it('초기 sleepMode는 false이다', () => {
    const { sleepMode } = useAppStore.getState();
    expect(sleepMode).toBe(false);
  });

  it('setSleepMode: true를 설정하면 상태가 업데이트된다', async () => {
    const { setSleepMode } = useAppStore.getState();
    await setSleepMode(true);

    const { sleepMode } = useAppStore.getState();
    expect(sleepMode).toBe(true);
  });

  it('setSleepMode: AsyncStorage에 저장한다', async () => {
    const { setSleepMode } = useAppStore.getState();
    await setSleepMode(true);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:sleep-mode',
      JSON.stringify(true)
    );
  });

  it('loadSleepMode: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));

    const { loadSleepMode } = useAppStore.getState();
    await loadSleepMode();

    const { sleepMode } = useAppStore.getState();
    expect(sleepMode).toBe(true);
  });

  it('loadSleepMode: AsyncStorage가 비어있으면 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadSleepMode } = useAppStore.getState();
    await loadSleepMode();

    const { sleepMode } = useAppStore.getState();
    expect(sleepMode).toBe(false);
  });

  it('loadSleepMode: AsyncStorage 오류 시 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadSleepMode } = useAppStore.getState();
    await loadSleepMode();

    const { sleepMode } = useAppStore.getState();
    expect(sleepMode).toBe(false);
  });

  it('초기 customOrigin은 null이다', () => {
    const { customOrigin } = useAppStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 출발역을 설정하면 상태가 업데이트된다', () => {
    const { setCustomOrigin } = useAppStore.getState();
    setCustomOrigin(mockStation);

    const { customOrigin } = useAppStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('setCustomOrigin: null을 설정하면 출발역이 초기화된다', () => {
    const { setCustomOrigin } = useAppStore.getState();
    setCustomOrigin(mockStation);
    setCustomOrigin(null);

    const { customOrigin } = useAppStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('setCustomOrigin: 역 설정 시 AsyncStorage에 저장하고 null 시 삭제한다', () => {
    const { setCustomOrigin } = useAppStore.getState();
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

    const { setCustomOrigin } = useAppStore.getState();
    setCustomOrigin(mockStation);
    await new Promise((r) => setTimeout(r, 0));

    setCustomOrigin(null);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('loadCustomOrigin: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadCustomOrigin } = useAppStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useAppStore.getState();
    expect(customOrigin?.id).toBe('2-022');
  });

  it('loadCustomOrigin: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadCustomOrigin } = useAppStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useAppStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('loadCustomOrigin: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadCustomOrigin } = useAppStore.getState();
    await loadCustomOrigin();

    const { customOrigin } = useAppStore.getState();
    expect(customOrigin).toBeNull();
  });

  it('초기 alarmEvent는 null이다', () => {
    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
  });

  it('setAlarmEvent: 알람 이벤트를 설정한다', () => {
    const { setAlarmEvent } = useAppStore.getState();
    setAlarmEvent({ type: 'destination', stationName: '강남' });

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toEqual({ type: 'destination', stationName: '강남' });
  });

  it('clearAlarmEvent: 알람 이벤트를 초기화하고 AsyncStorage도 정리한다', () => {
    const { setAlarmEvent, clearAlarmEvent } = useAppStore.getState();
    setAlarmEvent({ type: 'transfer', stationName: '역삼' });
    clearAlarmEvent();

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  it('loadAlarmEvent: AsyncStorage에서 알람 이벤트를 복원하고 제거한다', async () => {
    const event = { type: 'destination' as const, stationName: '강남' };
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(event));

    const { loadAlarmEvent } = useAppStore.getState();
    await loadAlarmEvent();

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toEqual(event);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  it('loadAlarmEvent: AsyncStorage가 비어있으면 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadAlarmEvent } = useAppStore.getState();
    await loadAlarmEvent();

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
  });

  it('loadAlarmEvent: AsyncStorage 오류 시 null을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadAlarmEvent } = useAppStore.getState();
    await loadAlarmEvent();

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
  });
});
