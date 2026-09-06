import { buildBoardingLockMeta, findSegmentEndStationName } from '../buildBoardingLockMeta';
import { BOARDING_LOCK_EXPIRY_FACTOR } from '../../../../shared/types/boardingLock';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
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

  // #865 — 시간표 fallback trainCode(SCHED-*)는 backend 누설 차단.
  // #2407 — pending fallback lock(trainCode 미확정)도 backend reschedule의 anchor로 쓸 수
  // 없다. schedule fallback과 동일하게 등록을 보류해 anchor waypoint 폴링으로 fallback해야 한다.
  it.each([
    ['#865 — 시간표 fallback trainCode(SCHED-*)면 null (backend 누설 차단)', 'SCHED-UP-1'],
    ['#865 — SCHED-DN-* 같은 다른 suffix도 동일하게 null', 'SCHED-DN-2'],
    ['#2407 — trainCode가 pending sentinel이면 null (backend 등록 보류)', 'PENDING-TRAIN-CODE'],
  ])('%s', (_description, trainCode) => {
    const route = makeDirectRoute(1, '7');
    const result = buildBoardingLockMeta({
      lock: { ...baseLock, trainCode: trainCode as never, boardingLine: '7' },
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

  describe('2호선 본선 wraparound (#1722, #622 후속)', () => {
    // 시청(2-001, idx 0) → 합정(2-038): 직선 slice는 37+ stations.
    // wraparound aware는 시청 → 충정로(2-043) → ... → 합정 = 6 hop (7 stations).
    it('시청 → 합정 segmentStations는 wraparound short path (≤ 10 stations)', () => {
      const route = makeDirectRoute(6, '2');
      const result = buildBoardingLockMeta({
        lock: { ...baseLock, boardingLine: '2' },
        route,
        destinationName: '합정',
        boardingStationName: '시청',
      });
      expect(result).not.toBeNull();
      expect(result!.segmentStations[0]).toBe('시청');
      expect(result!.segmentStations[result!.segmentStations.length - 1]).toBe('합정');
      // wraparound 경로 6 hop (7 stations) 보장 — 직선 slice 38 stations와 명확히 구분.
      expect(result!.segmentStations.length).toBeLessThanOrEqual(10);
      // wraparound이므로 두 번째 station은 정방향 인접(을지로입구)이 아니라 충정로(prefix).
      expect(result!.segmentStations[1].startsWith('충정로')).toBe(true);
    });

    it('합정 → 시청 segmentStations도 wraparound (역방향, 6 hop)', () => {
      const route = makeDirectRoute(6, '2');
      const result = buildBoardingLockMeta({
        lock: { ...baseLock, boardingLine: '2' },
        route,
        destinationName: '시청',
        boardingStationName: '합정',
      });
      expect(result).not.toBeNull();
      expect(result!.segmentStations[0]).toBe('합정');
      expect(result!.segmentStations[result!.segmentStations.length - 1]).toBe('시청');
      expect(result!.segmentStations.length).toBeLessThanOrEqual(10);
    });
  });
});
