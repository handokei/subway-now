import { resolveTripDirection } from '../tripDirection';
import type {
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../stationRoute';

describe('resolveTripDirection', () => {
  it('direct: next waypoint index > current index → "down"', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '1' };
    // 소요산(1-001, idx 0) → 서울역(1-034)
    expect(resolveTripDirection(route, '서울역', '1-001')).toBe('down');
  });

  it('direct: next waypoint index < current index → "up"', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '1' };
    expect(resolveTripDirection(route, '소요산', '1-034')).toBe('up');
  });

  it('current가 같은 station이면 null', () => {
    const route: DirectRoute = { type: 'direct', stops: 0, line: '1' };
    expect(resolveTripDirection(route, '소요산', '1-001')).toBeNull();
  });

  it('current가 다른 노선이면 null', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '1' };
    expect(resolveTripDirection(route, '서울역', '7-015')).toBeNull();
  });

  it('next waypoint name이 line에 존재하지 않으면 null', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '1' };
    expect(resolveTripDirection(route, '없는역이름XYZ', '1-001')).toBeNull();
  });

  it('transfer: 첫 leg은 fromLine + transferName으로 판정한다', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '서울역',
      fromLine: '1',
      toLine: '4',
      stopsToTransfer: 5,
      stopsFromTransfer: 3,
    };
    // 소요산(1-001) → 서울역(1-034) = down
    expect(resolveTripDirection(route, '강남', '1-001')).toBe('down');
  });

  it('multi-transfer: transfers[0]의 fromLine + transferName으로 판정한다', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '서울역', fromLine: '1', toLine: '4', stopsToTransfer: 5 },
        { transferName: '명동', fromLine: '4', toLine: '2', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 2,
    };
    expect(resolveTripDirection(route, '강남', '1-001')).toBe('down');
  });
});
