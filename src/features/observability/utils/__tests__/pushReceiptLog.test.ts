import AsyncStorage from '@react-native-async-storage/async-storage';
import { logPushReceipt, mapWaypointKindToReceiptKind } from '../pushReceiptLog';
import {
  getRawSignalEntries,
  __resetRawSignalForTests__,
} from '../rawSignalBuffer';
import { setTripCorrId, __resetTripCorrIdForTests__ } from '../tripCorrId';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('pushReceiptLog (#2541 obs: whole-chain 관측)', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    __resetRawSignalForTests__();
    __resetTripCorrIdForTests__();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('logPushReceipt', () => {
    it('rawSignalBuffer에 kind=push-receipt entry를 적재한다', () => {
      logPushReceipt({
        pushId: 'push-1',
        station: '용마산',
        kind: 'station-passed',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
        receivedAt: 1_700_000_000_000,
      });
      const entries = getRawSignalEntries();
      expect(entries).toHaveLength(1);
      const [e] = entries;
      expect(e.kind).toBe('push-receipt');
      expect(e.ts).toBe(1_700_000_000_000);
      expect(e.pushReceipt).toEqual({
        pushId: 'push-1',
        station: '용마산',
        kind: 'station-passed',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
      });
      // push-receipt entry는 fusion 관련 필드가 모두 null.
      expect(e.gps).toBeNull();
      expect(e.motion).toBeNull();
      expect(e.accelPattern).toBeNull();
      expect(e.cellular).toBeNull();
      expect(e.subsurface).toBeNull();
      expect(e.barometerHpa).toBeNull();
      expect(e.arvlCd).toBeNull();
      expect(e.line).toBeNull();
      expect(e.dir).toBeNull();
      expect(e.arcIdx).toBeNull();
      expect(e.arcProgress).toBeNull();
      expect(e.stationId).toBeNull();
      expect(e.source).toBeNull();
      expect(e.confidence).toBeNull();
    });

    it('pushId 누락(null/undefined)이면 pushReceipt.pushId=null로 정규화', () => {
      logPushReceipt({
        pushId: undefined,
        station: '성수',
        kind: 'transfer',
        pushType: 'alert',
        displayed: true,
      });
      const [e] = getRawSignalEntries();
      expect(e.pushReceipt?.pushId).toBeNull();
    });

    it('suppressedReason 미지정 시 필드 자체를 넣지 않는다', () => {
      logPushReceipt({
        pushId: 'push-2',
        station: '왕십리',
        kind: 'destination',
        pushType: 'alert',
        displayed: true,
      });
      const [e] = getRawSignalEntries();
      expect(e.pushReceipt).not.toHaveProperty('suppressedReason');
    });

    it('receivedAt 미지정 시 Date.now() 사용', () => {
      jest.useFakeTimers().setSystemTime(1_700_000_005_000);
      logPushReceipt({
        pushId: 'push-3',
        station: '건대입구',
        kind: 'prompt',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'boarding-prompt-remote-only',
      });
      const [e] = getRawSignalEntries();
      expect(e.ts).toBe(1_700_000_005_000);
      jest.useRealTimers();
    });

    it('현재 trip corrId를 그대로 기록한다', async () => {
      await setTripCorrId('trip-corr-1');
      logPushReceipt({
        pushId: 'push-4',
        station: '군자',
        kind: 'station-passed',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
      });
      const [e] = getRawSignalEntries();
      expect(e.corrId).toBe('trip-corr-1');
    });

    it('corrId 없으면 null', () => {
      logPushReceipt({
        pushId: 'push-5',
        station: '중곡',
        kind: 'transfer',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
      });
      const [e] = getRawSignalEntries();
      expect(e.corrId).toBeNull();
    });
  });

  describe('mapWaypointKindToReceiptKind', () => {
    it('intermediate → station-passed', () => {
      expect(mapWaypointKindToReceiptKind('intermediate')).toBe('station-passed');
    });

    it('transfer → transfer (identity)', () => {
      expect(mapWaypointKindToReceiptKind('transfer')).toBe('transfer');
    });

    it('destination → destination (identity)', () => {
      expect(mapWaypointKindToReceiptKind('destination')).toBe('destination');
    });
  });
});
