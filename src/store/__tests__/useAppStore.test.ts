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
    useAppStore.setState({ favorites: [], destination: null, recentDestination: null, sleepMode: false, allowSpeaker: true, customOrigin: null, themeMode: 'auto', routePreference: 'optimal', localePreference: 'auto', alarmEvent: null, debugVisible: false, accessibilityMode: false });
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
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBeUndefined();
  });

  it('addFavorite: label과 함께 추가하면 entry에 label이 저장된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation, { label: '집' });

    const { favorites } = useAppStore.getState();
    expect(favorites[0].label).toBe('집');
  });

  it('addFavorite: 빈 문자열 label은 무시한다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation, { label: '' });

    const { favorites } = useAppStore.getState();
    expect(favorites[0].label).toBeUndefined();
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

  it('addFavorite 호출 시 AsyncStorage에 FavoriteEntry로 저장한다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation, role: 'general' }])
    );
  });

  it('removeFavorite 호출 시 AsyncStorage에 저장한다', async () => {
    const { addFavorite, removeFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation2);
    await removeFavorite(mockStation.id);

    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation2, role: 'general' }])
    );
  });

  it('setFavoriteLabel: label 설정 시 entry가 업데이트되고 저장된다', async () => {
    const { addFavorite, setFavoriteLabel } = useAppStore.getState();
    await addFavorite(mockStation);
    await setFavoriteLabel(mockStation.id, '회사');

    const { favorites } = useAppStore.getState();
    expect(favorites[0].label).toBe('회사');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation, role: 'general', label: '회사' }])
    );
  });

  it('setFavoriteLabel: 빈 문자열/공백/undefined 입력 시 label을 제거한다', async () => {
    const { addFavorite, setFavoriteLabel } = useAppStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setFavoriteLabel(mockStation.id, '   ');

    let { favorites } = useAppStore.getState();
    expect(favorites[0].label).toBeUndefined();

    await setFavoriteLabel(mockStation.id, '집');
    favorites = useAppStore.getState().favorites;
    expect(favorites[0].label).toBe('집');

    await setFavoriteLabel(mockStation.id, undefined);
    favorites = useAppStore.getState().favorites;
    expect(favorites[0].label).toBeUndefined();
  });

  it('setFavoriteLabel: 매칭되지 않는 stationId는 무시한다', async () => {
    const { addFavorite, setFavoriteLabel } = useAppStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setFavoriteLabel('non-existent', '회사');

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].label).toBe('집');
  });

  it('loadFavorites: AsyncStorage에서 FavoriteEntry[] 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([{ station: mockStation, label: '집' }])
    );

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBe('집');
  });

  it('loadFavorites: 기존 Station[] 포맷을 FavoriteEntry[]로 마이그레이션한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([mockStation, mockStation2])
    );

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(2);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBeUndefined();
    expect(favorites[1].station.id).toBe('2-021');
  });

  it('loadFavorites: 배열이 아니거나 잘못된 항목은 건너뛴다', async () => {
    (AsyncStorage.getItem as jest.Mock)
      .mockResolvedValueOnce(JSON.stringify({ not: 'array' }))
      .mockResolvedValueOnce(
        JSON.stringify([
          null,
          { random: 'object' },
          { station: null },
          { station: { lat: 1, lng: 2 } }, // id 없음
          { id: 42 }, // 잘못된 id 타입
          { station: mockStation, label: '집' },
          { station: mockStation2 }, // label 없는 FavoriteEntry
        ]),
      );

    const { loadFavorites } = useAppStore.getState();
    await loadFavorites();
    expect(useAppStore.getState().favorites).toHaveLength(0);

    await loadFavorites();
    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(2);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBe('집');
    expect(favorites[1].station.id).toBe('2-021');
    expect(favorites[1].label).toBeUndefined();
  });

  it('addFavorite: role=home 옵션을 지정하면 home 슬롯으로 추가된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation, { role: 'home' });

    const { favorites } = useAppStore.getState();
    expect(favorites[0].role).toBe('home');
  });

  it('addFavorite: role=home 추가 시 기존 general entry는 그대로 유지된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation2, { role: 'home' });

    const { favorites } = useAppStore.getState();
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('addFavorite: 같은 슬롯에 다른 역을 지정하면 기존 슬롯은 general로 강등된다', async () => {
    const { addFavorite } = useAppStore.getState();
    await addFavorite(mockStation, { role: 'home' });
    await addFavorite(mockStation2, { role: 'home' });

    const { favorites } = useAppStore.getState();
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('setSlotFavorite: 처음 home 슬롯 지정 시 새 entry로 추가된다', async () => {
    const { setSlotFavorite } = useAppStore.getState();
    await setSlotFavorite('home', mockStation);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].role).toBe('home');
    expect(favorites[0].station.id).toBe('2-022');
  });

  it('setSlotFavorite: 이미 즐겨찾기에 있는 역을 슬롯에 지정하면 role만 변경된다', async () => {
    const { addFavorite, setSlotFavorite } = useAppStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setSlotFavorite('work', mockStation);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].role).toBe('work');
    expect(favorites[0].label).toBe('집');
  });

  it('setSlotFavorite: 다른 역이 이미 슬롯에 있으면 기존 entry는 general로 강등된다', async () => {
    const { setSlotFavorite } = useAppStore.getState();
    await setSlotFavorite('home', mockStation);
    await setSlotFavorite('home', mockStation2);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(2);
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('setSlotFavorite: null 전달 시 슬롯이 비워지고 기존 entry는 general로 남는다', async () => {
    const { setSlotFavorite } = useAppStore.getState();
    await setSlotFavorite('home', mockStation);
    await setSlotFavorite('home', null);

    const { favorites } = useAppStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].role).toBe('general');
  });

  it.each([
    {
      label: 'home/work role 보존',
      stored: [
        { station: '2-022', role: 'home' as const },
        { station: '2-021', role: 'work' as const },
      ],
      expectedRoles: ['home', 'work'],
    },
    {
      label: '잘못된 role은 general로 정규화',
      stored: [{ station: '2-022', role: 'invalid' as unknown as 'general' }],
      expectedRoles: ['general'],
    },
    {
      label: '동일 슬롯 중복은 first-wins (나머지는 general 강등)',
      stored: [
        { station: '2-022', role: 'home' as const },
        { station: '2-021', role: 'home' as const },
      ],
      expectedRoles: ['home', 'general'],
    },
  ])('loadFavorites: $label', async ({ stored, expectedRoles }) => {
    const stationsById: Record<string, typeof mockStation> = {
      '2-022': mockStation,
      '2-021': mockStation2,
    };
    const payload = stored.map(({ station, role }) => ({ station: stationsById[station], role }));
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(payload));

    await useAppStore.getState().loadFavorites();
    expect(useAppStore.getState().favorites.map((f) => f.role)).toEqual(expectedRoles);
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
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:route');
  });

  it('setDestination(#702): 목적지 switch 시 부수 storage(customOrigin/lock/scheduled/active-trip) 자동 클리어', () => {
    const { setDestination } = useAppStore.getState();
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
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    setDestination(null);

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:active-trip');
  });

  it('setDestination(#702): 같은 목적지 재설정 시에는 부수 storage를 건드리지 않는다', () => {
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    jest.clearAllMocks();

    // 동일 station id 재설정 — switch 아님
    setDestination(mockStation);

    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:custom-origin');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:boarding-lock');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:scheduled-notifications');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:active-trip');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:fired-alarms');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('subway-now:route');
  });

  it('setDestination(#702): switch 시 customOrigin 메모리 state도 null로 동기화', () => {
    const { setDestination, setCustomOrigin } = useAppStore.getState();
    setDestination(mockStation);
    setCustomOrigin(mockStation2);
    expect(useAppStore.getState().customOrigin?.id).toBe('2-021');

    setDestination(mockStation2);

    expect(useAppStore.getState().customOrigin).toBeNull();
  });

  it('setDestination(#702): loadDestination(hydration)은 부수 storage를 클리어하지 않는다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));
    jest.clearAllMocks();

    const { loadDestination } = useAppStore.getState();
    await loadDestination();

    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    expect(useAppStore.getState().destination?.id).toBe('2-022');
  });

  it('setDestination: AsyncStorage 실패 시에도 에러를 던지지 않는다', async () => {
    const setItemImpl = (AsyncStorage.setItem as jest.Mock).getMockImplementation();
    const removeItemImpl = (AsyncStorage.removeItem as jest.Mock).getMockImplementation();
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('저장 실패'));
    // setDestination(null) switch는 DESTINATION_KEY/fired/route/customOrigin/lock/scheduled/active-trip = 7 removeItem
    for (let i = 0; i < 8; i++) {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('삭제 실패'));
    }

    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    // catch(noop)로 에러가 무시되므로 에러가 던져지지 않아야 한다
    await new Promise((r) => setTimeout(r, 0));

    setDestination(null);
    await new Promise((r) => setTimeout(r, 0));
    // 에러 없이 완료 — implementation 복원 (다른 테스트 영향 방지)
    (AsyncStorage.setItem as jest.Mock).mockImplementation(setItemImpl);
    (AsyncStorage.removeItem as jest.Mock).mockImplementation(removeItemImpl);
  });

  it('loadDestination: AsyncStorage에 저장된 목적지를 상태로 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(mockStation));

    const { loadDestination } = useAppStore.getState();
    await loadDestination();

    expect(AsyncStorage.getItem).toHaveBeenCalledWith('subway-now:destination');
    expect(useAppStore.getState().destination?.id).toBe('2-022');
  });

  it('loadDestination: 저장된 값이 없으면 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadDestination } = useAppStore.getState();
    await loadDestination();

    expect(useAppStore.getState().destination).toBeNull();
  });

  it('loadDestination: AsyncStorage 실패 시 destination이 null로 유지된다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('읽기 실패'));

    const { loadDestination } = useAppStore.getState();
    await loadDestination();

    expect(useAppStore.getState().destination).toBeNull();
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

  it('초기 themeMode는 auto이다', () => {
    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('auto');
  });

  it('setThemeMode: 테마 모드를 설정하면 상태가 업데이트된다', async () => {
    const { setThemeMode } = useAppStore.getState();
    await setThemeMode('dark');

    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('dark');
  });

  it('setThemeMode: AsyncStorage에 저장한다', async () => {
    const { setThemeMode } = useAppStore.getState();
    await setThemeMode('light');

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:theme-mode',
      JSON.stringify('light'),
    );
  });

  it('loadThemeMode: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('dark'));

    const { loadThemeMode } = useAppStore.getState();
    await loadThemeMode();

    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('dark');
  });

  it('loadThemeMode: 유효하지 않은 값이면 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('invalid'));

    const { loadThemeMode } = useAppStore.getState();
    await loadThemeMode();

    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('auto');
  });

  it('loadThemeMode: AsyncStorage가 비어있으면 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadThemeMode } = useAppStore.getState();
    await loadThemeMode();

    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('auto');
  });

  it('loadThemeMode: AsyncStorage 오류 시 auto를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadThemeMode } = useAppStore.getState();
    await loadThemeMode();

    const { themeMode } = useAppStore.getState();
    expect(themeMode).toBe('auto');
  });

  it('초기 routePreference는 optimal이다', () => {
    const { routePreference } = useAppStore.getState();
    expect(routePreference).toBe('optimal');
  });

  it('setRoutePreference: 상태를 업데이트한다', async () => {
    const { setRoutePreference } = useAppStore.getState();
    await setRoutePreference('minTransfer');
    expect(useAppStore.getState().routePreference).toBe('minTransfer');
  });

  it('setRoutePreference: AsyncStorage에 저장한다', async () => {
    const { setRoutePreference } = useAppStore.getState();
    await setRoutePreference('minTransfer');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('subway-now:route-preference', JSON.stringify('minTransfer'));
  });

  it('loadRoutePreference: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('minTransfer'));
    await useAppStore.getState().loadRoutePreference();
    expect(useAppStore.getState().routePreference).toBe('minTransfer');
  });

  it('loadRoutePreference: 유효하지 않은 값이면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('invalid'));
    await useAppStore.getState().loadRoutePreference();
    expect(useAppStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage가 비어있으면 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useAppStore.getState().loadRoutePreference();
    expect(useAppStore.getState().routePreference).toBe('optimal');
  });

  it('loadRoutePreference: AsyncStorage 오류 시 optimal을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useAppStore.getState().loadRoutePreference();
    expect(useAppStore.getState().routePreference).toBe('optimal');
  });

  it('초기 allowSpeaker는 true이다', () => {
    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(true);
  });

  it('setAllowSpeaker: false를 설정하면 상태가 업데이트된다', async () => {
    const { setAllowSpeaker } = useAppStore.getState();
    await setAllowSpeaker(false);

    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(false);
  });

  it('setAllowSpeaker: AsyncStorage에 저장한다', async () => {
    const { setAllowSpeaker } = useAppStore.getState();
    await setAllowSpeaker(false);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:allow-speaker',
      JSON.stringify(false),
    );
  });

  it('loadAllowSpeaker: AsyncStorage에서 false를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(false));

    const { loadAllowSpeaker } = useAppStore.getState();
    await loadAllowSpeaker();

    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(false);
  });

  it('loadAllowSpeaker: AsyncStorage에서 true를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));

    const { loadAllowSpeaker } = useAppStore.getState();
    await loadAllowSpeaker();

    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(true);
  });

  it('loadAllowSpeaker: AsyncStorage가 비어있으면 true를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadAllowSpeaker } = useAppStore.getState();
    await loadAllowSpeaker();

    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(true);
  });

  it('loadAllowSpeaker: AsyncStorage 오류 시 true를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadAllowSpeaker } = useAppStore.getState();
    await loadAllowSpeaker();

    const { allowSpeaker } = useAppStore.getState();
    expect(allowSpeaker).toBe(true);
  });

  it('초기 accessibilityMode는 false다', () => {
    expect(useAppStore.getState().accessibilityMode).toBe(false);
  });

  it('setAccessibilityMode: 상태를 업데이트하고 AsyncStorage에 저장한다', async () => {
    await useAppStore.getState().setAccessibilityMode(true);
    expect(useAppStore.getState().accessibilityMode).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:accessibility-mode',
      JSON.stringify(true),
    );
  });

  it('loadAccessibilityMode: AsyncStorage에서 true를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));
    await useAppStore.getState().loadAccessibilityMode();
    expect(useAppStore.getState().accessibilityMode).toBe(true);
  });

  it('loadAccessibilityMode: AsyncStorage가 비어있으면 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useAppStore.getState().loadAccessibilityMode();
    expect(useAppStore.getState().accessibilityMode).toBe(false);
  });

  it('loadAccessibilityMode: AsyncStorage 오류 시 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useAppStore.getState().loadAccessibilityMode();
    expect(useAppStore.getState().accessibilityMode).toBe(false);
  });

  it('초기 alarmEvent는 null이다', () => {
    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
  });

  it('setAlarmEvent: 알람 이벤트를 설정한다', () => {
    const { setAlarmEvent } = useAppStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'destination', stationName: '강남' });

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
  });

  it('clearAlarmEvent: 알람 이벤트를 초기화하고 AsyncStorage도 정리한다', () => {
    const { setAlarmEvent, clearAlarmEvent } = useAppStore.getState();
    setAlarmEvent({ phaseId: 'early', type: 'transfer', stationName: '역삼' });
    clearAlarmEvent();

    const { alarmEvent } = useAppStore.getState();
    expect(alarmEvent).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:alarm-event');
  });

  it('loadAlarmEvent: AsyncStorage에서 알람 이벤트를 복원하고 제거한다', async () => {
    const event = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
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

  // ── localePreference ──

  it('초기 localePreference는 auto이다', () => {
    expect(useAppStore.getState().localePreference).toBe('auto');
  });

  it('setLocalePreference: 상태를 업데이트하고 AsyncStorage에 저장한다', async () => {
    await useAppStore.getState().setLocalePreference('en');
    expect(useAppStore.getState().localePreference).toBe('en');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:locale-preference',
      JSON.stringify('en'),
    );
  });

  it('loadLocalePreference: AsyncStorage에서 ko를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('ko'));
    await useAppStore.getState().loadLocalePreference();
    expect(useAppStore.getState().localePreference).toBe('ko');
  });

  it.each([
    ['invalid value', JSON.stringify('jp')],
    ['null', null],
    ['storage error', new Error('storage error')],
  ])('loadLocalePreference: %s이면 auto 유지', async (_label, raw) => {
    if (raw instanceof Error) {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(raw);
    } else {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(raw);
    }
    useAppStore.setState({ localePreference: 'auto' });
    await useAppStore.getState().loadLocalePreference();
    expect(useAppStore.getState().localePreference).toBe('auto');
  });

  // ── debugVisible ──

  it('초기 debugVisible은 false이다', () => {
    expect(useAppStore.getState().debugVisible).toBe(false);
  });

  it('setDebugVisible: 상태를 토글한다', () => {
    useAppStore.getState().setDebugVisible(true);
    expect(useAppStore.getState().debugVisible).toBe(true);
    useAppStore.getState().setDebugVisible(false);
    expect(useAppStore.getState().debugVisible).toBe(false);
  });
});
