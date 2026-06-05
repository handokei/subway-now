import {
  lookupStationBySsid,
  __resetWifiSsidLookupCacheForTest,
} from '../wifiSsidLookup';

describe('lookupStationBySsid', () => {
  beforeEach(() => {
    __resetWifiSsidLookupCacheForTest();
  });

  describe('정상 매칭', () => {
    it.each([
      ['T_subway_용마산', '용마산'],
      ['T_subway_중곡', '중곡'],
      ['Olleh_Subway_강남', '강남'],
      ['U+Subway_왕십리', '왕십리'],
      ['Gangnam_Station', '강남'],
      ['Seoul_Station_Subway', '서울역'],
      ['Konkuk_Univ_AP_03', '건대입구'],
      ['CityHall_Subway_2F', '시청'],
      ['Express_Bus_Terminal_Wifi', '고속터미널'],
    ])('SSID "%s" → station "%s"', (ssid, expectedName) => {
      const result = lookupStationBySsid(ssid);
      expect(result).not.toBeNull();
      expect(result?.name).toBe(expectedName);
    });

    it('Station 객체에는 stations.json의 lat/lng가 포함된다', () => {
      const result = lookupStationBySsid('T_subway_용마산');
      expect(result).not.toBeNull();
      expect(typeof result?.lat).toBe('number');
      expect(typeof result?.lng).toBe('number');
      expect(result?.line).toBe('7');
    });

    it('대소문자 무시 매칭 — "t_SUBWAY_강남" 도 매칭된다', () => {
      const result = lookupStationBySsid('t_SUBWAY_강남');
      expect(result?.name).toBe('강남');
    });

    it('SSID 앞뒤 공백은 trim 처리한다', () => {
      const result = lookupStationBySsid('   T_subway_용마산   ');
      expect(result?.name).toBe('용마산');
    });

    it('한 entry의 첫 패턴이 안 맞아도 두 번째 패턴이 맞으면 매칭', () => {
      const result = lookupStationBySsid('Yongmasan_Free_Wifi');
      expect(result?.name).toBe('용마산');
    });

    it('이수 별칭 — "T_subway_총신대입구" SSID도 이수 entry로 매칭되며 canonical(총신대입구)로 정규화', () => {
      // STATION_ALIASES: 이수 → 총신대입구. JSON entry는 "이수"로 적혀 있지만
      // stations.json 매칭은 canonical 표기를 따른다.
      const result = lookupStationBySsid('T_subway_총신대입구');
      expect(result).not.toBeNull();
      expect(result?.name).toBe('총신대입구');
    });
  });

  describe('매칭 실패 / fallback', () => {
    it.each([
      ['', 'empty string'],
      ['   ', 'whitespace only'],
      ['random_home_wifi', 'unrelated SSID'],
      ['T_subway_없는역', 'pattern 자체는 맞지만 매핑 stationName이 없는 경우 — 실제로는 entries 없음'],
      ['iptime_5G_home', '가정용 공유기'],
      ['KT_GIGA_2G', '통신사 일반 SSID'],
    ])('SSID "%s" (%s) → null 반환', (ssid) => {
      expect(lookupStationBySsid(ssid)).toBeNull();
    });

    it('null/undefined 입력은 null 반환 (방어적)', () => {
      expect(lookupStationBySsid(null as unknown as string)).toBeNull();
      expect(lookupStationBySsid(undefined as unknown as string)).toBeNull();
    });

    it('JSON entry stationName이 stations.json에 없으면 null (정합성 보호)', () => {
      // findStationByName이 null을 반환하는 분기를 mock으로 강제 — 데이터 정합성 가드 검증.
      jest.isolateModules(() => {
        jest.doMock('../../../../shared/utils/stationLookup', () => ({
          findStationByName: () => null,
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../wifiSsidLookup');
        expect(mod.lookupStationBySsid('T_subway_용마산')).toBeNull();
      });
    });
  });

  describe('캐시 동작', () => {
    it('두 번째 호출도 같은 결과 — 캐시된 컴파일 정규식이 재사용된다', () => {
      const first = lookupStationBySsid('T_subway_용마산');
      const second = lookupStationBySsid('T_subway_용마산');
      expect(first?.name).toBe('용마산');
      expect(second?.name).toBe('용마산');
    });

    it('__resetWifiSsidLookupCacheForTest 호출 후에도 정상 동작', () => {
      lookupStationBySsid('T_subway_용마산'); // warm
      __resetWifiSsidLookupCacheForTest();
      const result = lookupStationBySsid('T_subway_용마산');
      expect(result?.name).toBe('용마산');
    });
  });
});
