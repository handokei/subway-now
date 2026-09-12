import { resolveJourneyOriginStation } from '../journeyOrigin';
import { getStationById } from '../../../../shared/utils/stationRoute';
import type {
  DirectRoute,
  MultiTransferRoute,
  Route,
  TransferRoute,
} from '../../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';

function makeStation(line: Station['line'], overrides: Partial<Station> = {}): Station {
  return {
    id: '7-015',
    name: '용마산',
    line,
    lineColor: '#000',
    lat: 37,
    lng: 127,
    ...overrides,
  };
}

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest',
    trainCode: 'T1',
    boardingStationId: '2-012',
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

function makeDirect(line: DirectRoute['line'], stops = 5): DirectRoute {
  return { type: 'direct', stops, line, travelSeconds: 0 };
}

function makeTransfer(
  fromLine: TransferRoute['fromLine'],
  toLine: TransferRoute['toLine'],
  transferName: string,
  stopsToTransfer = 3,
): TransferRoute {
  return {
    type: 'transfer',
    transferName,
    fromLine,
    toLine,
    stopsToTransfer,
    stopsFromTransfer: 5,
    secondsToTransfer: 0,
    secondsFromTransfer: 0,
  };
}

function makeMulti(
  segments: Array<{
    from: MultiTransferRoute['transfers'][0]['fromLine'];
    to: MultiTransferRoute['transfers'][0]['toLine'];
    name: string;
    stops: number;
  }>,
  stopsAfterLastTransfer = 2,
): MultiTransferRoute {
  return {
    type: 'multi-transfer',
    transfers: segments.map((s) => ({
      transferName: s.name,
      fromLine: s.from,
      toLine: s.to,
      stopsToTransfer: s.stops,
      secondsToTransfer: 0,
    })),
    stopsAfterLastTransfer,
    secondsAfterLastTransfer: 0,
  };
}

describe('resolveJourneyOriginStation', () => {
  const tripOrigin = makeStation('7', { id: '7-015', name: '용마산' });

  describe('환승 전 (기존 회귀 0)', () => {
    it('boardingLock/legAdvance/route 진행도 모두 없으면 tripOrigin 그대로', () => {
      const route: Route = makeTransfer('7', '2', '건대입구', 3);
      expect(resolveJourneyOriginStation(route, null, tripOrigin, null)).toBe(tripOrigin);
    });

    it('route null이어도 tripOrigin 그대로', () => {
      expect(resolveJourneyOriginStation(null, null, tripOrigin, null)).toBe(tripOrigin);
    });

    it('direct route(환승 없음)는 tripOrigin 그대로', () => {
      const route = makeDirect('7');
      expect(resolveJourneyOriginStation(route, null, tripOrigin, null)).toBe(tripOrigin);
    });
  });

  describe('BoardingLock 우선순위 1 (새 leg lock)', () => {
    it('lock.boardingStationId가 유효 station이면 그 station 반환 (route/legAdvance 무시)', () => {
      const route = makeTransfer('7', '2', '건대입구', 3);
      const lock = makeLock({ boardingStationId: '2-012', boardingLine: '2' });
      const result = resolveJourneyOriginStation(route, lock, tripOrigin, '2');
      expect(result).toEqual(getStationById('2-012'));
    });

    it('lock.boardingStationId가 미존재 station id면 다음 우선순위로 폴백', () => {
      const route = makeTransfer('7', '2', '건대입구', 0);
      const lock = makeLock({ boardingStationId: 'no-such-id' });
      const result = resolveJourneyOriginStation(route, lock, tripOrigin, null);
      // route 진행도 우선순위(3)로 폴백 — stopsToTransfer===0이므로 환승역(건대입구, 2호선)
      expect(result?.name).toBe('건대입구');
      expect(result?.line).toBe('2');
    });
  });

  describe('legAdvance 우선순위 2 (#2278 하차 응답 stamp)', () => {
    it('legAdvanceLine이 transfer route의 toLine과 일치하면 환승역 반환', () => {
      const route = makeTransfer('7', '2', '건대입구', 3); // route 진행도만으론 아직 환승 전(3>0)
      const result = resolveJourneyOriginStation(route, null, tripOrigin, '2');
      expect(result?.name).toBe('건대입구');
      expect(result?.line).toBe('2');
    });

    it('multi-transfer에서 legAdvanceLine이 두 번째 환승의 toLine이면 그 환승역 반환', () => {
      const route = makeMulti([
        { name: '건대입구', from: '7', to: '2', stops: 0 },
        { name: '왕십리', from: '2', to: '5', stops: 4 },
      ]);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, '5');
      expect(result?.name).toBe('왕십리(성동구청)');
      expect(result?.line).toBe('5');
    });

    it('legAdvanceLine이 어떤 transfer의 toLine과도 안 맞으면 route 진행도로 폴백', () => {
      const route = makeTransfer('7', '2', '건대입구', 0);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, '8');
      expect(result?.name).toBe('건대입구');
      expect(result?.line).toBe('2');
    });

    it('legAdvanceLine이 toLine과 일치해도 transferName이 실제 station lookup에 실패하면 route 진행도로 폴백', () => {
      const route = makeTransfer('7', '2', '존재하지않는역이름', 0);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, '2');
      // findTransferStationForLine이 실패 → route 진행도(우선순위 3)도 같은 이름이라 실패 → tripOrigin
      expect(result).toBe(tripOrigin);
    });
  });

  describe('route 진행도 우선순위 3 (stopsToTransfer===0)', () => {
    it('transfer route, stopsToTransfer>0(환승 전) → tripOrigin', () => {
      const route = makeTransfer('7', '2', '건대입구', 3);
      expect(resolveJourneyOriginStation(route, null, tripOrigin, null)).toBe(tripOrigin);
    });

    it('transfer route, stopsToTransfer===0(환승 완료) → 환승역', () => {
      const route = makeTransfer('7', '2', '건대입구', 0);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, null);
      expect(result?.name).toBe('건대입구');
      expect(result?.line).toBe('2');
    });

    it('multi-transfer: 다중 환승 각 leg별 origin — 1차 환승만 완료', () => {
      const route = makeMulti([
        { name: '건대입구', from: '7', to: '2', stops: 0 },
        { name: '왕십리', from: '2', to: '5', stops: 4 },
      ]);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, null);
      expect(result?.name).toBe('건대입구');
      expect(result?.line).toBe('2');
    });

    it('multi-transfer: 다중 환승 각 leg별 origin — 2차 환승까지 완료(마지막 leg)', () => {
      const route = makeMulti([
        { name: '건대입구', from: '7', to: '2', stops: 0 },
        { name: '왕십리', from: '2', to: '5', stops: 0 },
      ]);
      const result = resolveJourneyOriginStation(route, null, tripOrigin, null);
      expect(result?.name).toBe('왕십리(성동구청)');
      expect(result?.line).toBe('5');
    });

    it('multi-transfer: 아직 첫 환승도 안 함 → tripOrigin', () => {
      const route = makeMulti([
        { name: '건대입구', from: '7', to: '2', stops: 3 },
        { name: '왕십리', from: '2', to: '5', stops: 4 },
      ]);
      expect(resolveJourneyOriginStation(route, null, tripOrigin, null)).toBe(tripOrigin);
    });

    it('transfer 환승역 이름이 station lookup에 실패하면 tripOrigin으로 폴백', () => {
      const route = makeTransfer('7', '2', '존재하지않는역이름', 0);
      expect(resolveJourneyOriginStation(route, null, tripOrigin, null)).toBe(tripOrigin);
    });
  });

  describe('null/전체 부재', () => {
    it('route/lock/legAdvance 모두 null이고 tripOrigin도 null이면 null', () => {
      expect(resolveJourneyOriginStation(null, null, null, null)).toBeNull();
    });
  });
});
