import { buildWidgetTripContext } from '../buildTripContext';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type {
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../../../../shared/utils/stationRoute';

describe('buildWidgetTripContext (#1929 RC-15 widget tripContext wire helper)', () => {
  describe('null 분기 — trip 비활성', () => {
    it('destination null이면 undefined 반환 (호출자는 5th arg 그대로 forward)', () => {
      expect(
        buildWidgetTripContext({
          destination: null,
          currentStation: MOCK_STATIONS.gangnam,
        }),
      ).toBeUndefined();
    });

    it('currentStation null이면 undefined 반환 (안전 — current 없이 trip 표시 무의미)', () => {
      expect(
        buildWidgetTripContext({
          destination: MOCK_STATIONS.chungmuro,
          currentStation: null,
        }),
      ).toBeUndefined();
    });

    it('destination + currentStation 모두 null이면 undefined 반환', () => {
      expect(
        buildWidgetTripContext({
          destination: null,
          currentStation: null,
        }),
      ).toBeUndefined();
    });
  });

  describe('#1963 allowInactive 옵션 — silent push 채널 통합', () => {
    it('allowInactive: true + destination null → tripActive: false stamp 반환', () => {
      const result = buildWidgetTripContext({
        destination: null,
        currentStation: MOCK_STATIONS.gangnam,
        allowInactive: true,
      });
      expect(result).toEqual({
        currentStationName: '강남',
        destinationName: '',
        tripActive: false,
      });
    });

    it('allowInactive: true + currentStation null → undefined 반환 (안전 가드 유지)', () => {
      expect(
        buildWidgetTripContext({
          destination: null,
          currentStation: null,
          allowInactive: true,
        }),
      ).toBeUndefined();
    });

    it('allowInactive: true + destination 존재 → 기존 활성 분기와 동일 (영향 없음)', () => {
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        allowInactive: true,
      });
      expect(result).toEqual({
        currentStationName: '강남',
        destinationName: '충무로',
        nextTransferName: undefined,
        tripActive: true,
      });
    });
  });

  describe('활성 분기 — trip 활성 + tripActive: true stamp', () => {
    it('route undefined: nextTransferName undefined로 stamp', () => {
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
      });
      expect(result).toEqual({
        currentStationName: '강남',
        destinationName: '충무로',
        nextTransferName: undefined,
        tripActive: true,
      });
    });

    it('route null: nextTransferName undefined로 stamp', () => {
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        route: null,
      });
      expect(result).toEqual({
        currentStationName: '강남',
        destinationName: '충무로',
        nextTransferName: undefined,
        tripActive: true,
      });
    });

    it('직통 경로(direct): nextTransferName undefined', () => {
      const directRoute: DirectRoute = {
        type: 'direct',
        stops: 5,
        line: '2',
        travelSeconds: 600,
      };
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        route: directRoute,
      });
      expect(result?.nextTransferName).toBeUndefined();
      expect(result?.tripActive).toBe(true);
    });

    it('환승 1회(transfer): route.transferName으로 stamp', () => {
      const transferRoute: TransferRoute = {
        type: 'transfer',
        transferName: '교대',
        fromLine: '2',
        toLine: '3',
        stopsToTransfer: 3,
        stopsFromTransfer: 4,
        secondsToTransfer: 360,
        secondsFromTransfer: 480,
      };
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        route: transferRoute,
      });
      expect(result).toEqual({
        currentStationName: '강남',
        destinationName: '충무로',
        nextTransferName: '교대',
        tripActive: true,
      });
    });

    it('다중 환승(multi-transfer): transfers[0].transferName으로 stamp', () => {
      const multiRoute: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          {
            transferName: '교대',
            fromLine: '2',
            toLine: '3',
            stopsToTransfer: 3,
            secondsToTransfer: 360,
          },
          {
            transferName: '동대문',
            fromLine: '3',
            toLine: '4',
            stopsToTransfer: 2,
            secondsToTransfer: 240,
          },
        ],
        stopsAfterLastTransfer: 5,
        secondsAfterLastTransfer: 600,
      };
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        route: multiRoute,
      });
      expect(result?.nextTransferName).toBe('교대');
      expect(result?.tripActive).toBe(true);
    });

    it('다중 환승이지만 transfers 빈 배열: nextTransferName undefined (defensive)', () => {
      const emptyMulti: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [],
        stopsAfterLastTransfer: 5,
        secondsAfterLastTransfer: 600,
      };
      const result = buildWidgetTripContext({
        destination: MOCK_STATIONS.chungmuro,
        currentStation: MOCK_STATIONS.gangnam,
        route: emptyMulti,
      });
      expect(result?.nextTransferName).toBeUndefined();
      expect(result?.tripActive).toBe(true);
    });
  });
});
