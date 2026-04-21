import { checkAlarm, checkTimeBasedAlarm, alarmKey, estimateRemainingSeconds, AlarmEvent } from '../stationAlarm';
import type { DirectRoute, TransferRoute, MultiTransferRoute, Route } from '../stationRoute';

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
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return destination alarm when stopsFromTransfer === 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 5,
        stopsFromTransfer: 1,
      };
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남' });
    });

    it('should return null when neither is 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 5,
      };
      expect(checkAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return null when transfer alarm already fired', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      const fired = new Set(['transfer:시청']);
      expect(checkAlarm(route, destinationName, fired)).toBeNull();
    });

    it('should return destination alarm when transferName equals destinationName and stopsToTransfer <= 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '옥수',
        fromLine: 'gyeongui',
        toLine: '3',
        stopsToTransfer: 0,
        stopsFromTransfer: 0,
      };
      const result = checkAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수' });
    });

    it('should return null when transferName equals destinationName but stopsToTransfer > 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '옥수',
        fromLine: 'gyeongui',
        toLine: '3',
        stopsToTransfer: 3,
        stopsFromTransfer: 0,
      };
      expect(checkAlarm(route, '옥수', new Set())).toBeNull();
    });

    it('should return destination alarm when transferName equals destinationName and both stops <= 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '공덕',
        fromLine: '5',
        toLine: '6',
        stopsToTransfer: 1,
        stopsFromTransfer: 0,
      };
      const result = checkAlarm(route, '공덕', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '공덕' });
    });

    it('should prioritize transfer over destination when both are 1', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 1,
      };
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });
  });

  // MultiTransferRoute
  describe('MultiTransferRoute', () => {
    const makeMultiRoute = (
      stops1: number,
      stops2: number,
      stopsAfter: number,
    ): MultiTransferRoute => ({
      type: 'multi-transfer',
      transfers: [
        { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: stops1 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: stops2 },
      ],
      stopsAfterLastTransfer: stopsAfter,
    });

    it('should return transfer alarm for first transfer when stopsToTransfer === 1', () => {
      const route = makeMultiRoute(1, 5, 3);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should return transfer alarm for second transfer when stopsToTransfer === 1', () => {
      const route = makeMultiRoute(5, 1, 3);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '충무로' });
    });

    it('should return destination alarm when stopsAfterLastTransfer === 1', () => {
      const route = makeMultiRoute(5, 3, 1);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남' });
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

    it('should prioritize second transfer over destination when both are 1', () => {
      const route = makeMultiRoute(5, 1, 1);
      const result = checkAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '충무로' });
    });

    it('should return destination alarm when first transferName equals destinationName', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '옥수', fromLine: 'gyeongui', toLine: '3', stopsToTransfer: 1 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수' });
    });

    it('should return destination alarm when second transferName equals destinationName', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 5 },
          { transferName: '옥수', fromLine: '3', toLine: 'bundang', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 0,
      };
      const result = checkAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수' });
    });

    it('should return null when transferName equals destinationName but stopsToTransfer > threshold', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '옥수', fromLine: 'gyeongui', toLine: '3', stopsToTransfer: 3 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 2,
      };
      expect(checkAlarm(route, '옥수', new Set())).toBeNull();
    });

    it('should return null when first transferName equals destinationName but is far', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '옥수', fromLine: 'gyeongui', toLine: '3', stopsToTransfer: 5 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 3,
      };
      expect(checkAlarm(route, '옥수', new Set())).toBeNull();
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
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 2,
        stopsFromTransfer: 5,
      };
      const result = checkAlarm(route, destinationName, new Set(), 2);
      expect(result).toEqual({ type: 'transfer', stationName: '시청' });
    });

    it('should apply threshold to multi-transfer route', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 5 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkAlarm(route, destinationName, new Set(), 3);
      expect(result).toEqual({ type: 'destination', stationName: '강남' });
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
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      const result = checkTimeBasedAlarm('시청', 0, destinationName, route, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return transfer alarm for first transfer (MultiTransferRoute)', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 1 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkTimeBasedAlarm('시청', 0, destinationName, route, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return transfer alarm for second transfer (MultiTransferRoute)', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 5 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkTimeBasedAlarm('충무로', 0, destinationName, route, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '충무로', timeBased: true });
    });

    it('should return null when already fired for transfer station', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      const fired = new Set(['time-transfer:시청']);
      expect(checkTimeBasedAlarm('시청', 0, destinationName, route, fired)).toBeNull();
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
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 5,
      };
      const result = checkTimeBasedAlarm('종각', 0, destinationName, route, new Set());
      expect(result).toEqual({ type: 'approaching', stationName: '종각', timeBased: true });
    });

    it('should return approaching for non-transfer station on MultiTransferRoute', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 3 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkTimeBasedAlarm('종각', 0, destinationName, route, new Set());
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
