/**
 * #3158 PR-2 — trip 180 replay 변형: 시간표 재부착 경로 off(후속표를 비운다).
 * 시간표 경로가 없어도 vanish-swap picker가 99-only 모호 후보(2288·3290, 둘 다 뒤 열차)를 고르지 않고,
 * 사용자 열차의 후속 3324가 관측되는 17:16:45에 3286 -> 3324로 수렴해야 한다.
 * 입력 캡처는 `replay_20261028_trip180`과 동일한 불변 실측.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Trip } from '../types';
import { loadCaptures, runCaptureTicks } from './helpers/renumberProbe';

vi.mock('../data/line2RenumberSuccessors.json', () => ({
  default: {
    meta: { line: '2', renumberStation: '성수', timetableBaseDate: '20250619' },
    tables: { weekday: {}, weekend: {} },
  },
}));

const TOKEN = 'replay-20261028-trip180-no-timetable';

function makeTrip180(t0: number, token: string): Trip {
  return {
    token,
    expiresAt: Date.now() + 3600_000,
    alarmAtEpochMs: t0 + 60_000,
    promptOptIn: true,
    consecutiveEtaMissing: 0,
    route: { type: 'transfer', line: '2', stops: 5 },
    destination: '용마산',
    originStationName: '성수',
    createdAt: t0 - 60_000,
    waypoints: [
      { stationName: '건대입구', line: '2', kind: 'transfer' },
      { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' },
      { stationName: '군자(능동)', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: '3286',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: t0 - 6_000,
      segmentStations: ['성수', '건대입구'],
      expiresAt: Date.now() + 3600_000,
    },
  } as unknown as Trip;
}

describe('#3158 트립 180 (시간표 경로 off) — vanish-swap picker', () => {
  it('17:16:45 vanish-swap 3286 -> 3324, 뒤 열차 2288·3290으로는 한 번도 교체되지 않는다', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261028_trip180'), makeTrip180, TOKEN);
    const reattaches = ticks.flatMap((t) =>
      t.d1.filter((r) => r.kind === 'lock-reattach').map((r) => ({ kst: t.kst, meta: r.meta })),
    );
    expect(reattaches).toEqual([{ kst: '17:16:45', meta: { source: 'vanish-swap', from: '3286', to: '3324' } }]);
    expect(ticks.map((t) => t.lock).filter((l) => l === '2288' || l === '3290')).toEqual([]);
  });
});
