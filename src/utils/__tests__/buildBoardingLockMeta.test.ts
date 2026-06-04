import { buildBoardingLockMeta, findSegmentEndStationName } from '../buildBoardingLockMeta';
import { BOARDING_LOCK_EXPIRY_FACTOR } from '../../types/boardingLock';
import type { BoardingLock } from '../../types/boardingLock';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

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

describe('buildBoardingLockMeta', () => {
  const baseLock: BoardingLock = {
    destinationId: '0228',
    trainCode: '7246',
    boardingStationId: '0228', // dummy
    boardingLine: '7',
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000, // 10분
  };

  it('subwayId 매핑 실패면 null (line이 알 수 없음)', () => {
    const route = makeDirectRoute(3, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: 'unknown' as never },
      route,
      destinationName: '용마산',
      boardingStationName: '면목',
    });
    expect(result).toBeNull();
  });

  it('#865 — 시간표 fallback trainCode(SCHED-*)면 null (backend 누설 차단)', () => {
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, trainCode: 'SCHED-UP-1', boardingLine: '7' },
      route,
      destinationName: '용마산',
      boardingStationName: '면목',
    });
    expect(result).toBeNull();
  });

  it('#865 — SCHED-DN-* 같은 다른 suffix도 동일하게 null', () => {
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, trainCode: 'SCHED-DN-2', boardingLine: '7' },
      route,
      destinationName: '용마산',
      boardingStationName: '면목',
    });
    expect(result).toBeNull();
  });

  it('segmentStations 추론 불가하면 (boardingLine ≠ route segment) null', () => {
    const route = makeTransferRoute({
      transferName: '교대',
      fromLine: '3',
      toLine: '2',
      stopsToTransfer: 5,
      stopsFromTransfer: 2,
    });
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: '7' },
      route,
      destinationName: '강남',
      boardingStationName: '면목',
    });
    expect(result).toBeNull();
  });

  it('id 역순(startIdx > endIdx)이면 boarding→destination 순서로 reverse한다 — backend indexOf 의존', () => {
    // 7호선에서 사가정(상위 id) → 면목(하위 id)으로 이동 (위→아래 진행 가정).
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: '7' },
      route,
      destinationName: '면목',
      boardingStationName: '사가정',
    });
    expect(result).not.toBeNull();
    // boarding이 segmentStations[0], destination이 last여야 한다.
    expect(result!.segmentStations[0]).toBe('사가정');
    expect(result!.segmentStations[result!.segmentStations.length - 1]).toBe('면목');
  });

  it('boarding == destination이면 segmentStations 길이 1', () => {
    const route = makeDirectRoute(0, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: '7' },
      route,
      destinationName: '면목',
      boardingStationName: '면목',
    });
    expect(result).not.toBeNull();
    expect(result!.segmentStations).toEqual(['면목']);
  });

  it('direct route + 같은 line: segmentStations에 출발/도착 포함된 station 시퀀스', () => {
    // 면목(7호선) → 용마산(7호선), 7호선에서 인접한 두 역.
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: '7' },
      route,
      destinationName: '용마산',
      boardingStationName: '면목',
    });
    expect(result).not.toBeNull();
    expect(result!.trainCode).toBe('7246');
    expect(result!.line).toBe('7');
    expect(result!.subwayId).toBe('1007');
    expect(result!.selectedDepartureTime).toBe(baseLock.boardedAt);
    expect(result!.expiresAt).toBe(baseLock.boardedAt + 600_000 * BOARDING_LOCK_EXPIRY_FACTOR);
    expect(result!.segmentStations.length).toBeGreaterThanOrEqual(2);
    expect(result!.segmentStations).toContain('면목');
    expect(result!.segmentStations).toContain('용마산');
  });

  it('알 수 없는 boardingStation/endStation이면 null', () => {
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, boardingLine: '7' },
      route,
      destinationName: '__no_such_station__',
      boardingStationName: '면목',
    });
    expect(result).toBeNull();
  });
});
