import { findSegmentEndStationName } from '../buildBoardingLockMeta';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

describe('findSegmentEndStationName', () => {
  it('direct route → destination', () => {
    const route = makeDirectRoute(3, '2');
    expect(findSegmentEndStationName(route, '2', '강남')).toBe('강남');
  });

  it('transfer fromLine → transferName, toLine → destination', () => {
    const route = makeTransferRoute({
      transferName: '교대',
      fromLine: '3',
      toLine: '2',
      stopsToTransfer: 5,
      stopsFromTransfer: 2,
    });
    expect(findSegmentEndStationName(route, '3', '강남')).toBe('교대');
    expect(findSegmentEndStationName(route, '2', '강남')).toBe('강남');
  });

  it('transfer 노선 어느 segment에도 일치 안 하면 null', () => {
    const route = makeTransferRoute({
      transferName: '교대',
      fromLine: '3',
      toLine: '2',
      stopsToTransfer: 5,
      stopsFromTransfer: 2,
    });
    expect(findSegmentEndStationName(route, '7', '강남')).toBeNull();
  });

  it('multi-transfer: segment.fromLine 일치 → transferName, 마지막 toLine → destination', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '시청', fromLine: '1', toLine: '2', stopsToTransfer: 3 },
        { transferName: '교대', fromLine: '2', toLine: '3', stopsToTransfer: 4 },
      ],
      stopsAfterLastTransfer: 5,
    });
    expect(findSegmentEndStationName(route, '1', '대치')).toBe('시청');
    expect(findSegmentEndStationName(route, '2', '대치')).toBe('교대');
    expect(findSegmentEndStationName(route, '3', '대치')).toBe('대치');
    expect(findSegmentEndStationName(route, '7', '대치')).toBeNull();
  });

  it('multi-transfer transfers 비어있고 line 매칭 없으면 null', () => {
    const route = makeMultiTransferRoute({
      transfers: [],
      stopsAfterLastTransfer: 5,
    });
    expect(findSegmentEndStationName(route, '1', '대치')).toBeNull();
  });
});
