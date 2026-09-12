import { buildBoardingPromptContext } from '../boardingPromptContext';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';
import { getStationById } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import type { Station } from '../../../../shared/types/station';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

function makeLock(overrides: Partial<BoardingLock>): BoardingLock {
  return {
    destinationId: '2-022',
    trainCode: '7246',
    boardingStationId: '2-022',
    boardingLine: '2',
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

function st(id: string): Station {
  const s = getStationById(id);
  if (!s) throw new Error(`fixture station not found: ${id}`);
  return s;
}

describe('buildBoardingPromptContext', () => {
  it('route가 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: null,
        currentStation: st('3-001'),
        destination: st('3-003'),
      }),
    ).toBeNull();
  });

  it('currentStation이 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: null,
        destination: st('3-003'),
      }),
    ).toBeNull();
  });

  it('destination이 null이면 null', () => {
    expect(
      buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: st('3-001'),
        destination: null,
      }),
    ).toBeNull();
  });

  describe('DirectRoute', () => {
    it('단조 line(3호선) — origin/next 좌표 + direction 채워짐', () => {
      const current = st('3-001'); // 대화
      const dest = st('3-003'); // 정발산
      const next = st('3-002'); // 주엽
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.origin).toEqual({ lat: current.lat, lng: current.lng });
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
      // 대화는 low endpoint → 정발산 방향은 high(down)
      expect(ctx?.promptGeoContext.direction).toBe('down');
      expect(ctx?.promptDisplay.originStation).toBe('대화');
      expect(ctx?.promptDisplay.line).toBe('3');
    });

    it('단조 line 역방향 — direction up', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: st('3-003'),
        destination: st('3-001'),
      });
      expect(ctx?.promptGeoContext.direction).toBe('up');
    });

    it('순환선(2호선) — resolveTravelDirection null이지만 inferLoopDirection fallback으로 down 채움 (#1703)', () => {
      // 시청(2-001) → 을지로3가(2-003): forward=2, backward=41 → forward 짧음 → down(외선순환).
      // 이전엔 null이었지만 #1703 wiring으로 순환선도 backend가 양방향 후보 ambiguity 회피.
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '2'),
        currentStation: st('2-001'),
        destination: st('2-003'),
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBe('down');
      expect(ctx?.promptDisplay.line).toBe('2');
    });

    it('하이브리드 노선(6호선) — 합정→공덕 down (#1703, 사용자 6/23 trip 회귀 차단)', () => {
      // 합정(6-013) → 공덕(6-017): id 증가 → down. backend pickAutoTrainCode가 응암 방면
      // 6184 trainCode를 잘못 잡지 않게 한다.
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(4, '6'),
        currentStation: st('6-013'),
        destination: st('6-017'),
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBe('down');
      expect(ctx?.promptDisplay.line).toBe('6');
      expect(ctx?.promptDisplay.originStation).toBe('합정');
    });

    it('하이브리드 노선(6호선) — 합정→망원 up (#1703)', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(1, '6'),
        currentStation: st('6-013'),
        destination: st('6-012'),
      });
      expect(ctx?.promptGeoContext.direction).toBe('up');
    });

    it('하이브리드 노선(6호선) — 응암→연신내 down (loop 안, #1703)', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(4, '6'),
        currentStation: st('6-001'),
        destination: st('6-005'),
      });
      expect(ctx?.promptGeoContext.direction).toBe('down');
    });

    it('하이브리드 노선(6호선) — 새절→증산 down (loop→본선 연결점, #1703)', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(1, '6'),
        currentStation: st('6-007'),
        destination: st('6-008'),
      });
      expect(ctx?.promptGeoContext.direction).toBe('down');
    });

    it('비단조/closedLoops 미포함 line(1호선) — direction null fallback', () => {
      // 1호선은 단조 화이트리스트 + closedLoops 둘 다 없음 → 양쪽 모두 null → 양방향 허용.
      const current = st('1-001');
      const dest = st('1-003');
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '1'),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBeNull();
      expect(ctx?.promptDisplay.line).toBe('1');
    });

    it('next station lookup 실패(current===destination) → null', () => {
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(0, '3'),
        currentStation: st('3-001'),
        destination: st('3-001'),
      });
      expect(ctx).toBeNull();
    });
  });

  describe('TransferRoute', () => {
    it('첫 leg = fromLine, next는 첫 leg 다음 역', () => {
      // 3호선 대화(3-001) → 교대(3-032) 환승 → 2호선 강남(2-022)
      const current = st('3-001'); // 대화
      const dest = st('2-022'); // 강남
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: '교대',
          fromLine: '3',
          toLine: '2',
          stopsToTransfer: 31,
          stopsFromTransfer: 1,
        }),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3'); // fromLine
      expect(ctx?.promptDisplay.originStation).toBe('대화');
      // 대화 다음은 주엽
      const next = st('3-002');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });
  });

  describe('MultiTransferRoute', () => {
    it('첫 segment의 fromLine으로 평가', () => {
      const current = st('3-001'); // 대화
      const dest = st('2-022'); // 강남
      const ctx = buildBoardingPromptContext({
        route: makeMultiTransferRoute({
          transfers: [
            { transferName: '교대', fromLine: '3', toLine: '2', stopsToTransfer: 31 },
            { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
          ],
          stopsAfterLastTransfer: 0,
        }),
        currentStation: current,
        destination: dest,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3');
      const next = st('3-002');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });
  });

  // #1921 — lock 활성 분기. cross-trip 자동 전환 시 route 원본 line이 현재 leg와 어긋나도
  // lock.boardingLine 기준으로 정확한 stamp를 빌드해 stale lastPromptContextRef fallback을 차단.
  describe('#1921 lock 활성 분기', () => {
    it('lock 활성 + lock.boardingLine === route.firstLeg.line → 기존 path와 동등 stamp 결과 (보존)', () => {
      const current = st('3-001'); // 대화
      const dest = st('3-003'); // 정발산
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '3',
      });
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: current,
        destination: dest,
        lock,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3');
      expect(ctx?.promptDisplay.originStation).toBe('대화');
      const next = st('3-002');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
      expect(ctx?.promptGeoContext.direction).toBe('down');
    });

    it('cross-trip 자동 전환: route 원본 line=3 multi-transfer, lock.boardingLine=2, currentStation=line2 → lock line으로 stamp', () => {
      // route: 3호선 대화 → ... → 교대 (transfer) → 2호선 강남. 사용자가 교대 환승 후 lock=2 leg로 진입.
      // currentStation: 서초(2-024)에서 교대(2-023)로 통과 후 다음 역(강남=2-022)이 next-station 예상.
      const current = st('2-024'); // 서초 (line 2)
      const dest = st('2-022'); // 강남 (line 2)
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '2',
      });
      const ctx = buildBoardingPromptContext({
        route: makeMultiTransferRoute({
          transfers: [
            // 첫 leg: 3호선 firstLeg(line=3). lock이 line=2이라 기존 path는 line=3 기준으로 동작.
            { transferName: canonicalStationName('교대', '3'), fromLine: '3', toLine: '2', stopsToTransfer: 31 },
            { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
          ],
          stopsAfterLastTransfer: 0,
        }),
        currentStation: current,
        destination: dest,
        lock,
      });
      expect(ctx).not.toBeNull();
      // lock.boardingLine=2 우선 stamp. 기존 path가 line='3'을 stamp하던 회귀 차단.
      expect(ctx?.promptDisplay.line).toBe('2');
      expect(ctx?.promptDisplay.originStation).toBe('서초');
      // 서초(2-024) → 강남(2-022) 방향 다음 역은 교대(2-023).
      const next = st('2-023');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });

    it('lock 활성 + currentStation이 lock.boardingLine 위에 없음 → null (라인 일관성 깨짐)', () => {
      const current = st('3-001'); // 대화 (line 3)
      const dest = st('2-022'); // 강남
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: '2-024',
        boardingLine: '2', // 사용자는 line 2에 lock 했는데 현재는 line 3 station — 비정상 상태
      });
      const ctx = buildBoardingPromptContext({
        route: makeMultiTransferRoute({
          transfers: [
            { transferName: '교대', fromLine: '3', toLine: '2', stopsToTransfer: 31 },
            { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
          ],
          stopsAfterLastTransfer: 0,
        }),
        currentStation: current,
        destination: dest,
        lock,
      });
      // lock.boardingLine=2 위에 "대화"가 없음 → next-station lookup fail → null
      expect(ctx).toBeNull();
    });

    it('lock 활성 + lock.boardingLine이 TransferRoute segment 어느 것에도 일치 안 함 → null', () => {
      const current = st('3-001'); // 대화 (line 3)
      const dest = st('2-022'); // 강남
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '5' as const, // route fromLine=3, toLine=2인데 lock은 line=5
      });
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: canonicalStationName('교대', '3'),
          fromLine: '3',
          toLine: '2',
          stopsToTransfer: 31,
          stopsFromTransfer: 2,
        }),
        currentStation: current,
        destination: dest,
        lock,
      });
      // findSegmentEndStationName이 line=5를 매칭 못 함 → segmentEndName=null → ctx=null
      expect(ctx).toBeNull();
    });

    it('lock 활성 + lock.boardingLine이 MultiTransferRoute segment 어느 것에도 일치 안 함 → null', () => {
      const current = st('3-001');
      const dest = st('2-022');
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '5' as const,
      });
      const ctx = buildBoardingPromptContext({
        route: makeMultiTransferRoute({
          transfers: [
            { transferName: canonicalStationName('교대', '3'), fromLine: '3', toLine: '2', stopsToTransfer: 31 },
            { transferName: '강남', fromLine: '2', toLine: 'sinbundang', stopsToTransfer: 1 },
          ],
          stopsAfterLastTransfer: 0,
        }),
        currentStation: current,
        destination: dest,
        lock,
      });
      // multi-transfer 어느 segment에도 line=5 없음 → null
      expect(ctx).toBeNull();
    });

    it('lock 활성 + currentStation === segmentEnd → null (이미 leg 끝 도달)', () => {
      const current = st('3-003'); // 정발산 = destination
      const dest = st('3-003'); // 정발산
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '3',
      });
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(0, '3'),
        currentStation: current,
        destination: dest,
        lock,
      });
      // current === segmentEnd → getNextStationOnLine returns null → context null
      expect(ctx).toBeNull();
    });

    it('lock null이면 기존 getFirstLeg path 호출 (회귀 방지)', () => {
      const current = st('3-001');
      const dest = st('3-003');
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '3'),
        currentStation: current,
        destination: dest,
        lock: null,
      });
      // lock null이면 기존 path와 동등
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('3');
      expect(ctx?.promptDisplay.originStation).toBe('대화');
    });

    it('lock 활성 + TransferRoute boardingLine === toLine → destination을 segmentEnd로 사용', () => {
      // route: 3호선 대화 → 교대(transfer) → 2호선 강남(destination)
      // lock은 toLine=2 leg에 진입한 상태 (교대 환승 후, 사용자는 서초까지 진행)
      const current = st('2-024'); // 서초 (line 2)
      const dest = st('2-022'); // 강남 (line 2)
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '2',
      });
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: canonicalStationName('교대', '3'),
          fromLine: '3',
          toLine: '2',
          stopsToTransfer: 31,
          stopsFromTransfer: 2,
        }),
        currentStation: current,
        destination: dest,
        lock,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('2');
      expect(ctx?.promptDisplay.originStation).toBe('서초');
    });

    it('lock 활성 + 순환선(2호선) → inferLoopDirection fallback이 direction 채움', () => {
      // 시청(2-001) → 을지로3가(2-003) 구간에 lock. 순환선이라 resolveTravelDirection null이지만
      // inferLoopDirection이 down(외선순환)을 채워야 함.
      const current = st('2-001');
      const dest = st('2-003');
      const lock = makeLock({
        destinationId: dest.id,
        boardingStationId: current.id,
        boardingLine: '2',
      });
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '2'),
        currentStation: current,
        destination: dest,
        lock,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBe('down');
      expect(ctx?.promptDisplay.line).toBe('2');
    });
  });
});
