import { checkAlarm, alarmKey, AlarmEvent } from '../stationAlarm';
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
