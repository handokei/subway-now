import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFavoritesStore } from '../useFavoritesStore';
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

describe('useFavoritesStore', () => {
  beforeEach(() => {
    useFavoritesStore.setState({ favorites: [] });
    jest.clearAllMocks();
  });

  it('초기 즐겨찾기 목록은 비어있다', () => {
    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('즐겨찾기를 추가하면 목록에 추가된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBeUndefined();
  });

  it('addFavorite: label과 함께 추가하면 entry에 label이 저장된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation, { label: '집' });

    const { favorites } = useFavoritesStore.getState();
    expect(favorites[0].label).toBe('집');
  });

  it('addFavorite: 빈 문자열 label은 무시한다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation, { label: '' });

    const { favorites } = useFavoritesStore.getState();
    expect(favorites[0].label).toBeUndefined();
  });

  it('동일한 역을 중복 추가해도 한 번만 저장된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
  });

  it('즐겨찾기를 삭제하면 목록에서 제거된다', async () => {
    const { addFavorite, removeFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await removeFavorite(mockStation.id);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('존재하지 않는 역 삭제 시 목록이 변하지 않는다', async () => {
    const { addFavorite, removeFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await removeFavorite('non-existent-id');

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
  });

  it('addFavorite 호출 시 AsyncStorage에 FavoriteEntry로 저장한다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation, role: 'general' }]),
    );
  });

  it('removeFavorite 호출 시 AsyncStorage에 저장한다', async () => {
    const { addFavorite, removeFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation2);
    await removeFavorite(mockStation.id);

    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation2, role: 'general' }]),
    );
  });

  it('setFavoriteLabel: label 설정 시 entry가 업데이트되고 저장된다', async () => {
    const { addFavorite, setFavoriteLabel } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await setFavoriteLabel(mockStation.id, '회사');

    const { favorites } = useFavoritesStore.getState();
    expect(favorites[0].label).toBe('회사');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(
      'subway-now:favorites',
      JSON.stringify([{ station: mockStation, role: 'general', label: '회사' }]),
    );
  });

  it('setFavoriteLabel: 빈 문자열/공백/undefined 입력 시 label을 제거한다', async () => {
    const { addFavorite, setFavoriteLabel } = useFavoritesStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setFavoriteLabel(mockStation.id, '   ');

    let { favorites } = useFavoritesStore.getState();
    expect(favorites[0].label).toBeUndefined();

    await setFavoriteLabel(mockStation.id, '집');
    favorites = useFavoritesStore.getState().favorites;
    expect(favorites[0].label).toBe('집');

    await setFavoriteLabel(mockStation.id, undefined);
    favorites = useFavoritesStore.getState().favorites;
    expect(favorites[0].label).toBeUndefined();
  });

  it('setFavoriteLabel: 매칭되지 않는 stationId는 무시한다', async () => {
    const { addFavorite, setFavoriteLabel } = useFavoritesStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setFavoriteLabel('non-existent', '회사');

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].label).toBe('집');
  });

  it('loadFavorites: AsyncStorage에서 FavoriteEntry[] 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([{ station: mockStation, label: '집' }]),
    );

    const { loadFavorites } = useFavoritesStore.getState();
    await loadFavorites();

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBe('집');
  });

  it('loadFavorites: 기존 Station[] 포맷을 FavoriteEntry[]로 마이그레이션한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([mockStation, mockStation2]),
    );

    const { loadFavorites } = useFavoritesStore.getState();
    await loadFavorites();

    const { favorites } = useFavoritesStore.getState();
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

    const { loadFavorites } = useFavoritesStore.getState();
    await loadFavorites();
    expect(useFavoritesStore.getState().favorites).toHaveLength(0);

    await loadFavorites();
    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(2);
    expect(favorites[0].station.id).toBe('2-022');
    expect(favorites[0].label).toBe('집');
    expect(favorites[1].station.id).toBe('2-021');
    expect(favorites[1].label).toBeUndefined();
  });

  it('addFavorite: role=home 옵션을 지정하면 home 슬롯으로 추가된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation, { role: 'home' });

    const { favorites } = useFavoritesStore.getState();
    expect(favorites[0].role).toBe('home');
  });

  it('addFavorite: role=home 추가 시 기존 general entry는 그대로 유지된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation);
    await addFavorite(mockStation2, { role: 'home' });

    const { favorites } = useFavoritesStore.getState();
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('addFavorite: 같은 슬롯에 다른 역을 지정하면 기존 슬롯은 general로 강등된다', async () => {
    const { addFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation, { role: 'home' });
    await addFavorite(mockStation2, { role: 'home' });

    const { favorites } = useFavoritesStore.getState();
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('setSlotFavorite: 처음 home 슬롯 지정 시 새 entry로 추가된다', async () => {
    const { setSlotFavorite } = useFavoritesStore.getState();
    await setSlotFavorite('home', mockStation);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].role).toBe('home');
    expect(favorites[0].station.id).toBe('2-022');
  });

  it('setSlotFavorite: 이미 즐겨찾기에 있는 역을 슬롯에 지정하면 role만 변경된다', async () => {
    const { addFavorite, setSlotFavorite } = useFavoritesStore.getState();
    await addFavorite(mockStation, { label: '집' });
    await setSlotFavorite('work', mockStation);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].role).toBe('work');
    expect(favorites[0].label).toBe('집');
  });

  it('setSlotFavorite: 다른 역이 이미 슬롯에 있으면 기존 entry는 general로 강등된다', async () => {
    const { setSlotFavorite } = useFavoritesStore.getState();
    await setSlotFavorite('home', mockStation);
    await setSlotFavorite('home', mockStation2);

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(2);
    expect(favorites.find((f) => f.station.id === mockStation.id)?.role).toBe('general');
    expect(favorites.find((f) => f.station.id === mockStation2.id)?.role).toBe('home');
  });

  it('setSlotFavorite: null 전달 시 슬롯이 비워지고 기존 entry는 general로 남는다', async () => {
    const { setSlotFavorite } = useFavoritesStore.getState();
    await setSlotFavorite('home', mockStation);
    await setSlotFavorite('home', null);

    const { favorites } = useFavoritesStore.getState();
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

    await useFavoritesStore.getState().loadFavorites();
    expect(useFavoritesStore.getState().favorites.map((f) => f.role)).toEqual(expectedRoles);
  });

  it('loadFavorites: AsyncStorage가 비어있으면 빈 배열을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const { loadFavorites } = useFavoritesStore.getState();
    await loadFavorites();

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(0);
  });

  it('loadFavorites: AsyncStorage 오류 시 빈 배열을 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));

    const { loadFavorites } = useFavoritesStore.getState();
    await loadFavorites();

    const { favorites } = useFavoritesStore.getState();
    expect(favorites).toHaveLength(0);
  });
});
