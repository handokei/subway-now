import { alarmKey, evaluateAlarmPhase, resolveAllTargets, type AlarmEvent, type AlarmSource } from '../stationAlarm';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';
import type { LineNumber } from '../../types/station';

function makeTransferRoute(
  stopsToTransfer: number,
  stopsFromTransfer: number,
  transferName = '시청',
  fromLine: LineNumber = '1',
  toLine: LineNumber = '2',
): TransferRoute {
  return { type: 'transfer', transferName, fromLine, toLine, stopsToTransfer, stopsFromTransfer };
}

function makeMultiRoute(
  stops1: number,
  stops2: number,
  stopsAfter: number,
  t1Name = '시청',
  t2Name = '충무로',
): MultiTransferRoute {
  return {
    type: 'multi-transfer',
    transfers: [
      { transferName: t1Name, fromLine: '1', toLine: '3', stopsToTransfer: stops1 },
      { transferName: t2Name, fromLine: '3', toLine: '4', stopsToTransfer: stops2 },
    ],
    stopsAfterLastTransfer: stopsAfter,
  };
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
});

describe('resolveAllTargets', () => {
  it('returns single destination for DirectRoute', () => {
    const route: DirectRoute = { type: 'direct', stops: 5, line: '2' };
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

describe('evaluateAlarmPhase', () => {
  const destinationName = '강남';

  it('returns null for null route', () => {
    expect(evaluateAlarmPhase(source({ route: null, destinationName }), new Set())).toBeNull();
  });

  describe('DirectRoute — early phase', () => {
    it('fires early at stops === 1', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      expect(evaluateAlarmPhase(source({ route, destinationName }), new Set())).toEqual({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('does not fire when stops > 1', () => {
      const route: DirectRoute = { type: 'direct', stops: 2, line: '2' };
      expect(evaluateAlarmPhase(source({ route, destinationName }), new Set())).toBeNull();
    });

    it('skips early when already fired', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName }), fired)).toBeNull();
    });
  });

  describe('DirectRoute — imminent phase', () => {
    it('fires imminent after early when eta within 10s', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 8 }), fired)).toEqual({
        phaseId: 'imminent',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('does not fire imminent when eta exceeds 10s', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      const fired = new Set(['early:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 30 }), fired)).toBeNull();
    });

    it('prefers early over imminent when both qualify and neither fired', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 5 }), new Set())).toEqual({
        phaseId: 'early',
        type: 'destination',
        stationName: '강남',
      });
    });

    it('skips imminent when already fired', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      const fired = new Set(['early:강남', 'imminent:강남']);
      expect(evaluateAlarmPhase(source({ route, destinationName, etaSeconds: 5 }), fired)).toBeNull();
    });

    it('does not fire imminent at stops 0 if remainingStops gate fails — gate allows 0 so it does fire', () => {
      const route: DirectRoute = { type: 'direct', stops: 0, line: '2' };
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
  });

  describe('suppressedOut out-param (#580)', () => {
    it('phase 조건은 만족했지만 firedAlarms로 dedup된 이벤트를 suppressedOut에 push', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
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
      const route: DirectRoute = { type: 'direct', stops: 2, line: '2' };
      const fired = new Set(['early:강남']);
      const suppressed: AlarmEvent[] = [];
      evaluateAlarmPhase(source({ route, destinationName: '강남' }), fired, undefined, suppressed);
      expect(suppressed).toEqual([]);
    });

    it('suppressedOut 미전달 시 dedup은 silent (이전 동작)', () => {
      const route: DirectRoute = { type: 'direct', stops: 1, line: '2' };
      const fired = new Set(['early:강남']);
      // suppressedOut 인자 생략 — 예외 없이 null 반환.
      expect(evaluateAlarmPhase(source({ route, destinationName: '강남' }), fired)).toBeNull();
    });
  });

  describe('custom phases', () => {
    it('accepts a custom phase array', () => {
      const route: DirectRoute = { type: 'direct', stops: 3, line: '2' };
      const customPhases = [
        {
          id: 'early' as const,
          evaluate: (ctx: { remainingStops: number }) => ctx.remainingStops <= 3,
        },
      ];
      expect(
        evaluateAlarmPhase(source({ route, destinationName }), new Set(), customPhases),
      ).toEqual({ phaseId: 'early', type: 'destination', stationName: '강남' });
    });
  });
});
