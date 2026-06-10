import { Platform } from 'react-native';
import { saveStationToWidget, clearWidgetStation } from '../widgetStorage';
import { Station } from '../../../../shared/types/station';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../../../modules/live-activity', () => ({
  saveWidgetStation: (...args: unknown[]) => mockSave(...args),
  clearWidgetStation: () => mockClear(),
}));

const station: Station = {
  id: '2-001',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.4979,
  lng: 127.0276,
};

describe('widgetStorage (native)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, 'OS', 'ios');
    // 모듈 스코프 dedupe 캐시 리셋
    await clearWidgetStation();
    mockClear.mockClear();
  });

  describe('saveStationToWidget', () => {
    it('iOS에서 station 정보와 m 단위 거리로 native 함수를 호출한다', async () => {
      await saveStationToWidget(station, 0.123);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 123);
    });

    it('음수 거리는 0으로 보정된다', async () => {
      await saveStationToWidget(station, -0.5);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 0);
    });

    it('iOS가 아니면 native 호출 없이 종료된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await saveStationToWidget(station, 0.1);
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('같은 역 + 같은 50m 버킷이면 한 번만 native에 전달된다', async () => {
      // 100m, 120m, 149m → 모두 bucket 2 (100~149m)
      await saveStationToWidget(station, 0.1);
      await saveStationToWidget(station, 0.12);
      await saveStationToWidget(station, 0.149);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('같은 역이라도 50m 버킷이 바뀌면 다시 전달된다', async () => {
      await saveStationToWidget(station, 0.5); // bucket 10 (500m)
      await saveStationToWidget(station, 0.45); // bucket 9 (450m)
      await saveStationToWidget(station, 0.03); // bucket 0 (30m)
      expect(mockSave).toHaveBeenCalledTimes(3);
      expect(mockSave).toHaveBeenNthCalledWith(1, '강남', '#009933', 500);
      expect(mockSave).toHaveBeenNthCalledWith(2, '강남', '#009933', 450);
      expect(mockSave).toHaveBeenNthCalledWith(3, '강남', '#009933', 30);
    });

    it('역이 바뀌면 다시 native에 전달된다', async () => {
      const other: Station = { ...station, id: '2-002', name: '역삼' };
      await saveStationToWidget(station, 0.1);
      await saveStationToWidget(other, 0.1);
      expect(mockSave).toHaveBeenCalledTimes(2);
    });

    it('clearWidgetStation 이후엔 같은 역/같은 버킷도 다시 전달된다', async () => {
      await saveStationToWidget(station, 0.1);
      await clearWidgetStation();
      await saveStationToWidget(station, 0.1);
      expect(mockSave).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearWidgetStation', () => {
    it('iOS에서 native clear를 호출한다', async () => {
      await clearWidgetStation();
      expect(mockClear).toHaveBeenCalled();
    });

    it('iOS가 아니면 native 호출 없이 종료된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await clearWidgetStation();
      expect(mockClear).not.toHaveBeenCalled();
    });
  });
});
