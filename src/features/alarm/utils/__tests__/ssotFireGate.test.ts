/**
 * #1572 (T9, ADR-017) — evaluateSsotFireGate 4×2 매트릭스 acceptance.
 *
 * 매트릭스: mirror state (missing / stale / fresh-no-match / fresh-match) × type (station-passed / transfer)
 *
 * 게이트 사유:
 *   - block: gate-alarm-already-decided | gate-station-already-passed
 *   - no-block: mirror-missing | mirror-stale | no-match
 *
 * mirror staleness 임계 = SSOT_FIRE_GATE_STALENESS_MS (180s).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SSOT_FIRE_GATE_STALENESS_MS,
  evaluateSsotFireGate,
} from '../ssotFireGate';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockGetItem = AsyncStorage.getItem as jest.Mock;

const NOW = 1_700_000_000_000;

function makeMirror(
  overrides?: Partial<{
    currentStationId: string;
    motionState: 'moving' | 'stationary' | 'unknown';
    lastAdvanceEvidence: string;
    lastAdvanceAt: number;
    passedStations: string[];
    receivedAt: number;
    alarmEvents: Array<{
      alarmId: string;
      stationId: string;
      type: 'station-passed' | 'transfer' | 'destination' | 'imminent';
      decidedAt: number;
    }>;
  }>,
) {
  return JSON.stringify({
    currentStationId: '중곡',
    motionState: 'moving',
    lastAdvanceEvidence: 'arvlcd-confirmed-train',
    lastAdvanceAt: NOW,
    passedStations: ['용마산'],
    receivedAt: NOW,
    alarmEvents: [
      {
        alarmId: 'aaa111',
        stationId: '용마산',
        type: 'station-passed' as const,
        decidedAt: NOW,
      },
    ],
    ...overrides,
  });
}

describe('evaluateSsotFireGate — mirror state × type matrix (#1572 T9)', () => {
  beforeEach(() => {
    mockGetItem.mockReset();
  });

  describe('mirror-missing (no-block, graceful)', () => {
    it('mirror 부재 + station-passed fire 시도 → no-block', async () => {
      mockGetItem.mockResolvedValue(null);
      const out = await evaluateSsotFireGate({
        alarmId: 'x',
        stationId: '중곡',
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'mirror-missing' });
    });

    it('mirror 부재 + transfer fire 시도 → no-block', async () => {
      mockGetItem.mockResolvedValue(null);
      const out = await evaluateSsotFireGate({
        alarmId: 'x',
        stationId: '중곡',
        type: 'transfer',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'mirror-missing' });
    });
  });

  describe('mirror-stale × Gate A/B 분리 (#1645)', () => {
    // #1645 — Gate A는 staleness 무관 always-check. alarmId 매칭은 mirror가 stale이어도 차단.
    // Gate B는 staleness 안에만 적용 → stale 시 stationId 매칭이어도 no-block.
    it('staleness 초과 + alarmId 매칭(Gate A) → blocked (staleness 무관)', async () => {
      mockGetItem.mockResolvedValue(
        makeMirror({ receivedAt: NOW - SSOT_FIRE_GATE_STALENESS_MS - 1 }),
      );
      const out = await evaluateSsotFireGate({
        alarmId: 'aaa111', // mirror.alarmEvents[0].alarmId와 매칭
        stationId: 'X', // 다른 station
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: true, reason: 'gate-alarm-already-decided' });
    });

    it('staleness 초과 + Gate B 후보 (stationId 매칭, alarmId 미매칭) → no-block (mirror-stale)', async () => {
      mockGetItem.mockResolvedValue(
        makeMirror({ receivedAt: NOW - SSOT_FIRE_GATE_STALENESS_MS - 1 }),
      );
      const out = await evaluateSsotFireGate({
        alarmId: 'different', // alarmId 미매칭 (Gate A pass)
        stationId: '용마산', // mirror.passedStations 매칭이지만 stale → graceful skip
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'mirror-stale' });
    });

    it('staleness 경계(=)는 fresh로 판정 — Gate B block 가능', async () => {
      mockGetItem.mockResolvedValue(
        makeMirror({ receivedAt: NOW - SSOT_FIRE_GATE_STALENESS_MS }),
      );
      const out = await evaluateSsotFireGate({
        alarmId: 'different',
        stationId: '용마산',
        type: 'station-passed',
        now: NOW,
      });
      expect(out.blocked).toBe(true);
    });

    it('staleness 초과 + transfer type + alarmId 미매칭 → no-block (mirror-stale)', async () => {
      mockGetItem.mockResolvedValue(
        makeMirror({ receivedAt: NOW - SSOT_FIRE_GATE_STALENESS_MS - 1 }),
      );
      const out = await evaluateSsotFireGate({
        alarmId: 'different',
        stationId: 'X',
        type: 'transfer',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'mirror-stale' });
    });
  });

  describe('fresh + no-match → no-block', () => {
    it('alarmId/stationId 미매칭 → no-block(no-match)', async () => {
      mockGetItem.mockResolvedValue(makeMirror());
      const out = await evaluateSsotFireGate({
        alarmId: 'zzz999',
        stationId: '강남',
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'no-match' });
    });

    it('type 미명시(transfer/destination 등 Gate B 미적용) + alarmId 미매칭 → no-block', async () => {
      mockGetItem.mockResolvedValue(makeMirror());
      const out = await evaluateSsotFireGate({
        alarmId: 'zzz',
        stationId: '용마산', // mirror.passedStations에 있지만 type=transfer라 Gate B 미적용
        type: 'transfer',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'no-match' });
    });
  });

  describe('fresh + match → blocked', () => {
    // it.each 매트릭스로 Gate A/B 시나리오 통합 — 같은 4-line evaluate+expect 블록 5개 반복 dup 회피.
    // [name, mirrorOverrides, input, expected]
    const matchCases: Array<{
      name: string;
      mirrorOverrides?: Parameters<typeof makeMirror>[0];
      input: Parameters<typeof evaluateSsotFireGate>[0];
      expected: { blocked: boolean; reason: string };
    }> = [
      {
        name: 'Gate A: alarmId 매칭 → blocked (gate-alarm-already-decided)',
        input: { alarmId: 'aaa111', stationId: 'X', type: 'transfer', now: NOW },
        expected: { blocked: true, reason: 'gate-alarm-already-decided' },
      },
      {
        name: 'Gate B: passedStations 매칭 + type=station-passed → blocked',
        input: { alarmId: 'different', stationId: '용마산', type: 'station-passed', now: NOW },
        expected: { blocked: true, reason: 'gate-station-already-passed' },
      },
      {
        name: 'Gate B: passedStations 매칭 + type=imminent → blocked',
        input: { alarmId: 'different', stationId: '용마산', type: 'imminent', now: NOW },
        expected: { blocked: true, reason: 'gate-station-already-passed' },
      },
      {
        // passedStations 비우고 alarmEvents에만 있는 경우.
        name: 'Gate B: alarmEvents에 station-passed entry 매칭 → blocked',
        mirrorOverrides: {
          passedStations: [],
          alarmEvents: [
            { alarmId: 'aaa111', stationId: '용마산', type: 'station-passed', decidedAt: NOW },
          ],
        },
        input: { alarmId: 'different', stationId: '용마산', type: 'station-passed', now: NOW },
        expected: { blocked: true, reason: 'gate-station-already-passed' },
      },
      {
        name: 'Gate B: alarmEvents에 transfer type entry만 있고 stationId 매칭 → no-block (transfer는 Gate B 미적용)',
        mirrorOverrides: {
          passedStations: [],
          alarmEvents: [
            { alarmId: 'tt', stationId: '용마산', type: 'transfer', decidedAt: NOW },
          ],
        },
        input: { alarmId: 'different', stationId: '용마산', type: 'station-passed', now: NOW },
        expected: { blocked: false, reason: 'no-match' },
      },
    ];

    it.each(matchCases)('$name', async ({ mirrorOverrides, input, expected }) => {
      mockGetItem.mockResolvedValue(makeMirror(mirrorOverrides));
      const out = await evaluateSsotFireGate(input);
      expect(out).toEqual(expected);
    });
  });

  describe('alarmEvents 부재 (legacy mirror)', () => {
    it('alarmEvents 미정의 + passedStations 매칭 station-passed → 여전히 blocked', async () => {
      const raw = JSON.stringify({
        currentStationId: '중곡',
        motionState: 'moving',
        lastAdvanceEvidence: 'arvlcd-confirmed-train',
        lastAdvanceAt: NOW,
        passedStations: ['용마산'],
        receivedAt: NOW,
        // alarmEvents 누락
      });
      mockGetItem.mockResolvedValue(raw);
      const out = await evaluateSsotFireGate({
        alarmId: 'X',
        stationId: '용마산',
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: true, reason: 'gate-station-already-passed' });
    });

    it('alarmEvents 미정의 + alarmId 매칭 시도 → Gate A 미적용 → no-match', async () => {
      const raw = JSON.stringify({
        currentStationId: '중곡',
        motionState: 'moving',
        lastAdvanceEvidence: 'arvlcd-confirmed-train',
        lastAdvanceAt: NOW,
        passedStations: [],
        receivedAt: NOW,
      });
      mockGetItem.mockResolvedValue(raw);
      const out = await evaluateSsotFireGate({
        alarmId: 'aaa111',
        stationId: '강남',
        type: 'station-passed',
        now: NOW,
      });
      expect(out).toEqual({ blocked: false, reason: 'no-match' });
    });
  });

  describe('default now (Date.now() fallback)', () => {
    it('now 미명시 → Date.now() 사용 (smoke)', async () => {
      mockGetItem.mockResolvedValue(makeMirror({ receivedAt: Date.now() }));
      const out = await evaluateSsotFireGate({
        alarmId: 'aaa111',
        stationId: '용마산',
        type: 'station-passed',
      });
      expect(out.blocked).toBe(true);
    });
  });

  it(`SSOT_FIRE_GATE_STALENESS_MS = ${180_000}`, () => {
    expect(SSOT_FIRE_GATE_STALENESS_MS).toBe(180_000);
  });

  // BACKEND_SSOT_MIRROR_KEY를 import해서 미사용 경고 회피 + sanity check.
  it('readBackendSsotMirror는 BACKEND_SSOT_MIRROR_KEY를 read한다', async () => {
    mockGetItem.mockResolvedValue(null);
    await evaluateSsotFireGate({
      alarmId: 'x',
      stationId: 'Y',
      type: 'station-passed',
      now: NOW,
    });
    expect(mockGetItem).toHaveBeenCalledWith(BACKEND_SSOT_MIRROR_KEY);
  });
});
