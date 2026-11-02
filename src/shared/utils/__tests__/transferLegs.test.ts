import { getTransferLegs } from '../transferLegs';
import type {
  DirectRoute,
  MultiTransferRoute,
  TransferRoute,
} from '../stationRoute';

describe('getTransferLegs', () => {
  it('null → []', () => {
    expect(getTransferLegs(null)).toEqual([]);
  });

  it('direct → [] (환승 없음)', () => {
    const route: DirectRoute = {
      type: 'direct',
      stops: 5,
      line: '2',
      travelSeconds: 600,
      destinationStationId: '2-001',
    };
    expect(getTransferLegs(route)).toEqual([]);
  });

  it('transfer → 1 leg (fromLine 보존)', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '왕십리',
      fromLine: '2',
      toLine: '5',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
      secondsToTransfer: 360,
      secondsFromTransfer: 480,
      transferStationId: '2-001',
      destinationStationId: '5-001',
    };
    expect(getTransferLegs(route)).toEqual([{ transferName: '왕십리', fromLine: '2' }]);
  });

  it('multi-transfer → transfers 순서 보존 (fromLine만 추출)', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        {
          transferName: '왕십리',
          fromLine: '2',
          toLine: '5',
          stopsToTransfer: 3,
          secondsToTransfer: 360,
          transferStationId: '2-001',
        },
        {
          transferName: '광화문',
          fromLine: '5',
          toLine: '3',
          stopsToTransfer: 2,
          secondsToTransfer: 240,
          transferStationId: '5-001',
        },
      ],
      stopsAfterLastTransfer: 4,
      secondsAfterLastTransfer: 480,
      destinationStationId: '3-001',
    };
    expect(getTransferLegs(route)).toEqual([
      { transferName: '왕십리', fromLine: '2' },
      { transferName: '광화문', fromLine: '5' },
    ]);
  });
});
