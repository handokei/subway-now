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
    useAppStore.setState({ favorites: [], destination: null, recentDestination: null });
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

  it('isFavorite: 즐겨찾기 역은 true를 반환한다', async () => {
    const { addFavorite, isFavorite } = useAppStore.getState();
    await addFavorite(mockStation);

    expect(isFavorite(mockStation.id)).toBe(true);
  });

  it('isFavorite: 즐겨찾기 아닌 역은 false를 반환한다', () => {
    const { isFavorite } = useAppStore.getState();
    expect(isFavorite('non-existent')).toBe(false);
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

  it('setDestination: AsyncStorage를 호출하지 않는다', () => {
    const { setDestination } = useAppStore.getState();
    setDestination(mockStation);
    setDestination(null);

    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
      expect.stringContaining('destination'),
      expect.anything()
    );
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
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
});
