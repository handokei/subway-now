/**
 * #1935 — silent push 채널 widget storage update wire 검증.
 *
 * payload SSoT 우선 + BG context fallback + destination/route 기반 tripContext 구성.
 * saveStationToWidget + lookupStationFromSsot는 mock으로 격리해 wire 자체만 검증.
 */

const mockSaveStationToWidget = jest.fn().mockResolvedValue(undefined);
jest.mock('../../api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
}));

const mockLookup = jest.fn();
jest.mock('../lookupStationFromSsot', () => ({
  lookupStationFromSsot: (...args: unknown[]) => mockLookup(...args),
}));

import { updateWidgetFromSilentPush } from '../updateWidgetFromSilentPush';
import type { BgLastStationContext, SsotStationInput } from '../lookupStationFromSsot';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';

const station: Station = {
  id: '0226',
  name: '역삼',
  line: '2',
  lineColor: '#009933',
  lat: 37.5,
  lng: 127.04,
};

const destination: Station = {
  id: '0220',
  name: '잠실',
  line: '2',
  lineColor: '#009933',
  lat: 37.513,
  lng: 127.1,
};

const ssot: SsotStationInput = {
  currentStationId: '역삼',
  currentStationLine: '2',
};

const bgContext: BgLastStationContext = {
  station,
  distanceKm: 0.15,
  timestamp: 1_700_000_000_000,
};

const directRoute: Route = { type: 'direct', line: '2', stops: 3, travelSeconds: 240 };
const transferRoute: Route = {
  type: 'transfer',
  transferName: '건대입구',
  fromLine: '2',
  toLine: '7',
  stopsToTransfer: 2,
  stopsFromTransfer: 5,
  secondsToTransfer: 180,
  secondsFromTransfer: 360,
};
const multiTransferRoute: Route = {
  type: 'multi-transfer',
  transfers: [
    {
      transferName: '왕십리',
      fromLine: '2',
      toLine: '5',
      stopsToTransfer: 1,
      secondsToTransfer: 100,
    },
    {
      transferName: '천호',
      fromLine: '5',
      toLine: '8',
      stopsToTransfer: 4,
      secondsToTransfer: 320,
    },
  ],
  stopsAfterLastTransfer: 2,
  secondsAfterLastTransfer: 180,
};

describe('updateWidgetFromSilentPush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockReturnValue({ station, distanceKm: 0 });
  });

  it('SSoT 우선 사용 → saveStationToWidget 호출 + force:true', async () => {
    await updateWidgetFromSilentPush(ssot, bgContext, destination, directRoute, 1_700_000_000_000);
    expect(mockLookup).toHaveBeenCalledWith(ssot, bgContext);
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      station,
      0,
      1_700_000_000_000,
      { force: true },
      {
        currentStationName: '역삼',
        destinationName: '잠실',
        tripActive: true,
      },
    );
  });

  it('SSoT 없으면 BG context fallback (lookup이 결정) — saveStationToWidget 호출', async () => {
    mockLookup.mockReturnValue({ station, distanceKm: 0.15 });
    await updateWidgetFromSilentPush(null, bgContext, destination, directRoute, 1_700_000_000_000);
    expect(mockLookup).toHaveBeenCalledWith(null, bgContext);
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      station,
      0.15,
      1_700_000_000_000,
      { force: true },
      expect.objectContaining({ tripActive: true }),
    );
  });

  it('SSoT undefined 도 lookup이 결정 — saveStationToWidget 호출', async () => {
    mockLookup.mockReturnValue({ station, distanceKm: 0.15 });
    await updateWidgetFromSilentPush(undefined, bgContext, destination, directRoute, 1_700_000_000_000);
    expect(mockLookup).toHaveBeenCalledWith(undefined, bgContext);
    expect(mockSaveStationToWidget).toHaveBeenCalledTimes(1);
  });

  it('lookup이 null 반환 → saveStationToWidget 호출 안 함 (no-op)', async () => {
    mockLookup.mockReturnValue(null);
    await updateWidgetFromSilentPush(ssot, null, destination, directRoute);
    expect(mockSaveStationToWidget).not.toHaveBeenCalled();
  });

  describe('tripContext 구성', () => {
    it('destination 없음 → tripActive=false + destinationName 비움', async () => {
      await updateWidgetFromSilentPush(ssot, bgContext, null, directRoute, 1);
      expect(mockSaveStationToWidget).toHaveBeenCalledWith(
        station,
        0,
        1,
        { force: true },
        {
          currentStationName: '역삼',
          destinationName: '',
          tripActive: false,
        },
      );
    });

    it('direct route + destination → nextTransferName 미포함 (직통)', async () => {
      await updateWidgetFromSilentPush(ssot, bgContext, destination, directRoute, 1);
      const call = mockSaveStationToWidget.mock.calls[0];
      const tripContext = call[4];
      expect(tripContext).not.toHaveProperty('nextTransferName');
      expect(tripContext.tripActive).toBe(true);
    });

    it('transfer route → nextTransferName=첫 환승역', async () => {
      await updateWidgetFromSilentPush(ssot, bgContext, destination, transferRoute, 1);
      const call = mockSaveStationToWidget.mock.calls[0];
      expect(call[4]).toEqual({
        currentStationName: '역삼',
        destinationName: '잠실',
        nextTransferName: '건대입구',
        tripActive: true,
      });
    });

    it('multi-transfer route → nextTransferName=transfers[0].transferName', async () => {
      await updateWidgetFromSilentPush(ssot, bgContext, destination, multiTransferRoute, 1);
      const call = mockSaveStationToWidget.mock.calls[0];
      expect(call[4]).toEqual({
        currentStationName: '역삼',
        destinationName: '잠실',
        nextTransferName: '왕십리',
        tripActive: true,
      });
    });

    it('route null + destination 있음 → nextTransferName 미포함', async () => {
      await updateWidgetFromSilentPush(ssot, bgContext, destination, null, 1);
      const call = mockSaveStationToWidget.mock.calls[0];
      expect(call[4]).not.toHaveProperty('nextTransferName');
      expect(call[4].tripActive).toBe(true);
    });
  });

  it('savedAt 인자 생략 시 Date.now()로 호출', async () => {
    const before = Date.now();
    await updateWidgetFromSilentPush(ssot, bgContext, destination, directRoute);
    const after = Date.now();
    const savedAt = mockSaveStationToWidget.mock.calls[0][2];
    expect(savedAt).toBeGreaterThanOrEqual(before);
    expect(savedAt).toBeLessThanOrEqual(after);
  });

  it('saveStationToWidget throw도 caller로 전파 안 함 (graceful)', async () => {
    mockSaveStationToWidget.mockRejectedValueOnce(new Error('native'));
    await expect(
      updateWidgetFromSilentPush(ssot, bgContext, destination, directRoute, 1),
    ).resolves.toBeUndefined();
  });

  it('lookup 자체가 throw해도 graceful', async () => {
    mockLookup.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(
      updateWidgetFromSilentPush(ssot, bgContext, destination, directRoute, 1),
    ).resolves.toBeUndefined();
    expect(mockSaveStationToWidget).not.toHaveBeenCalled();
  });
});
