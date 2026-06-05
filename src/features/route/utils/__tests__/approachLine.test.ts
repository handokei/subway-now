import { getApproachLine } from '../approachLine';
import type {
  Route,
  DirectRoute,
  TransferRoute,
  MultiTransferRoute,
} from '../../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';

function makeStation(line: Station['line'], overrides: Partial<Station> = {}): Station {
  return {
    id: '8-008',
    name: '천호',
    line,
    lineColor: '#000',
    lat: 37,
    lng: 127,
    ...overrides,
  };
}

function makeLock(boardingLine: BoardingLock['boardingLine'], overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest',
    trainCode: 'T1',
    boardingStationId: '8-008',
    boardingLine,
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
  stopsToTransfer = 3,
): TransferRoute {
  return {
    type: 'transfer',
    transferName: '군자',
    fromLine,
    toLine,
    stopsToTransfer,
    stopsFromTransfer: 5,
    secondsToTransfer: 0,
    secondsFromTransfer: 0,
  };
}

function makeMulti(
  segments: Array<{ from: MultiTransferRoute['transfers'][0]['fromLine']; to: MultiTransferRoute['transfers'][0]['toLine']; name: string; stops: number }>,
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

describe('getApproachLine', () => {
  describe('BoardingLock SSOT (우선순위 1)', () => {
    it('lock 존재 시 route/station 무시하고 lock.boardingLine 반환', () => {
      const lock = makeLock('8');
      const route = makeDirect('2');
      const station = makeStation('5');
      expect(getApproachLine(route, lock, station)).toBe('8');
    });

    it('lock 단독 (route/station null)도 boardingLine 반환', () => {
      expect(getApproachLine(null, makeLock('5'), null)).toBe('5');
    });
  });

  describe('Route 기반 (우선순위 2)', () => {
    it('direct route → route.line', () => {
      expect(getApproachLine(makeDirect('7'), null, makeStation('2'))).toBe('7');
    });

    it('transfer route, stopsToTransfer > 0 → fromLine (환승 전)', () => {
      expect(getApproachLine(makeTransfer('7', '5', 3), null, null)).toBe('7');
    });

    it('transfer route, stopsToTransfer === 0 → toLine (환승 도착/완료)', () => {
      expect(getApproachLine(makeTransfer('7', '5', 0), null, null)).toBe('5');
    });

    it('multi-transfer, 첫 segment의 stopsToTransfer > 0 → 그 fromLine', () => {
      const route = makeMulti([
        { name: '군자', from: '7', to: '5', stops: 3 },
        { name: '천호', from: '5', to: '8', stops: 6 },
      ]);
      expect(getApproachLine(route, null, null)).toBe('7');
    });

    it('multi-transfer, 첫 segment의 stopsToTransfer === 0 → 두 번째 fromLine (= midLine)', () => {
      const route = makeMulti([
        { name: '군자', from: '7', to: '5', stops: 0 },
        { name: '천호', from: '5', to: '8', stops: 6 },
      ]);
      expect(getApproachLine(route, null, null)).toBe('5');
    });

    it('multi-transfer, 모든 segment stopsToTransfer === 0 → lastTransfer.toLine (#797 회귀)', () => {
      // 2026-06-03 트립 시나리오: 천호(5→8) 환승 완료 후 8호선 마지막 leg.
      // boardingLock 없이도 route만으로 8호선임을 추정해야 함.
      const route = makeMulti([
        { name: '군자', from: '7', to: '5', stops: 0 },
        { name: '천호', from: '5', to: '8', stops: 0 },
      ]);
      expect(getApproachLine(route, null, null)).toBe('8');
    });

    it('multi-transfer, transfers 배열 비어있으면 fallback (station.line)', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [],
        stopsAfterLastTransfer: 0,
        secondsAfterLastTransfer: 0,
      };
      expect(getApproachLine(route, null, makeStation('2'))).toBe('2');
    });
  });

  describe('Fallback (우선순위 3)', () => {
    it('route null + lock null → currentStation.line', () => {
      expect(getApproachLine(null, null, makeStation('7'))).toBe('7');
    });

    it('route null + lock null + station null → null', () => {
      expect(getApproachLine(null, null, null)).toBeNull();
    });
  });
});
