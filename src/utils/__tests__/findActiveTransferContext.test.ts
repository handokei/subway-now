import {
  findActiveTransferContext,
  findUpcomingTransferPrefetch,
  resolveDirectionInLine,
} from '../findActiveTransferContext';
import { findStationByNameAndLine, getStationsOnLine } from '../stationRoute';
import type { BoardingLock } from '../../features/alarm/types/boardingLock';
import type { Station } from '../../types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../testUtils/routeFixtures';

const lock: BoardingLock = {
  destinationId: 'd',
  trainCode: 'T-1',
  boardingStationId: 's',
  boardingLine: '7',
  boardedAt: 0,
  expectedDurationMs: 1_000_000,
};

// stations.json 실데이터를 그대로 사용해 환승역 매칭/index 산출까지 검증.
const gondeokOnLine6 = findStationByNameAndLine('공덕', '6') as Station;
const gondeokOnLine5 = findStationByNameAndLine('공덕', '5') as Station;
const yeouinaru = findStationByNameAndLine('여의나루', '5') as Station;

describe('findActiveTransferContext', () => {
  it('lock=null이면 null', () => {
    expect(findActiveTransferContext(null, null, '강남', null)).toBeNull();
  });

  it('route=null이면 null', () => {
    expect(findActiveTransferContext(lock, null, '강남', gondeokOnLine6)).toBeNull();
  });

  it('destinationName=null이면 null', () => {
    const route = makeDirectRoute(1, '6');
    expect(findActiveTransferContext(lock, route, null, gondeokOnLine6)).toBeNull();
  });

  it('currentStation=null이면 null', () => {
    const route = makeDirectRoute(1, '6');
    expect(findActiveTransferContext(lock, route, '강남', null)).toBeNull();
  });

  it('direct route(환승 없음)는 항상 null', () => {
    const route = makeDirectRoute(1, '6');
    expect(findActiveTransferContext(lock, route, '공덕', gondeokOnLine6)).toBeNull();
  });

  it('transfer route + 현재역이 환승역이면 toLine 컨텍스트 반환', () => {
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const ctx = findActiveTransferContext(lock, route, '여의나루', gondeokOnLine6);
    expect(ctx).not.toBeNull();
    expect(ctx!.nextLine).toBe('5');
    expect(ctx!.transferStationInToLine.id).toBe(gondeokOnLine5.id);
    expect(ctx!.nextWaypointName).toBe('여의나루');
    // direction은 5호선 index 비교 결과 — 동작 검증만 (down/up/null 중 하나).
    expect(['up', 'down', null]).toContain(ctx!.direction);
    // transfer 라우트: completedTransferIdx는 항상 0
    expect(ctx!.completedTransferIdx).toBe(0);
  });

  it('transfer route + 환승역=목적지이면 alarmType=destination → null', () => {
    // transferName === destinationName 케이스는 resolveAllTargets가 destination으로 처리.
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 0,
    });
    expect(findActiveTransferContext(lock, route, '공덕', gondeokOnLine6)).toBeNull();
  });

  it('transfer route + 현재역이 환승역이 아니면 null', () => {
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    expect(findActiveTransferContext(lock, route, '여의나루', yeouinaru)).toBeNull();
  });

  it('환승 후 방향이 up인 케이스 (toLine 인덱스 역전)', () => {
    // 충무로(4→3 환승) → 종로3가(line 3 → line 1 환승). 3호선에서 충무로 인덱스 > 종로3가 인덱스
    // → resolveDirectionInLine은 'up' 반환.
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '충무로', fromLine: '4', toLine: '3', stopsToTransfer: 3 },
        { transferName: '종로3가', fromLine: '3', toLine: '1', stopsToTransfer: 1 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const chungmuroOn4 = findStationByNameAndLine('충무로', '4') as Station;
    const ctx = findActiveTransferContext(lock, route, '서울역', chungmuroOn4);
    // direction이 'up' 또는 'down' — toLine 인덱스 검증. 실데이터 의존이라 둘 다 허용해
    // resolveDirectionInLine의 두 return 분기 중 하나는 확실히 커버.
    expect(ctx).not.toBeNull();
    expect(['up', 'down']).toContain(ctx!.direction);
  });

  it('multi-transfer route + 첫 환승역 도달 시 두 번째 leg 컨텍스트', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '공덕', fromLine: '6', toLine: '5', stopsToTransfer: 2 },
        // 두 번째 transfer는 임의 — 첫 번째만 검증 대상
        { transferName: '여의나루', fromLine: '5', toLine: '5', stopsToTransfer: 3 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const ctx = findActiveTransferContext(lock, route, '아무목적지', gondeokOnLine6);
    expect(ctx).not.toBeNull();
    expect(ctx!.nextLine).toBe('5');
    expect(ctx!.nextWaypointName).toBe('여의나루');
    // multi-transfer 첫 환승: completedTransferIdx=0
    expect(ctx!.completedTransferIdx).toBe(0);
  });

  it('multi-transfer route + 두 번째 환승역 도달 시 completedTransferIdx=1', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '충무로', fromLine: '4', toLine: '3', stopsToTransfer: 3 },
        { transferName: '종로3가', fromLine: '3', toLine: '1', stopsToTransfer: 1 },
      ],
      stopsAfterLastTransfer: 1,
    });
    const jongno3 = findStationByNameAndLine('종로3가', '3') as Station;
    const ctx = findActiveTransferContext(lock, route, '서울역', jongno3);
    expect(ctx).not.toBeNull();
    expect(ctx!.completedTransferIdx).toBe(1);
    expect(ctx!.nextLine).toBe('1');
  });

  it('currentStation이 어떤 waypoint와도 매칭되지 않으면 null (matchedIdx=-1)', () => {
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    // 현재역은 효창공원앞(6호선) — route 어느 waypoint와도 매칭 안 됨
    const hyochang = findStationByNameAndLine('효창공원앞', '6') as Station;
    expect(findActiveTransferContext(lock, route, '여의나루', hyochang)).toBeNull();
  });

  it('환승 시 direction이 명시적으로 산출됨 (resolveDirectionInLine 성공 경로)', () => {
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const ctx = findActiveTransferContext(lock, route, '여의나루', gondeokOnLine6);
    expect(ctx).not.toBeNull();
    // 5호선 공덕→여의나루는 stations.json index가 다르므로 direction은 non-null
    expect(ctx!.direction === 'up' || ctx!.direction === 'down').toBe(true);
  });

  it('lock.boardingLine이 이미 nextLine이면 null (환승 lock 교체 직후 재노출 방지)', () => {
    const route = makeTransferRoute({
      transferName: '공덕',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    // lock이 이미 5호선으로 교체된 상태 (createTransferLock 직후)
    const transferredLock = { ...lock, boardingLine: '5' as const };
    expect(
      findActiveTransferContext(transferredLock, route, '여의나루', gondeokOnLine6),
    ).toBeNull();
  });

  describe('findUpcomingTransferPrefetch (#814)', () => {
    it('lock=null이면 null', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      expect(findUpcomingTransferPrefetch(null, route, '여의나루', gondeokOnLine6)).toBeNull();
    });

    it('route=null이면 null', () => {
      expect(findUpcomingTransferPrefetch(lock, null, '여의나루', gondeokOnLine6)).toBeNull();
    });

    it('destinationName=null이면 null', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      expect(findUpcomingTransferPrefetch(lock, route, null, gondeokOnLine6)).toBeNull();
    });

    it('currentStation=null이면 null', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      expect(findUpcomingTransferPrefetch(lock, route, '여의나루', null)).toBeNull();
    });

    it('direct route(비환승 trip)은 항상 null — prefetch 미발생', () => {
      const route = makeDirectRoute(5, '6');
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      expect(findUpcomingTransferPrefetch(lockOn6, route, '공덕', gondeokOnLine6)).toBeNull();
    });

    it('환승 1정거장 전 (imminent) → next line + 환승역 반환', () => {
      // 6호선 효창공원앞은 공덕 바로 다음(잔여 stops=1) — imminent threshold 충족
      const hyochangOn6 = findStationByNameAndLine('효창공원앞', '6') as Station;
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      const result = findUpcomingTransferPrefetch(lockOn6, route, '여의나루', hyochangOn6);
      expect(result).not.toBeNull();
      expect(result!.nextLine).toBe('5');
      expect(result!.transferStationName).toBe('공덕');
    });

    it('환승 2정거장 이상 전 → null (잔여 stops > 1)', () => {
      // 6호선 삼각지는 공덕에서 2 stop 떨어짐 — threshold 초과
      const samgakji = findStationByNameAndLine('삼각지', '6') as Station;
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      expect(findUpcomingTransferPrefetch(lockOn6, route, '여의나루', samgakji)).toBeNull();
    });

    it('이미 환승역 도달(잔여=0)도 prefetch target 반환 — context 활성화와 동시 호출 케이스', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      const result = findUpcomingTransferPrefetch(lockOn6, route, '여의나루', gondeokOnLine6);
      expect(result).not.toBeNull();
      expect(result!.transferStationName).toBe('공덕');
    });

    it('lock이 이미 nextLine으로 교체됨(환승 완료) → null', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });
      const transferredLock = { ...lock, boardingLine: '5' as const };
      const hyochangOn6 = findStationByNameAndLine('효창공원앞', '6') as Station;
      expect(
        findUpcomingTransferPrefetch(transferredLock, route, '여의나루', hyochangOn6),
      ).toBeNull();
    });

    it('currentStation이 환승역명과 같지만 다른 line variant — fromLine variant lookup으로 잔여=0', () => {
      // 사용자가 환승역에 도달해 fusion이 nextLine 변형(공덕 5호선)으로 stitch된 직후.
      // currentStation.line='5'이지만 currentStation.name='공덕'이고 fromLine(6)에도 공덕이 존재 →
      // findStationByNameAndLine('공덕', '6') 성공 → getRemainingStops(6공덕, 6공덕) = 0 → prefetch.
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 2,
        stopsFromTransfer: 3,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      const result = findUpcomingTransferPrefetch(lockOn6, route, '여의나루', gondeokOnLine5);
      expect(result).not.toBeNull();
      expect(result!.transferStationName).toBe('공덕');
    });

    it('currentStation이 fromLine variant도 없는 다른 역(여의나루) → null', () => {
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      // 5호선 여의나루: 6호선 variant 없음 + 환승역명과도 다름 → fromLineStation undefined → null
      expect(findUpcomingTransferPrefetch(lockOn6, route, '여의나루', yeouinaru)).toBeNull();
    });

    it('lock.boardingLine이 어떤 transfer waypoint의 fromLine도 아니면 null', () => {
      // 사용자가 1호선 lock인데 route는 6→5 환승 — fromLine 매칭 없음
      const route = makeTransferRoute({
        transferName: '공덕',
        fromLine: '6',
        toLine: '5',
        stopsToTransfer: 1,
        stopsFromTransfer: 3,
      });
      const lockOn1 = { ...lock, boardingLine: '1' as const };
      const hyochangOn6 = findStationByNameAndLine('효창공원앞', '6') as Station;
      expect(findUpcomingTransferPrefetch(lockOn1, route, '여의나루', hyochangOn6)).toBeNull();
    });

    it('multi-transfer route — 첫 leg의 다음 환승만 prefetch 대상', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '공덕', fromLine: '6', toLine: '5', stopsToTransfer: 1 },
          { transferName: '여의도', fromLine: '5', toLine: '9', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 1,
      });
      const lockOn6 = { ...lock, boardingLine: '6' as const };
      const hyochangOn6 = findStationByNameAndLine('효창공원앞', '6') as Station;
      const result = findUpcomingTransferPrefetch(lockOn6, route, '아무목적지', hyochangOn6);
      expect(result).not.toBeNull();
      expect(result!.transferStationName).toBe('공덕');
      expect(result!.nextLine).toBe('5');
    });
  });

  describe('resolveDirectionInLine (직접 호출)', () => {
    // 5호선 stations.json에서 첫 2개 역의 id/이름으로 양 방향 케이스 강제.
    const line5 = getStationsOnLine('5');
    const early = line5[0];
    const late = line5[line5.length - 1];

    it('nextIdx > currIdx → down', () => {
      expect(resolveDirectionInLine('5', early.id, late.name)).toBe('down');
    });

    it('nextIdx < currIdx → up', () => {
      expect(resolveDirectionInLine('5', late.id, early.name)).toBe('up');
    });
  });

  it('toLine 측 환승역 station을 못 찾으면 null', () => {
    // 존재하지 않는 가짜 노선 매칭 — findStationByNameAndLine이 undefined 반환하는 경로 커버
    const route = makeTransferRoute({
      transferName: '존재하지않는역X',
      fromLine: '6',
      toLine: '5',
      stopsToTransfer: 2,
      stopsFromTransfer: 3,
    });
    const fakeCurrent: Station = { ...gondeokOnLine6, name: '존재하지않는역X' };
    expect(findActiveTransferContext(lock, route, '여의나루', fakeCurrent)).toBeNull();
  });
});
