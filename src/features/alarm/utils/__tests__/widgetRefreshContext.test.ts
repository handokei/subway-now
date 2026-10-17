/**
 * #1935 — silent push handler가 widget update 시 필요한 BG 컨텍스트(destination/route/bgStation)를
 * 1회 read로 묶어주는 helper 검증.
 *
 * AsyncStorage는 mock해 storage 결과별 narrow 분기 검증.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { readWidgetRefreshContext } from '../widgetRefreshContext';
import {
  BG_LAST_STATION_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../../shared/constants/storageKeys';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';

const destination: Station = {
  id: '0220',
  name: '잠실',
  line: '2',
  lineColor: '#009933',
  lat: 37.513,
  lng: 127.1,
};

const bgStation: Station = {
  id: '0226',
  name: '역삼',
  line: '2',
  lineColor: '#009933',
  lat: 37.5,
  lng: 127.04,
};

const directRoute: Route = { type: 'direct', line: '2', stops: 3, travelSeconds: 240 };

function setupStorage(values: Partial<Record<string, string | null>>): void {
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
    return values[key] ?? null;
  });
}

describe('readWidgetRefreshContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('모두 정상이면 3개 필드 채워서 반환', async () => {
    const bg = { station: bgStation, distanceKm: 0.15, timestamp: 1_700_000_000_000 };
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [ROUTE_KEY]: JSON.stringify(directRoute),
      [BG_LAST_STATION_KEY]: JSON.stringify(bg),
    });
    const result = await readWidgetRefreshContext();
    expect(result.destination).toEqual(destination);
    expect(result.route).toEqual(directRoute);
    expect(result.bgContext).toEqual(bg);
  });

  it('모두 null이면 모두 null 필드로 반환', async () => {
    setupStorage({});
    const result = await readWidgetRefreshContext();
    expect(result.destination).toBeNull();
    expect(result.route).toBeNull();
    expect(result.bgContext).toBeNull();
  });

  describe('destination narrow', () => {
    it('손상 JSON → null', async () => {
      setupStorage({ [DESTINATION_KEY]: '{{ broken' });
      const result = await readWidgetRefreshContext();
      expect(result.destination).toBeNull();
    });

    it('id 부재 → null', async () => {
      setupStorage({ [DESTINATION_KEY]: JSON.stringify({ name: 'x' }) });
      const result = await readWidgetRefreshContext();
      expect(result.destination).toBeNull();
    });
  });

  describe('route narrow', () => {
    it('손상 JSON → null', async () => {
      setupStorage({ [ROUTE_KEY]: '{{ broken' });
      const result = await readWidgetRefreshContext();
      expect(result.route).toBeNull();
    });
  });

  describe('bgContext narrow', () => {
    it('손상 JSON → null', async () => {
      setupStorage({ [BG_LAST_STATION_KEY]: '{{ broken' });
      const result = await readWidgetRefreshContext();
      expect(result.bgContext).toBeNull();
    });

    it('distanceKm 비-number → null', async () => {
      setupStorage({
        [BG_LAST_STATION_KEY]: JSON.stringify({
          station: bgStation,
          distanceKm: 'not-a-number',
        }),
      });
      const result = await readWidgetRefreshContext();
      expect(result.bgContext).toBeNull();
    });

    it('station 부재 → null', async () => {
      setupStorage({ [BG_LAST_STATION_KEY]: JSON.stringify({ distanceKm: 0.1 }) });
      const result = await readWidgetRefreshContext();
      expect(result.bgContext).toBeNull();
    });

    it('parsed 자체가 비-object(예: number) → null', async () => {
      setupStorage({ [BG_LAST_STATION_KEY]: '42' });
      const result = await readWidgetRefreshContext();
      expect(result.bgContext).toBeNull();
    });
  });

  it('AsyncStorage throw → 모두 null (graceful)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('IO'));
    const result = await readWidgetRefreshContext();
    expect(result).toEqual({
      destination: null,
      route: null,
      bgContext: null,
    });
  });
});
