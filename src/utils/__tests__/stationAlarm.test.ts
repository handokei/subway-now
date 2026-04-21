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

  it('should return null for null route', () => {
    expect(checkTimeBasedAlarm(null, destinationName, new Set())).toBeNull();
  });

  describe('DirectRoute', () => {
    it('should return time-based destination alarm when estimated time <= 30s (0 stops)', () => {
      const route: DirectRoute = { type: 'direct', stops: 0 };
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남', timeBased: true });
    });

    it('should return null when estimated time > 30s (1 stop = 120s)', () => {
      const route: DirectRoute = { type: 'direct', stops: 1 };
      expect(checkTimeBasedAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return null when already fired', () => {
      const route: DirectRoute = { type: 'direct', stops: 0 };
      const fired = new Set(['time-destination:강남']);
      expect(checkTimeBasedAlarm(route, destinationName, fired)).toBeNull();
    });

    it('should trigger with custom threshold (240s covers 2 stops)', () => {
      const route: DirectRoute = { type: 'direct', stops: 2 };
      const result = checkTimeBasedAlarm(route, destinationName, new Set(), 240);
      expect(result).toEqual({ type: 'destination', stationName: '강남', timeBased: true });
    });

    it('should not trigger when estimated time exceeds custom threshold', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      expect(checkTimeBasedAlarm(route, destinationName, new Set(), 240)).toBeNull();
    });
  });

  describe('TransferRoute', () => {
    it('should return time-based transfer alarm when stopsToTransfer estimated time <= 30s', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 0,
        stopsFromTransfer: 5,
      };
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return time-based destination alarm when stopsFromTransfer estimated time <= 30s', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 5,
        stopsFromTransfer: 0,
      };
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남', timeBased: true });
    });

    it('should return null when both estimated times > 30s', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 3,
        stopsFromTransfer: 5,
      };
      expect(checkTimeBasedAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return destination alarm when transferName equals destinationName and time <= threshold', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '옥수',
        fromLine: 'gyeongui',
        toLine: '3',
        stopsToTransfer: 0,
        stopsFromTransfer: 0,
      };
      const result = checkTimeBasedAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수', timeBased: true });
    });

    it('should return null when transferName equals destinationName but time > threshold', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '옥수',
        fromLine: 'gyeongui',
        toLine: '3',
        stopsToTransfer: 3,
        stopsFromTransfer: 0,
      };
      expect(checkTimeBasedAlarm(route, '옥수', new Set())).toBeNull();
    });

    it('should return null when already fired', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 0,
        stopsFromTransfer: 5,
      };
      const fired = new Set(['time-transfer:시청']);
      expect(checkTimeBasedAlarm(route, destinationName, fired)).toBeNull();
    });
  });

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

    it('should return time-based transfer alarm for first transfer when time <= 30s', () => {
      const route = makeMultiRoute(0, 5, 3);
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '시청', timeBased: true });
    });

    it('should return time-based transfer alarm for second transfer when time <= 30s', () => {
      const route = makeMultiRoute(5, 0, 3);
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'transfer', stationName: '충무로', timeBased: true });
    });

    it('should return time-based destination alarm when stopsAfterLastTransfer time <= 30s', () => {
      const route = makeMultiRoute(5, 3, 0);
      const result = checkTimeBasedAlarm(route, destinationName, new Set());
      expect(result).toEqual({ type: 'destination', stationName: '강남', timeBased: true });
    });

    it('should return null when all estimated times > 30s', () => {
      const route = makeMultiRoute(3, 4, 5);
      expect(checkTimeBasedAlarm(route, destinationName, new Set())).toBeNull();
    });

    it('should return null when already fired', () => {
      const route = makeMultiRoute(0, 5, 3);
      const fired = new Set(['time-transfer:시청']);
      expect(checkTimeBasedAlarm(route, destinationName, fired)).toBeNull();
    });

    it('should return destination alarm when first transferName equals destinationName and time <= threshold', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '옥수', fromLine: 'gyeongui', toLine: '3', stopsToTransfer: 0 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
        ],
        stopsAfterLastTransfer: 3,
      };
      const result = checkTimeBasedAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수', timeBased: true });
    });

    it('should return null when first transferName equals destinationName but time > threshold', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '옥수', fromLine: 'gyeongui', toLine: '3', stopsToTransfer: 5 },
          { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 3,
      };
      expect(checkTimeBasedAlarm(route, '옥수', new Set())).toBeNull();
    });

    it('should return destination alarm when second transferName equals destinationName and time <= threshold', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 5 },
          { transferName: '옥수', fromLine: '3', toLine: 'bundang', stopsToTransfer: 0 },
        ],
        stopsAfterLastTransfer: 0,
      };
      const result = checkTimeBasedAlarm(route, '옥수', new Set());
      expect(result).toEqual({ type: 'destination', stationName: '옥수', timeBased: true });
    });

    it('should return null when second transferName equals destinationName but time > threshold', () => {
      const route: MultiTransferRoute = {
        type: 'multi-transfer',
        transfers: [
          { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 5 },
          { transferName: '옥수', fromLine: '3', toLine: 'bundang', stopsToTransfer: 3 },
        ],
        stopsAfterLastTransfer: 0,
      };
      expect(checkTimeBasedAlarm(route, '옥수', new Set())).toBeNull();
    });
  });
});
