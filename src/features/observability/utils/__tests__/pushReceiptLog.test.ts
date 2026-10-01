import AsyncStorage from '@react-native-async-storage/async-storage';
import { logPushReceipt, mapWaypointKindToReceiptKind } from '../pushReceiptLog';
import {
  pushRawSignal,
  __resetRawSignalForTests__,
  type RawSignalEntry,
} from '../rawSignalBuffer';
import {
  getPushReceiptEntries,
  clearPushReceiptEntries,
} from '../pushReceiptBuffer';
import { setTripCorrId, __resetTripCorrIdForTests__ } from '../tripCorrId';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeCycleEntry(ts: number): RawSignalEntry {
  return {
    ts,
    corrId: null,
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    barometerHpa: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    pushReceipt: null,
  };
}

describe('pushReceiptLog (#2541 obs: whole-chain 관측, #2861 T1 독립 버퍼 분리)', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    __resetRawSignalForTests__();
    clearPushReceiptEntries();
    __resetTripCorrIdForTests__();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('logPushReceipt', () => {
    it('pushReceiptBuffer(독립 채널)에 entry를 적재한다 — rawSignalBuffer가 아니다', () => {
      logPushReceipt({
        pushId: 'push-1',
        station: '용마산',
        kind: 'station-passed',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
        receivedAt: 1_700_000_000_000,
      });
      const entries = getPushReceiptEntries();
      expect(entries).toHaveLength(1);
      const [e] = entries;
      expect(e.ts).toBe(1_700_000_000_000);
      expect(e.detail).toEqual({
        pushId: 'push-1',
        station: '용마산',
        kind: 'station-passed',
        pushType: 'background',
        displayed: false,
        suppressedReason: 'legacy-station-kind-ignored',
      });
    });

    it('pushId 누락(null/undefined)이면 detail.pushId=null로 정규화', () => {
      logPushReceipt({
        pushId: undefined,
        station: '성수',
        kind: 'transfer',
        pushType: 'alert',
        displayed: true,
      });
      const [e] = getPushReceiptEntries();
      expect(e.detail.pushId).toBeNull();
    });

    it('suppressedReason 미지정 시 필드 자체를 넣지 않는다', () => {
      logPushReceipt({
        pushId: 'push-2',
        station: '왕십리',
        kind: 'destination',
        pushType: 'alert',
        displayed: true,
      });
      const [e] = getPushReceiptEntries();
      expect(e.detail).not.toHaveProperty('suppressedReason');
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
      const [e] = getPushReceiptEntries();
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
      const [e] = getPushReceiptEntries();
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
      const [e] = getPushReceiptEntries();
      expect(e.corrId).toBeNull();
    });

    it('rawSignalBuffer에는 절대 적재하지 않는다 — cycle과 cap 비공유', () => {
      const { getRawSignalEntries } = require('../rawSignalBuffer');
      logPushReceipt({
        pushId: 'push-6',
        station: '아차산',
        kind: 'station-passed',
        pushType: 'background',
        displayed: true,
      });
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it(
      '#2861 (T1) 긴 트립 모사 — 초반 push-receipt가 이후 300건 cycle entry에 밀려도 ' +
        '증발하지 않는다 (rawSignalBuffer cap=300 공유 당시 결함 재현 방지)',
      () => {
        // 트립 초반(예: 어대·군자) receipt 1건 적재.
        logPushReceipt({
          pushId: 'push-early',
          station: '어린이대공원',
          kind: 'station-passed',
          pushType: 'background',
          displayed: true,
          receivedAt: 1_700_000_000_000,
        });

        // 긴 트립 cycle entry 300건+ (30초 간격)으로 rawSignalBuffer(cap=300)를 가득 채운다 —
        // 과거 구조(공유 버퍼)였다면 이 시점에 위 receipt가 FIFO eviction으로 사라졌다.
        for (let i = 0; i < 320; i += 1) {
          pushRawSignal(makeCycleEntry(1_700_000_000_000 + i * 30_000));
        }

        const entries = getPushReceiptEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].detail.station).toBe('어린이대공원');
      },
    );
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
