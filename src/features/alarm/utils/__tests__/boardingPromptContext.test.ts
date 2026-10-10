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

    it('순환선(2호선) — resolveTravelDirection null이지만 inferLoopDirection fallback으로 up 채움 (#1703, #2872)', () => {
      // 시청(2-001) → 을지로3가(2-003): forward=2, backward=41 → forward 짧음 → up(내선순환, #2867
      // ground truth: 내선=id 증가='up'. #2872 전까지는 역전된 'down'이 나왔다).
      // 이전엔 null이었지만 #1703 wiring으로 순환선도 backend가 양방향 후보 ambiguity 회피.
      const ctx = buildBoardingPromptContext({
        route: makeDirectRoute(2, '2'),
        currentStation: st('2-001'),
        destination: st('2-003'),
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptGeoContext.direction).toBe('up');
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

    it(
      '#2946 (거부 케이스 ⓑ 회귀 가드) — 시청→충정로(2호선 seam)는 down 그대로 ' +
        '(directionOnLine으로 교체 시도했으나 wraparound seam에서 반대 방향을 내는 ' +
        '별도 결함을 발견해 되돌렸다 — PR 본문 참고. 이 값이 up으로 바뀌면 2호선 회귀)',
      () => {
        const ctx = buildBoardingPromptContext({
          route: makeDirectRoute(20, '2'),
          currentStation: st('2-001'), // 시청
          destination: st('2-043'), // 충정로(경기대입구)
        });
        expect(ctx).not.toBeNull();
        expect(ctx?.promptGeoContext.direction).toBe('down');
      },
    );

    it(
      '#2946 (거부 케이스 ⓑ 회귀 가드) — 시청→교대(법원.검찰청)도 down 그대로 ' +
        '(시청→충정로와 동일 seam 성격)',
      () => {
        const ctx = buildBoardingPromptContext({
          route: makeDirectRoute(22, '2'),
          currentStation: st('2-001'), // 시청
          destination: st('2-023'), // 교대(법원.검찰청)
        });
        expect(ctx).not.toBeNull();
        expect(ctx?.promptGeoContext.direction).toBe('down');
      },
    );

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

    it('lock 활성 + 순환선(2호선) → inferLoopDirection fallback이 direction 채움 (#2872)', () => {
      // 시청(2-001) → 을지로3가(2-003) 구간에 lock. 순환선이라 resolveTravelDirection null이지만
      // inferLoopDirection이 up(내선순환, #2867 ground truth)을 채워야 함.
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
      expect(ctx?.promptGeoContext.direction).toBe('up');
      expect(ctx?.promptDisplay.line).toBe('2');
    });
  });

  // #2830 — lock 미활성(lockless) leg-2 환승 후 프롬프트가 leg-1 line으로 stale 발사되던 회귀.
  // 뚝섬(2) → 건대입구 환승 → 용마산(7). currentStation=건대입구(환승 완료 지점), lock 없음.
  describe('#2830 lock 미활성 — leg-2 lockless 환승 후', () => {
    it('환승역 도달(currentStation=건대입구) → nextLine(7) 기준으로 stamp (leg-1 line=2 아님)', () => {
      const current = st('7-019'); // 건대입구 (7호선 변형 — 환승 후 toLine 기준 station)
      const dest = st('7-015'); // 용마산
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: '건대입구',
          fromLine: '2',
          toLine: '7',
          stopsToTransfer: 2,
          stopsFromTransfer: 4,
        }),
        currentStation: current,
        destination: dest,
        lock: null,
      });
      expect(ctx).not.toBeNull();
      // 회귀: 기존 코드는 getFirstLeg(route)=fromLine('2')를 그대로 써서 line이 '2'로 stale 고정됐다.
      // fix 후에는 leg-2(환승 후 진행 leg)의 nextLine('7')로 stamp돼야 한다.
      expect(ctx?.promptDisplay.line).toBe('7');
      expect(ctx?.promptDisplay.originStation).toBe('건대입구');
      // 건대입구(7-019) → 용마산(7-015) 방향의 다음 역은 어린이대공원.
      const next = st('7-018');
      expect(ctx?.promptGeoContext.nextStation).toEqual({ lat: next.lat, lng: next.lng });
    });

    it('leg-1 진행 중(currentStation=성수, transfer target 아님) → line 불변(기존 getFirstLeg 경로)', () => {
      const current = st('2-011'); // 성수 (line 2, leg-1 진행 중 — transfer target 아님)
      const dest = st('7-015'); // 용마산
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: '건대입구',
          fromLine: '2',
          toLine: '7',
          stopsToTransfer: 2,
          stopsFromTransfer: 4,
        }),
        currentStation: current,
        destination: dest,
        lock: null,
      });
      expect(ctx).not.toBeNull();
      expect(ctx?.promptDisplay.line).toBe('2');
      expect(ctx?.promptDisplay.originStation).toBe('성수');
    });
  });

  // #2858 — 10/1 실측 root. #2830은 currentStation이 **정확히** 환승역일 때만 매칭(exact name).
  // 환승 release 이후 사용자가 leg-2를 한 정거장이라도 더 진행하면(=환승역 자체가 아님) 매칭이
  // 다시 깨져 getFirstLeg(leg-1)로 fall back한다 — "뚝섬→성수 2호선 탑승하셨나요" 좀비 프롬프트.
  describe('#2858 lock 미활성 — 환승 release 후 leg-2를 더 진행한 상태(건대입구 자체 아님)', () => {
    it('환승역을 지나 leg-2 다음 역에 있음(currentStation=어린이대공원) → nextLine(7) 기준으로 stamp (leg-1 line=2로 회귀 금지)', () => {
      const current = st('7-018'); // 어린이대공원 — 건대입구(7-019) 다음 역, 용마산 방향
      const dest = st('7-015'); // 용마산
      const ctx = buildBoardingPromptContext({
        route: makeTransferRoute({
          transferName: '건대입구',
          fromLine: '2',
          toLine: '7',
          stopsToTransfer: 2,
          stopsFromTransfer: 4,
        }),
        currentStation: current,
        destination: dest,
        lock: null,
      });
      expect(ctx).not.toBeNull();
      // RED(기존 코드): findLocklessTransferWaypoint는 currentStation==='건대입구' exact match만
      // 인정 — '어린이대공원'은 매칭 실패해 getFirstLeg(fromLine='2')로 fall back, line이 '2'로
      // stale 고정된다. GREEN(fix 후): leg-2(7)로 stamp돼야 한다.
      expect(ctx?.promptDisplay.line).toBe('7');
      expect(ctx?.promptDisplay.originStation).toBe(current.name);
    });
  });
});
