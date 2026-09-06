import AsyncStorage from '@react-native-async-storage/async-storage';
import { getBgHopWindowStation, setBgHopWindowStation } from '../hopWindowState';
import { BG_HOP_WINDOW_STATION_KEY } from '../../../../shared/constants/storageKeys';
import type { Station } from '../../../../shared/types/station';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const station: Station = {
  id: 'station-1',
  name: '강남',
  line: '2',
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};

describe('hopWindowState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getBgHopWindowStation', () => {
    it('AsyncStorage가 null이면 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(BG_HOP_WINDOW_STATION_KEY);
    });

    it('destinationId가 일치하면 저장된 station을 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', station }),
      );
      expect(await getBgHopWindowStation('dest-1')).toEqual(station);
    });

    it('destinationId가 다르면(새 trip) stale로 간주해 null 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', station }),
      );
      expect(await getBgHopWindowStation('dest-2')).toBeNull();
    });

    it('파싱 실패 시 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
    });

    it('destinationId 누락된 record는 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ station }));
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
    });

    it('station 필드가 station 형태가 아니면 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', station: { name: '강남' } }),
      );
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
    });

    it('record가 object가 아니면 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify('string-value'));
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
    });

    it('AsyncStorage 예외 시 graceful null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      expect(await getBgHopWindowStation('dest-1')).toBeNull();
    });
  });

  describe('setBgHopWindowStation', () => {
    it('destinationId + station을 JSON으로 저장한다', async () => {
      await setBgHopWindowStation('dest-1', station);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        BG_HOP_WINDOW_STATION_KEY,
        JSON.stringify({ destinationId: 'dest-1', station }),
      );
    });

    it('AsyncStorage 예외 시 silent (throw 안 함)', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(setBgHopWindowStation('dest-1', station)).resolves.toBeUndefined();
    });
  });
});
