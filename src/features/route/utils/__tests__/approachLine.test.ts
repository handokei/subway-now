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
      // 군자는 7호선 정차역 → #1325 가드 통과 (currentStation이 후보 line 서비스).
      expect(getApproachLine(makeDirect('7'), null, makeStation('7', { name: '군자' }))).toBe('7');
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

  describe('legAdvance override (#2278 RCA — 가설 1 확정: releaseLock 후 stopsToTransfer 미갱신)', () => {
    it('가설 1 재현: lock 해제 + route.stopsToTransfer 미갱신(frozen) → legAdvance 없이는 여전히 fromLine(구 노선) 반환', () => {
      // 건대입구 7→2 환승: 사용자가 하차 응답 후 releaseLock(lock=null)했지만 route의 진행도
      // (stopsToTransfer)는 backend SSoT 갱신 지연으로 아직 3(환승 전)에 머물러 있다.
      // legAdvance 힌트 없이는 route가 여전히 fromLine('7')을 반환 — 이것이 BoardingTrainList가
      // 7호선 열차만 보여준 회귀의 근본 원인(가설 1 확정).
      const route = makeTransfer('7', '2', 3);
      expect(getApproachLine(route, null, null)).toBe('7');
    });

    it('사용자 명시 하차 응답 stamp(legAdvance) 존재 시 lock=null + stale route라도 nextLine 반환', () => {
      const route = makeTransfer('7', '2', 3);
      expect(getApproachLine(route, null, null, '2')).toBe('2');
    });

    it('legAdvance가 있어도 lock이 여전히 존재하면 lock.boardingLine이 최우선', () => {
      const route = makeTransfer('7', '2', 3);
      const lock = makeLock('7');
      expect(getApproachLine(route, lock, null, '2')).toBe('7');
    });

    it('legAdvance 없음(undefined)이면 기존 동작(route 기반) 그대로', () => {
      const route = makeTransfer('7', '2', 0);
      expect(getApproachLine(route, null, null, null)).toBe('2');
    });
  });

  describe('현재역 line 검증 가드 (#1325)', () => {
    it('후보 line을 현재역이 실제 서비스하면 그대로 반환', () => {
      // 신당은 2,6호선 정차 → boardingLine 6호선이면 검증 통과.
      const lock = makeLock('6');
      const station = makeStation('2', { name: '신당' });
      expect(getApproachLine(null, lock, station)).toBe('6');
    });

    it('후보 line을 현재역이 서비스 안 하면 currentStation.line으로 fallback (잘못 탑승/데시싱크)', () => {
      // 신당은 2,6호선만 정차(7호선 없음). desync route의 7호선 leg가 새도 신당 라벨로 안 씀.
      const lock = makeLock('7');
      const station = makeStation('2', { name: '신당' });
      expect(getApproachLine(null, lock, station)).toBe('2');
    });

    it('route 파생 line(transfer fromLine)도 현재역 미서비스면 fallback', () => {
      // makeTransfer fromLine 7호선이 신당으로 새는 케이스를 route 경로로도 커버.
      const route = makeTransfer('7', '5', 3);
      const station = makeStation('6', { name: '신당' });
      expect(getApproachLine(route, null, station)).toBe('6');
    });

    it('후보 line 존재 + currentStation null → 검증 스킵, 후보 그대로 반환', () => {
      // currentStation이 없으면 검증할 대상이 없어 기존 동작 유지.
      expect(getApproachLine(null, makeLock('7'), null)).toBe('7');
    });
  });
});
