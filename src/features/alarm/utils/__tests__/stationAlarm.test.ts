import { alarmKey, parseAlarmKey, evaluateAlarmPhase, resolveAllTargets, type AlarmEvent, type AlarmSource } from '../stationAlarm';
import type { TransferRoute, MultiTransferRoute } from '../../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute as makeMultiTransferRouteFixture,
  makeTransferRoute as makeTransferRouteFixture,
} from '../../../../testUtils/routeFixtures';

function makeTransferRoute(
  stopsToTransfer: number,
  stopsFromTransfer: number,
  transferName = '시청',
  fromLine: LineNumber = '1',
  toLine: LineNumber = '2',
): TransferRoute {
  return makeTransferRouteFixture({
    transferName,
    fromLine,
    toLine,
    stopsToTransfer,
    stopsFromTransfer,
  });
}

function makeMultiRoute(
  stops1: number,
  stops2: number,
  stopsAfter: number,
  t1Name = '시청',
  t2Name = '충무로',
): MultiTransferRoute {
  return makeMultiTransferRouteFixture({
    transfers: [
      { transferName: t1Name, fromLine: '1', toLine: '3', stopsToTransfer: stops1 },
      { transferName: t2Name, fromLine: '3', toLine: '4', stopsToTransfer: stops2 },
    ],
    stopsAfterLastTransfer: stopsAfter,
  });
}

function defaultCurrentLine(route: AlarmSource['route']): LineNumber | null {
  if (!route) return null;
  if (route.type === 'direct') return route.line;
  if (route.type === 'transfer') return route.fromLine;
  return route.transfers[0].fromLine;
}

function source(overrides: Partial<AlarmSource> & Pick<AlarmSource, 'route' | 'destinationName'>): AlarmSource {
  return {
    etaSeconds: null,
    currentLine: defaultCurrentLine(overrides.route),
    ...overrides,
  };
}

describe('alarmKey', () => {
  it('returns phaseId:stationName format', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
    expect(alarmKey(event)).toBe('early:강남');
  });

  it('differentiates phases for the same station', () => {
    expect(alarmKey({ phaseId: 'imminent', stationName: '강남' })).toBe('imminent:강남');
  });

  // #1367 — cross-station 다중 알림 방지: 같은 stationName이 route에 중복 등장하는 hop(순환선)을
  // occurrenceIdx로 분리해 dedup이 collide하지 않게 한다. 0(default)은 legacy 형식 보존.
  it('#1367 — occurrenceIdx=0 (default)에는 suffix를 붙이지 않는다 (legacy key 호환)', () => {
    expect(alarmKey({ phaseId: 'early', stationName: '강남', occurrenceIdx: 0 })).toBe('early:강남');
  });

  it('#1367 — occurrenceIdx>=1이면 `#n` suffix로 hop별 dedup key 분리', () => {
    expect(alarmKey({ phaseId: 'early', stationName: '강남', occurrenceIdx: 1 })).toBe('early:강남#1');
    expect(alarmKey({ phaseId: 'imminent', stationName: '강남', occurrenceIdx: 2 })).toBe(
      'imminent:강남#2',
    );
  });
});

describe('parseAlarmKey (#1367)', () => {
  it('legacy key(`phase:station`)를 occurrenceIdx=0으로 정규화한다', () => {
    expect(parseAlarmKey('early:강남')).toEqual({
      phaseId: 'early',
      stationName: '강남',
      occurrenceIdx: 0,
    });
  });

  it('`phase:station#n` 형식에서 occurrenceIdx를 추출한다', () => {
    expect(parseAlarmKey('imminent:강남#2')).toEqual({
      phaseId: 'imminent',
      stationName: '강남',
      occurrenceIdx: 2,
    });
  });

  it('알람 round-trip: alarmKey → parseAlarmKey 일치', () => {
    const input = { phaseId: 'early', stationName: '용마산', occurrenceIdx: 3 };
    expect(parseAlarmKey(alarmKey(input))).toEqual(input);
  });

  it('잘못된 key(콜론 없음)는 null', () => {
    expect(parseAlarmKey('invalid')).toBeNull();
  });

  it('`#` 뒤가 정수가 아니면 stationName 전체를 그대로 유지 (occurrenceIdx=0)', () => {
    expect(parseAlarmKey('early:강남#abc')).toEqual({
      phaseId: 'early',
      stationName: '강남#abc',
      occurrenceIdx: 0,
    });
  });

  it('`#` 뒤가 음수면 0으로 fallback (방어)', () => {
    expect(parseAlarmKey('early:강남#-1')).toEqual({
      phaseId: 'early',
      stationName: '강남#-1',
      occurrenceIdx: 0,
    });
  });
});

describe('resolveAllTargets', () => {
  it('returns single destination for DirectRoute', () => {
    const route = makeDirectRoute(5, '2');
    expect(resolveAllTargets(route, '강남')).toEqual([
      { name: '강남', stops: 5, alarmType: 'destination', approachLine: '2' },
    ]);
  });

  it('returns transfer + destination for TransferRoute with approachLine per leg', () => {
    expect(resolveAllTargets(makeTransferRoute(3, 5), '강남')).toEqual([
      { name: '시청', stops: 3, alarmType: 'transfer', approachLine: '1' },
      { name: '강남', stops: 5, alarmType: 'destination', approachLine: '2' },
    ]);
  });

  it('collapses transfer when transferName equals destination', () => {
    expect(resolveAllTargets(makeTransferRoute(3, 0, '옥수', 'gyeongui', '3'), '옥수')).toEqual([
      { name: '옥수', stops: 3, alarmType: 'destination', approachLine: 'gyeongui' },
    ]);
  });

  it('returns all waypoints in order for MultiTransferRoute with approachLine per leg', () => {
    expect(resolveAllTargets(makeMultiRoute(5, 3, 2), '강남')).toEqual([
      { name: '시청', stops: 5, alarmType: 'transfer', approachLine: '1' },
      { name: '충무로', stops: 3, alarmType: 'transfer', approachLine: '3' },
      { name: '강남', stops: 2, alarmType: 'destination', approachLine: '4' },
    ]);
  });

  it('marks first transfer as destination when name matches', () => {
    expect(resolveAllTargets(makeMultiRoute(1, 5, 3, '옥수'), '옥수')).toEqual([
      { name: '옥수', stops: 1, alarmType: 'destination', approachLine: '1' },
      { name: '충무로', stops: 5, alarmType: 'transfer', approachLine: '3' },
      { name: '옥수', stops: 3, alarmType: 'destination', approachLine: '4' },
    ]);
  });

  it('does not duplicate destination when last transfer name equals destination', () => {
    expect(resolveAllTargets(makeMultiRoute(5, 3, 0, '시청', '강남'), '강남')).toEqual([
      { name: '시청', stops: 5, alarmType: 'transfer', approachLine: '1' },
      { name: '강남', stops: 3, alarmType: 'destination', approachLine: '3' },
    ]);
  });

  // 노선별 표기 차이를 정규화 흡수해서 단일 destination으로 축약 (#401 회귀 방지).
  it('transferName과 destinationName이 노선별 표기 차이만 있으면 단일 destination으로 축약', () => {
    expect(
      resolveAllTargets(makeTransferRoute(3, 0, '상봉', 'gyeongui', '7'), '상봉(시외버스터미널)'),
    ).toEqual([{ name: '상봉(시외버스터미널)', stops: 3, alarmType: 'destination', approachLine: 'gyeongui' }]);
  });

  it('multi-transfer 마지막 환승역 표기 차이도 동일하게 축약', () => {
    expect(
      resolveAllTargets(makeMultiRoute(5, 3, 0, '시청', '왕십리'), '왕십리(성동구청)'),
    ).toEqual([
      { name: '시청', stops: 5, alarmType: 'transfer', approachLine: '1' },
      { name: '왕십리(성동구청)', stops: 3, alarmType: 'destination', approachLine: '3' },
    ]);
  });
});

// V/X acceptance 임계 직접 검증 (feedback_v_x_acceptance_full_table)
describe('V2 — 직접 경로 transfer 알람 없음 (hop=0, transfer type 미발사)', () => {
  const destinationName = '강남';

  // V2: hop ≤ 1 (direct) → transfer 타입 알람은 어떤 stops 값에서도 나오지 않는다.
  it.each([0, 1, 2, 5])(
    'DirectRoute stops=%i → evaluateAlarmPhase 결과 type이 transfer가 아님',
    (stops) => {
      const route = makeDirectRoute(stops, '2');
      const result = evaluateAlarmPhase(source({ route, destinationName }), new Set());
      expect(result?.type).not.toBe('transfer');
    },
  );
});

describe('V2 — 환승 경로 transfer 알람 정확히 1회 (idempotent)', () => {
  const destinationName = '강남';

  // V2: hop ≥ 2 (transfer) → early:transfer 는 fired set에 적재 후 재호출 시 null
  it('TransferRoute early:transfer가 이미 fired set에 있으면 동일 phase 재발사 X', () => {
    const route = makeTransferRoute(1, 5);
    const fired = new Set<string>();
    const first = evaluateAlarmPhase(source({ route, destinationName }), fired);
    expect(first).toEqual({ phaseId: 'early', type: 'transfer', stationName: '시청' });
    // 실제 훅은 발사 후 alarmKey를 fired에 추가한다.
    fired.add(alarmKey(first!));
    const second = evaluateAlarmPhase(source({ route, destinationName }), fired);
    // 같은 phase 재호출은 null — 중복 fire 없음 (X2 보조 검증).
    expect(second?.phaseId).not.toBe('early');
  });
});

describe('evaluateAlarmPhase', () => {
  const destinationName = '강남';

  it('returns null for null route', () => {
    expect(evaluateAlarmPhase(source({ route: null, destinationName }), new Set())).toBeNull();
  });

  describe('DirectRoute — early phase', () => {
    it('fires early at stops === 1', () => {
      const route = makeDirectRoute(1, '2');
      expect(evaluateAlarmPhase(source({ route, destinationName }), new Set())).toEqual({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('does not fire when stops > 1', () => {
      const route = makeDirectRoute(2, '2');
      expect(evaluateAlarmPhase(source({ route, destinationName }), new Set())).toBeNull();
    });

    it('skips early when already fired', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName }), fired)).toBeNull();
    });
  });

  describe('DirectRoute — imminent phase', () => {
    it('fires imminent after early when eta within 10s', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 8 }), fired)).toEqual({
        phaseId: 'imminent',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('does not fire imminent when eta exceeds 10s', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 30 }), fired)).toBeNull();
    });

    it('prefers early over imminent when both qualify and neither fired', () => {
      const route = makeDirectRoute(1, '2');
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 5 }), new Set())).toEqual({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('skips imminent when already fired', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남', 'imminent:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 5 }), fired)).toBeNull();
    });

    it('does not fire imminent at stops 0 if remainingStops gate fails — gate allows 0 so it does fire', () => {
      const route = makeDirectRoute(0, '2');
      expect(evaluateAlarmPhase(source({ route, destinationName }), new Set())).toEqual({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
    });
  });

  describe('TransferRoute', () => {
    it('fires early for transfer when stopsToTransfer === 1', () => {
      expect(
        evaluateAlarmPhase(source({ route: makeTransferRoute(1, 5), destinationName }), new Set()),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '시청' });
    });

    it('does not fire when transfer is far even if destination eta is close', () => {
      const fired = new Set<string>();
      // 환승까지 5정거장 → 환승역 early 미발사, 도착역 stops=2도 미해당
      expect(
        evaluateAlarmPhase(
          source({ route: makeTransferRoute(5, 2), destinationName, etaSeconds: 5 }),
          fired,
        ),
      ).toBeNull();
    });

    it('fires transfer early without consuming destination eta (eta routed to final waypoint only)', () => {
      // 환승 1정거장 전, 도착 5정거장 후. eta는 도착역 한정 신호이므로 환승 imminent에는 적용되지 않는다.
      expect(
        evaluateAlarmPhase(
          source({ route: makeTransferRoute(1, 5), destinationName, etaSeconds: 5 }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '시청' });
    });

    it('routes external eta to destination once transfer is passed (stops=0)', () => {
      // 환승 통과(stops=0), 도착 1정거장 전, eta 5초 → 도착역 imminent 발사 가능.
      // currentLine='2'는 user가 환승 후 toLine으로 이동했음을 의미.
      const fired = new Set(['early:시청', 'imminent:시청', 'early:강남']);
      expect(
        evaluateAlarmPhase(
          source({ route: makeTransferRoute(0, 1), destinationName, etaSeconds: 5, currentLine: '2' }),
          fired,
        ),
      ).toEqual({ phaseId: 'imminent', type: 'destination', stationName: '강남' });
    });

    it('fires destination alarm when transferName equals destination and approaches', () => {
      expect(
        evaluateAlarmPhase(
          source({ route: makeTransferRoute(1, 0, '옥수', '5', '6'), destinationName: '옥수' }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '옥수' });
    });

    it('returns destination alarm after transfer early is fired and destination is close', () => {
      // user가 toLine='2'로 이동한 직후. transfer/early는 이미 fired.
      const fired = new Set(['early:시청']);
      expect(
        evaluateAlarmPhase(source({ route: makeTransferRoute(0, 1), destinationName, currentLine: '2' }), fired),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
    });
  });

  describe('MultiTransferRoute', () => {
    it('fires first transfer at stopsToTransfer === 1', () => {
      expect(
        evaluateAlarmPhase(source({ route: makeMultiRoute(1, 5, 3), destinationName }), new Set()),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '시청' });
    });

    it('proceeds to second transfer after first is fired', () => {
      // user는 두 번째 leg(line '3')로 이동.
      const fired = new Set(['early:시청']);
      expect(
        evaluateAlarmPhase(source({ route: makeMultiRoute(0, 1, 3), destinationName, currentLine: '3' }), fired),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '충무로' });
    });

    it('proceeds to destination after both transfers fired', () => {
      // user는 마지막 leg(line '4')로 이동.
      const fired = new Set(['early:시청', 'early:충무로']);
      expect(
        evaluateAlarmPhase(source({ route: makeMultiRoute(0, 0, 1), destinationName, currentLine: '4' }), fired),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
    });

    it('does not fire at the start of multi-segment route (regression: #152)', () => {
      // 용마산 → 강남구청(7) → 선릉(2) → 역삼(1)
      expect(
        evaluateAlarmPhase(
          source({ route: makeMultiRoute(7, 2, 1, '강남구청', '선릉'), destinationName: '역삼' }),
          new Set(),
        ),
      ).toBeNull();
    });

    it('fires alarms sequentially through full journey', () => {
      const fired = new Set<string>();
      // 1st leg (fromLine='1'): 시청 transfer/early
      const step1 = evaluateAlarmPhase(source({ route: makeMultiRoute(1, 5, 3), destinationName, currentLine: '1' }), fired);
      expect(step1).toEqual({ phaseId: 'early', type: 'transfer', stationName: '시청' });
      fired.add(alarmKey(step1!));

      // 2nd leg (line='3'): 충무로 transfer/early
      const step2 = evaluateAlarmPhase(source({ route: makeMultiRoute(0, 1, 3), destinationName, currentLine: '3' }), fired);
      expect(step2).toEqual({ phaseId: 'early', type: 'transfer', stationName: '충무로' });
      fired.add(alarmKey(step2!));

      // 3rd leg (line='4'): 강남 destination/early
      const step3 = evaluateAlarmPhase(source({ route: makeMultiRoute(0, 0, 1), destinationName, currentLine: '4' }), fired);
      expect(step3).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
    });
  });

  describe('currentLine gate (#579)', () => {
    it('returns null when currentLine is null (GPS line unknown)', () => {
      const route = makeTransferRoute(1, 5);
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '강남', currentLine: null }),
          new Set(),
        ),
      ).toBeNull();
    });

    it('does not fire destination/early on transfer route when user is on fromLine even if stopsFromTransfer <= 1', () => {
      // 용마산(7) → 건대입구(transfer) → 성수(2) 회귀: stopsFromTransfer=1이지만 user는 line 7에 있음.
      // currentLine='7' 이면 destination 웨이포인트(approachLine='2')는 평가 대상이 아님.
      const route = makeTransferRoute(3, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '7' }),
          new Set(),
        ),
      ).toBeNull();
    });

    it('fires destination/early once user is on toLine and approaches', () => {
      // 환승 완료 후 line 2에 있을 때 destination/early 발사.
      const route = makeTransferRoute(0, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '2' }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '성수' });
    });

    it('fires transfer/early when user is on fromLine approaching transfer', () => {
      const route = makeTransferRoute(1, 5, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '7' }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '건대입구' });
    });

    it('returns null when currentLine does not match any leg (GPS noise → other line)', () => {
      const route = makeTransferRoute(1, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '5' }),
          new Set(),
        ),
      ).toBeNull();
    });

    // #2464 — 건대입구(7→2) 실환승 회귀: 환승 타겟에 아직 도달 전(stops>0)인데
    // currentLine이 station complex GPS/fusion jitter로 toLine(2)으로 조기 flip되면,
    // 기존 로직은 미도달 환승 타겟을 건너뛰고 도착 타겟(approachLine=toLine)으로
    // 오매칭돼 "환승하세요" 안내가 통째로 스킵됐다. stops>0인 미도달 타겟은
    // currentLine mismatch 시 다음 leg로 fall-through하지 않고 그 tick은 보류(null)해야 한다.
    it('#2464 — 환승 타겟 미도달(stops>0)인데 currentLine이 toLine으로 조기 flip되면 도착 타겟으로 오매칭하지 않는다', () => {
      // 건대입구 1정거장 전(stopsToTransfer=1, 아직 미도달) — currentLine은 이미 '2'로 flip.
      const route = makeTransferRoute(1, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '2' }),
          new Set(),
        ),
      ).toBeNull();
    });

    it('#2464 — currentLine이 fromLine으로 복귀하면 보류됐던 환승 알람이 정상 발사된다', () => {
      // 위 케이스와 동일 route/stops. currentLine만 올바른 값(fromLine='7')으로 복귀.
      const route = makeTransferRoute(1, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '7' }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'transfer', stationName: '건대입구' });
    });

    it('#2464 — 환승 타겟을 이미 통과(stops<=0)했다면 currentLine mismatch여도 다음 leg로 정상 진행한다', () => {
      // 환승역 통과(stops=0), 도착역 1정거장 전. currentLine='2'(toLine)로 정상 매칭.
      const route = makeTransferRoute(0, 1, '건대입구', '7', '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '성수', currentLine: '2' }),
          new Set(),
        ),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '성수' });
    });

    it('#2464 — 유일한 타겟이 이미 통과(stops<=0)했지만 currentLine이 어느 leg와도 안 맞으면 loop 끝까지 진행 후 null', () => {
      // DirectRoute stops=0(이미 도달) + currentLine mismatch → stops<=0이라 continue하지만
      // 더 이상 평가할 leg가 없어 loop 종료 후 최종 null로 떨어진다.
      const route = makeDirectRoute(0, '2');
      expect(
        evaluateAlarmPhase(
          source({ route, destinationName: '강남', currentLine: '5' }),
          new Set(),
        ),
      ).toBeNull();
    });
  });

  describe('suppressedOut out-param (#580)', () => {
    it('phase 조건은 만족했지만 firedAlarms로 dedup된 이벤트를 suppressedOut에 push', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남']);
      const suppressed: AlarmEvent[] = [];
      const event = evaluateAlarmPhase(
        source({ route, destinationName: '강남' }),
        fired,
        undefined,
        suppressed,
      );
      expect(event).toBeNull();
      expect(suppressed).toEqual([
        { phaseId: 'early', type: 'destination', stationName: '강남' },
      ]);
    });

    it('phase 조건 미충족이면 dedup이어도 suppressedOut에 적재하지 않음 (노이즈 제거)', () => {
      // stops=2 → early(stops<=1) 미충족. firedAlarms에 있어도 phase가 조건 미만이라 적재 안 함.
      const route = makeDirectRoute(2, '2');
      const fired = new Set(['early:강남']);
      const suppressed: AlarmEvent[] = [];
      evaluateAlarmPhase(source({ route, destinationName: '강남' }), fired, undefined, suppressed);
      expect(suppressed).toEqual([]);
    });

    it('suppressedOut 미전달 시 dedup은 silent (이전 동작)', () => {
      const route = makeDirectRoute(1, '2');
      const fired = new Set(['early:강남']);
      // suppressedOut 인자 생략 — 예외 없이 null 반환.
      expect(evaluateAlarmPhase(source({ route, destinationName: '강남' }), fired)).toBeNull();
    });
  });

  describe('custom phases', () => {
    it('accepts a custom phase array', () => {
      const route = makeDirectRoute(3, '2');
      const customPhases = [
        {
          id: 'early' as const,
          evaluate: (ctx: { remainingStops: number }) => ctx.remainingStops <= 3,
          getLeadMs: (hopMs: number) => hopMs,
        },
      ];
      expect(
        evaluateAlarmPhase(source({ route, destinationName }), new Set(), customPhases),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
    });
  });

  describe('#903 Seam G — degradedConfidence (gps-only-underground 강등 시 게이트)', () => {
    const directRoute1 = makeDirectRoute(1, '2');
    const transferRoute1 = makeTransferRoute(1, 5);
    const evalDegraded = (
      overrides: Partial<Parameters<typeof source>[0]>,
      fired: Set<string> = new Set(),
    ) => evaluateAlarmPhase(source({ route: directRoute1, destinationName, ...overrides }), fired);

    it.each([
      { label: 'degraded=true + destination/early → 보류', overrides: { degradedConfidence: true }, expected: null },
      {
        label: 'degraded=false → early 정상 발사 (제어군)',
        overrides: { degradedConfidence: false },
        expected: { phaseId: 'early', type: 'destination', stationName: '강남' },
      },
      {
        label: 'degraded=true + transfer 카테고리 → 보류',
        overrides: { route: transferRoute1, degradedConfidence: true },
        expected: null,
      },
      {
        label: 'degraded=true + imminent(ETA 5s) → destination imminent 통과',
        overrides: { etaSeconds: 5, degradedConfidence: true },
        expected: { phaseId: 'imminent', type: 'destination', stationName: '강남' },
      },
      {
        label: 'degraded 미전달(undefined) → 기존 동작 (graceful)',
        overrides: {},
        expected: { phaseId: 'early', type: 'destination', stationName: '강남' },
      },
    ])('$label', ({ overrides, expected }) => {
      expect(evalDegraded(overrides)).toEqual(expected);
    });

    it('지하→지상 복귀 회귀 (시청 환승 fixture) — degraded 동안 보류, 복귀 후 정상 발사', () => {
      // 환승역 시청 1정거장 남음. degraded=true → transfer/early 보류 → fired 0건.
      // degraded=false → 정상 transfer early 발사.
      const fired = new Set<string>();
      const transferContext = (degraded: boolean) =>
        source({
          route: makeTransferRoute(1, 5, '시청'),
          destinationName,
          degradedConfidence: degraded,
          currentLine: '1',
        });
      expect(evaluateAlarmPhase(transferContext(true), fired)).toBeNull();
      expect(fired.size).toBe(0);
      expect(evaluateAlarmPhase(transferContext(false), fired)).toEqual({
        phaseId: 'early',
        type: 'transfer',
        stationName: '시청',
      });
    });
  });
});
