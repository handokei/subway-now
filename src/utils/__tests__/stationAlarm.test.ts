import { checkAlarm, checkTimeBasedAlarm, alarmKey, estimateRemainingSeconds, resolveCurrentTarget, AlarmEvent } from '../stationAlarm';
import type { DirectRoute, TransferRoute, MultiTransferRoute, Route } from '../stationRoute';

// ── 테스트 헬퍼 ──

function makeTransferRoute(
  stopsToTransfer: number,
  stopsFromTransfer: number,
  transferName = '시청',
  fromLine = '1',
  toLine = '2',
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

describe('alarmKey', () => {
  it('should return type:stationName format', () => {
    const event: AlarmEvent = { type: 'destination', stationName: '강남' };
    expect(alarmKey(event)).toBe('destination:강남');
  });

  it('should return transfer key', () => {
    const event: AlarmEvent = { type: 'transfer', stationName: '시청' };
    expect(alarmKey(event)).toBe('transfer:시청');
  });

  it('should return time-based destination key', () => {
    const event: AlarmEvent = { type: 'destination', stationName: '강남', timeBased: true };
    expect(alarmKey(event)).toBe('time-destination:강남');
  });

  it('should return time-based transfer key', () => {
    const event: AlarmEvent = { type: 'transfer', stationName: '시청', timeBased: true };
    expect(alarmKey(event)).toBe('time-transfer:시청');
  });

  it('should return approaching key', () => {
    const event: AlarmEvent = { type: 'approaching', stationName: '역삼', timeBased: true };
    expect(alarmKey(event)).toBe('time-approaching:역삼');
  });
});

describe('estimateRemainingSeconds', () => {
  it('should return 0 for 0 stops', () => {
    expect(estimateRemainingSeconds(0)).toBe(0);
  });

  it('should return 120 for 1 stop', () => {
    expect(estimateRemainingSeconds(1)).toBe(120);
  });

  it('should return 360 for 3 stops', () => {
    expect(estimateRemainingSeconds(3)).toBe(360);
  });
});

describe('resolveCurrentTarget', () => {
  describe('DirectRoute', () => {
    it('should target destination', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      expect(resolveCurrentTarget(route, '강남')).toEqual({
        name: '강남', stops: 5, alarmType: 'destination',
      });
    });
  });

  describe('TransferRoute', () => {
    it('should target transfer when stopsToTransfer > 0', () => {
      expect(resolveCurrentTarget(makeTransferRoute(3, 5), '강남')).toEqual({
        name: '시청', stops: 3, alarmType: 'transfer',
      });
    });

    it('should target transfer when stopsToTransfer = 0 (user at transfer)', () => {
      expect(resolveCurrentTarget(makeTransferRoute(0, 5), '강남')).toEqual({
        name: '시청', stops: 0, alarmType: 'transfer',
      });
    });

    it('should target destination when transferName = destinationName', () => {
      expect(resolveCurrentTarget(makeTransferRoute(3, 0, '옥수', 'gyeongui', '3'), '옥수')).toEqual({
        name: '옥수', stops: 3, alarmType: 'destination',
      });
    });
  });

  describe('MultiTransferRoute', () => {
    it('should target first transfer (current segment)', () => {
      expect(resolveCurrentTarget(makeMultiRoute(5, 1, 3), '강남')).toEqual({
        name: '시청', stops: 5, alarmType: 'transfer',
      });
    });

    it('should target first transfer even when later segments are closer', () => {
      expect(resolveCurrentTarget(makeMultiRoute(7, 2, 1, '강남구청', '선릉'), '역삼')).toEqual({
        name: '강남구청', stops: 7, alarmType: 'transfer',
      });
    });

    it('should target destination when first transferName = destinationName', () => {
      expect(resolveCurrentTarget(makeMultiRoute(1, 5, 3, '옥수'), '옥수')).toEqual({
        name: '옥수', stops: 1, alarmType: 'destination',
      });
    });

    it('should target first transfer when stopsToTransfer = 0', () => {
      expect(resolveCurrentTarget(makeMultiRoute(0, 5, 3), '강남')).toEqual({
        name: '시청', stops: 0, alarmType: 'transfer',
      });
    });

    it('should target destination when first transferName = destinationName and stopsToTransfer = 0', () => {
      expect(resolveCurrentTarget(makeMultiRoute(0, 5, 3, '옥수'), '옥수')).toEqual({
        name: '옥수', stops: 0, alarmType: 'destination',
      });
    });
  });
});

describe('checkAlarm', () => {
  const destinationName = '강남';

  it('should return null for null route', () => {
    expect(checkAlarm(null, destinationName, new Set())).toBeNull();
  });

  // DirectRoute
  describe('DirectRoute', () => {
    it('should return destination alarm when stops === 1', () => {
      const route: DirectRoute = { type: 'direct', stops: 1 };
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남' });
    });

    it('should return destination alarm when stops === 0', () => {
      const route: DirectRoute = { type: 'direct', stops: 0 };
      expect(checkAlarm(route, destinationName, new Set())).toEqual({
        type: 'destination',
        stationName: '강남',
      });
    });

    it('should return null when stops === 2', () => {
      const route: DirectRoute = { type: 'direct', stops: 2 };
      expect(checkAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return null when already fired', () => {
      const route: DirectRoute = { type: 'direct', stops: 1 };
      const fired = new Set(['destination:강남']);
      expect(checkAlarm(route, destinationName, fired)).toBeNull();
    });
  });

  // TransferRoute
  describe('TransferRoute', () => {
    it('should return transfer alarm when stopsToTransfer === 1', () => {
      expect(checkAlarm(makeTransferRoute(1, 5), destinationName, new Set()))
        .toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return null when stopsToTransfer > threshold even if stopsFromTransfer <= threshold', () => {
      expect(checkAlarm(makeTransferRoute(5, 1), destinationName, new Set())).toBeNull();
    });

    it('should return null when neither is 1', () => {
      expect(checkAlarm(makeTransferRoute(3, 5), destinationName, new Set())).toBeNull();
    });

    it('should return null when transfer alarm already fired', () => {
      const fired = new Set(['transfer:시청']);
      expect(checkAlarm(makeTransferRoute(1, 5), destinationName, fired)).toBeNull();
    });

    it('should return destination alarm when transferName equals destinationName and stopsToTransfer <= 1', () => {
      expect(checkAlarm(makeTransferRoute(0, 0, '옥수', 'gyeongui', '3'), '옥수', new Set()))
        .toEqual({ type: 'destination', stationName: '옥수' });
    });

    it('should return null when transferName equals destinationName but stopsToTransfer > 1', () => {
      expect(checkAlarm(makeTransferRoute(3, 0, '옥수', 'gyeongui', '3'), '옥수', new Set())).toBeNull();
    });

    it('should return destination alarm when transferName equals destinationName and both stops <= 1', () => {
      expect(checkAlarm(makeTransferRoute(1, 0, '공덕', '5', '6'), '공덕', new Set()))
        .toEqual({ type: 'destination', stationName: '공덕' });
    });

    it('should prioritize transfer over destination when both are 1', () => {
      expect(checkAlarm(makeTransferRoute(1, 1), destinationName, new Set()))
        .toEqual({ type: 'transfer', stationName: '시청' });
    });
  });

  // MultiTransferRoute
  describe('MultiTransferRoute', () => {
    it('should return transfer alarm for first transfer when stopsToTransfer === 1', () => {
      const route = makeMultiRoute(1, 5, 3);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return null when first stopsToTransfer > threshold even if second <= threshold', () => {
      const route = makeMultiRoute(5, 1, 3);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toBeNull();
    });

    it('should return null when first stopsToTransfer > threshold even if stopsAfterLastTransfer <= threshold', () => {
      const route = makeMultiRoute(5, 3, 1);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toBeNull();
    });

    it('should return null when no stops are 1', () => {
      const route = makeMultiRoute(3, 4, 5);
      expect(checkAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return null when already fired', () => {
      const route = makeMultiRoute(1, 5, 3);
      const fired = new Set(['transfer:시청']);
      expect(checkAlarm(route, destinationName, fired)).toBeNull();
    });

    it('should prioritize first transfer over second when both are 1', () => {
      const route = makeMultiRoute(1, 1, 3);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return null when first stopsToTransfer > threshold even if second and stopsAfter <= threshold', () => {
      const route = makeMultiRoute(5, 1, 1);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toBeNull();
    });

    it('should return destination alarm when first transferName equals destinationName', () => {
      expect(checkAlarm(makeMultiRoute(1, 5, 3, '옥수'), '옥수', new Set()))
        .toEqual({ type: 'destination', stationName: '옥수' });
    });

    it('should return null when second transferName equals destinationName but first stopsToTransfer > threshold', () => {
      expect(checkAlarm(makeMultiRoute(5, 1, 0, '시청', '옥수'), '옥수', new Set())).toBeNull();
    });

    it('should return null when transferName equals destinationName but stopsToTransfer > threshold', () => {
      expect(checkAlarm(makeMultiRoute(3, 5, 2, '옥수'), '옥수', new Set())).toBeNull();
    });

    it('should not fire alarm at start of multi-segment route (regression: #152)', () => {
      // 용마산 → 강남구청(7정거장) → 선릉(2정거장) → 역삼(1정거장)
      expect(checkAlarm(makeMultiRoute(7, 2, 1, '강남구청', '선릉'), '역삼', new Set())).toBeNull();
    });

    it('should return null when first transferName equals destinationName but is far', () => {
      expect(checkAlarm(makeMultiRoute(5, 1, 3, '옥수'), '옥수', new Set())).toBeNull();
    });
  });

  describe('custom threshold', () => {
    it('should return alarm when stops <= threshold (threshold=2)', () => {
      const route: DirectRoute = { type: 'direct', stops: 2 };
      const result = checkAlarm(route, destinationName, new Set(), 2);
      expect(result).toEqual({ type: 'destination', stationName: '강남' });
    });

    it('should return null when stops > threshold (threshold=2)', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      expect(checkAlarm(route, destinationName, new Set(), 2)).toBeNull();
    });

    it('should apply threshold to transfer route stopsToTransfer', () => {
      expect(checkAlarm(makeTransferRoute(2, 5), destinationName, new Set(), 2))
        .toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return null when all stopsToTransfer > threshold even if stopsAfterLastTransfer <= threshold', () => {
      expect(checkAlarm(makeMultiRoute(5, 5, 3), destinationName, new Set(), 3)).toBeNull();
    });
  });
});

describe('checkTimeBasedAlarm', () => {
  const destinationName = '강남';

  it('should return null when nextStationName is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 5 };
    expect(checkTimeBasedAlarm(null, 1, destinationName, route, new Set())).toBeNull();
  });

  it('should return null when route is null', () => {
    expect(checkTimeBasedAlarm('역삼', 1, destinationName, null, new Set())).toBeNull();
  });

  it('should return null when estimated time exceeds threshold', () => {
    const route: DirectRoute = { type: 'direct', stops: 5 };
    expect(checkTimeBasedAlarm('역삼', 2, destinationName, route, new Set())).toBeNull();
  });

  describe('approaching regular station', () => {
    it('should return approaching alarm for regular station (0 stops to next)', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      const result = checkTimeBasedAlarm('역삼', 0, destinationName, route, new Set());
      expect(result).toEqual({ type: 'approaching', stationName: '역삼', timeBased: true });
    });

    it('should return null when already fired for that station', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      const fired = new Set(['time-approaching:역삼']);
      expect(checkTimeBasedAlarm('역삼', 0, destinationName, route, fired)).toBeNull();
    });

    it('should fire for different stations independently', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      const fired = new Set(['time-approaching:역삼']);
      const result = checkTimeBasedAlarm('선릉', 0, destinationName, route, fired);
      expect(result).toEqual({ type: 'approaching', stationName: '선릉', timeBased: true });
    });
  });

  describe('approaching destination station', () => {
    it('should return destination alarm when next station is destination', () => {
      const route: DirectRoute = { type: 'direct', stops: 1 };
      const result = checkTimeBasedAlarm('강남', 0, '강남', route, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남', timeBased: true });
    });

    it('should return null when already fired for destination', () => {
      const route: DirectRoute = { type: 'direct', stops: 1 };
      const fired = new Set(['time-destination:강남']);
      expect(checkTimeBasedAlarm('강남', 0, '강남', route, fired)).toBeNull();
    });
  });

  describe('approaching transfer station', () => {
    it('should return transfer alarm for transfer station (TransferRoute)', () => {
      const result = checkTimeBasedAlarm('시청', 0, destinationName, makeTransferRoute(1, 5), new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return transfer alarm for first transfer (MultiTransferRoute)', () => {
      const result = checkTimeBasedAlarm('시청', 0, destinationName, makeMultiRoute(1, 5, 3), new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return transfer alarm for second transfer (MultiTransferRoute)', () => {
      const result = checkTimeBasedAlarm('충무로', 0, destinationName, makeMultiRoute(5, 1, 3), new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '충무로', timeBased: true });
    });

    it('should return null when already fired for transfer station', () => {
      const fired = new Set(['time-transfer:시청']);
      expect(checkTimeBasedAlarm('시청', 0, destinationName, makeTransferRoute(1, 5), fired)).toBeNull();
    });
  });

  describe('direct route: approaching regular station is not destination', () => {
    it('should return approaching for non-destination station on direct route', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const result = checkTimeBasedAlarm('역삼', 0, '강남', route, new Set());
      expect(result).toEqual({ type: 'approaching', stationName: '역삼', timeBased: true });
    });
  });

  describe('approaching regular station on transfer/multi-transfer route', () => {
    it('should return approaching for non-transfer station on TransferRoute', () => {
      const result = checkTimeBasedAlarm('종각', 0, destinationName, makeTransferRoute(3, 5), new Set());
      expect(result).toEqual({ type: 'approaching', stationName: '종각', timeBased: true });
    });

    it('should return approaching for non-transfer station on MultiTransferRoute', () => {
      const result = checkTimeBasedAlarm('종각', 0, destinationName, makeMultiRoute(3, 5, 3), new Set());
      expect(result).toEqual({ type: 'approaching', stationName: '종각', timeBased: true });
    });
  });

  describe('custom threshold', () => {
    it('should trigger when estimated time equals threshold', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      // 1 stop * 120s = 120s, threshold = 120
      const result = checkTimeBasedAlarm('역삼', 1, destinationName, route, new Set(), 120);
      expect(result).toEqual({ type: 'approaching', stationName: '역삼', timeBased: true });
    });

    it('should not trigger when estimated time exceeds threshold', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      // 1 stop * 120s = 120s, threshold = 60
      expect(checkTimeBasedAlarm('역삼', 1, destinationName, route, new Set(), 60)).toBeNull();
    });
  });
});
