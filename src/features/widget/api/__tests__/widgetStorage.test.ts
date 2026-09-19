import { Platform } from 'react-native';
import { saveStationToWidget, clearWidgetStation, type WidgetTripContext } from '../widgetStorage';
import { Station } from '../../../../shared/types/station';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);
const mockSaveTripContext = jest.fn().mockResolvedValue(undefined);

jest.mock('live-activity', () => ({
  saveWidgetStation: (...args: unknown[]) => mockSave(...args),
  clearWidgetStation: () => mockClear(),
}));

// #1781 — saveWidgetTripContext는 requireOptionalNativeModule 직접 참조로 호출됨
jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => ({
    saveWidgetTripContext: (...args: unknown[]) => mockSaveTripContext(...args),
  }),
}));

const station: Station = {
  id: '2-001',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.4979,
  lng: 127.0276,
};

// #1781 — LiveActivityNative 모듈 레벨 분기: android 경로(LiveActivityNative=null) 커버
describe('widgetStorage (android — LiveActivityNative null 분기)', () => {
  it('Android에서는 LiveActivityNative가 null이고 모든 native 호출 없이 종료된다', async () => {
    const mockSaveAndroid = jest.fn().mockResolvedValue(undefined);
    let save: (s: Station, d: number) => Promise<void>;
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
      jest.doMock('expo-modules-core', () => ({
        requireOptionalNativeModule: () => null,
      }));
      jest.doMock('live-activity', () => ({
        saveWidgetStation: mockSaveAndroid,
        clearWidgetStation: jest.fn().mockResolvedValue(undefined),
      }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../widgetStorage') as { saveStationToWidget: typeof save };
      save = mod.saveStationToWidget;
    });
    const androidStation: Station = {
      id: '2-001', name: '강남', line: '2', lineColor: '#009933', lat: 37.497, lng: 127.027,
    };
    await expect(save!(androidStation, 0.1)).resolves.toBeUndefined();
    // Platform.OS !== 'ios' → early return, no native calls
    expect(mockSaveAndroid).not.toHaveBeenCalled();
  });
});

describe('widgetStorage (native)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, 'OS', 'ios');
    // 모듈 스코프 dedupe 캐시 리셋
    await clearWidgetStation();
    mockClear.mockClear();
    mockSaveTripContext.mockClear();
  });

  describe('saveStationToWidget', () => {
    it('iOS에서 station 정보와 m 단위 거리, savedAt을 native 함수에 전달한다', async () => {
      const t = 1_700_000_000_000;
      await saveStationToWidget(station, 0.123, t);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 123, t);
    });

    it('savedAt 인자를 생략하면 Date.now()로 호출한다', async () => {
      const before = Date.now();
      await saveStationToWidget(station, 0.1);
      const after = Date.now();
      const [name, color, dist, savedAt] = mockSave.mock.calls[0];
      expect(name).toBe('강남');
      expect(color).toBe('#009933');
      expect(dist).toBe(100);
      expect(savedAt).toBeGreaterThanOrEqual(before);
      expect(savedAt).toBeLessThanOrEqual(after);
    });

    it('음수 거리는 0으로 보정된다', async () => {
      await saveStationToWidget(station, -0.5, 1);
      expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 0, 1);
    });

    it('iOS가 아니면 native 호출 없이 종료된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await saveStationToWidget(station, 0.1);
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('같은 역 + 같은 50m 버킷 + freshness 윈도우 내면 한 번만 native에 전달된다', async () => {
      // 100m, 120m, 149m → 모두 bucket 2 (100~149m)
      const t = 1_700_000_000_000;
      await saveStationToWidget(station, 0.1, t);
      await saveStationToWidget(station, 0.12, t + 1_000);
      await saveStationToWidget(station, 0.149, t + 2_000);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('같은 역/버킷이라도 5분이 지나면 savedAt 갱신을 위해 다시 전달된다', async () => {
      const t = 1_700_000_000_000;
      await saveStationToWidget(station, 0.1, t);
      // 5분 + 1ms 이후
      await saveStationToWidget(station, 0.1, t + 5 * 60 * 1000 + 1);
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave).toHaveBeenNthCalledWith(2, '강남', '#009933', 100, t + 5 * 60 * 1000 + 1);
    });

    it('같은 역이라도 50m 버킷이 바뀌면 다시 전달된다', async () => {
      const t = 1_700_000_000_000;
      await saveStationToWidget(station, 0.5, t); // bucket 10 (500m)
      await saveStationToWidget(station, 0.45, t); // bucket 9 (450m)
      await saveStationToWidget(station, 0.03, t); // bucket 0 (30m)
      expect(mockSave).toHaveBeenCalledTimes(3);
      expect(mockSave).toHaveBeenNthCalledWith(1, '강남', '#009933', 500, t);
      expect(mockSave).toHaveBeenNthCalledWith(2, '강남', '#009933', 450, t);
      expect(mockSave).toHaveBeenNthCalledWith(3, '강남', '#009933', 30, t);
    });

    it('역이 바뀌면 다시 native에 전달된다', async () => {
      const other: Station = { ...station, id: '2-002', name: '역삼' };
      await saveStationToWidget(station, 0.1, 1);
      await saveStationToWidget(other, 0.1, 1);
      expect(mockSave).toHaveBeenCalledTimes(2);
    });

    it('clearWidgetStation 이후엔 같은 역/같은 버킷도 다시 전달된다', async () => {
      await saveStationToWidget(station, 0.1, 1);
      await clearWidgetStation();
      await saveStationToWidget(station, 0.1, 1);
      expect(mockSave).toHaveBeenCalledTimes(2);
    });

    // #1781 — tripContext 전달 시 saveWidgetTripContext로 trip 맥락 별도 write
    describe('#1781 — tripContext', () => {
      const tripFull: WidgetTripContext = {
        currentStationName: '강남',
        destinationName: '잠실',
        nextTransferName: '건대입구',
        tripActive: true,
      };

      const tripDirect: WidgetTripContext = {
        currentStationName: '강남',
        destinationName: '잠실',
        tripActive: true,
      };

      it('trip 활성 + 환승 있음: saveWidgetTripContext에 currentStation/destination/nextTransfer/tripActive 전달', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t, undefined, tripFull);
        expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 100, t);
        expect(mockSaveTripContext).toHaveBeenCalledWith('강남', '잠실', '건대입구', true);
      });

      it('trip 활성 + 직통(환승 없음): nextTransferName=null', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t, undefined, tripDirect);
        expect(mockSaveTripContext).toHaveBeenCalledWith('강남', '잠실', null, true);
      });

      it('tripContext 미전달(trip 비활성): saveWidgetTripContext에 null/false 전달 (backward compat)', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t);
        expect(mockSave).toHaveBeenCalledWith('강남', '#009933', 100, t);
        expect(mockSaveTripContext).toHaveBeenCalledWith(null, null, null, false);
      });

      it('dedupe 게이트에 걸려 save가 skip되면 saveWidgetTripContext도 skip된다', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t, undefined, tripFull);
        // 같은 역/bucket, freshness 윈도우 내 → skip
        await saveStationToWidget(station, 0.1, t + 1_000, undefined, tripFull);
        expect(mockSave).toHaveBeenCalledTimes(1);
        expect(mockSaveTripContext).toHaveBeenCalledTimes(1);
      });
    });

    // R9-a (#1612) — force 옵션 시 module-level dedupe 우회. AppState 'active' 복귀 시 위젯 FG stale 차단.
    describe('R9-a (#1612) — options.force', () => {
      it('force=true면 같은 역+버킷+freshness 윈도우 내에서도 native 호출', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t);
        await saveStationToWidget(station, 0.1, t + 1_000, { force: true });
        // 첫 호출(통과) + force(통과) = 총 2회
        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenNthCalledWith(2, '강남', '#009933', 100, t + 1_000);
      });

      it('force=false (명시) → 기존 dedupe 동작 그대로', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t);
        await saveStationToWidget(station, 0.1, t + 1_000, { force: false });
        expect(mockSave).toHaveBeenCalledTimes(1);
      });

      it('force=true 호출 후 dedupe key/savedAt 갱신 — 후속 정상 호출이 같은 bucket이면 dedupe', async () => {
        const t = 1_700_000_000_000;
        await saveStationToWidget(station, 0.1, t, { force: true });
        await saveStationToWidget(station, 0.1, t + 1_000);
        // force 1회 + 후속 dedupe skip = 총 1회
        expect(mockSave).toHaveBeenCalledTimes(1);
      });

      it('iOS가 아니면 force=true 여도 native 호출 없음 (Platform 가드 보존)', async () => {
        jest.replaceProperty(Platform, 'OS', 'android');
        await saveStationToWidget(station, 0.1, 1, { force: true });
        expect(mockSave).not.toHaveBeenCalled();
      });
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
