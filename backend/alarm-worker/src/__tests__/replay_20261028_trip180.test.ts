/**
 * #3158 PR-0 — 2026-10-28 17:13 트립 180(성수 -> 건대입구 2호선 내선, 건대입구에서 7호선 환승) whole-trip replay.
 * 사용자 열차 3286은 성수에서 3324로 번호가 바뀌었는데(저녁 +14분), 고정 시간창이 시간표 재부착을 꺼서
 * vanish-swap이 뒤 열차 2288로 lock을 옮겼다.
 * 입력은 불변 실측 — `fixtures/replay_20261028_trip180/`:
 *   - caps/*.json : R2 seoul-capture 21 cycle (17:13:45~17:33:46, R2 원문과 byte 동일)
 *   - events_180.json : D1 trip_events (token_hash b00dd879, 17:13~17:35) — 시작 상태(lock 3286, path:sync) 근거
 * 통과시키려 조정 금지.
 *
 * 이 파일은 PR-0: 현 dev 동작(3286 -> 2288)을 재현해 박제한다.
 */
import { describe, expect, it } from 'vitest';
import type { Trip } from '../types';
import { loadCaptures, runCaptureTicks } from './helpers/renumberProbe';

const TOKEN = 'replay-20261028-trip180';

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
    // D1 17:13:39 lock-attached path:sync 3286 (events_180.json). segmentStations = 관측역 성수 + leg.
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

describe('#3158 PR-0 트립 180 — 현 dev 동작 재현', () => {
  it('17:15:45 vanish-swap 3286 -> 2288 (뒤 열차)', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261028_trip180'), makeTrip180, TOKEN);
    const swapTick = ticks.find((t) => t.kst === '17:15:45');
    expect(swapTick?.lock).toBe('2288');
    expect(swapTick?.d1.find((r) => r.kind === 'lock-reattach')?.meta).toEqual({
      source: 'vanish-swap',
      from: '3286',
      to: '2288',
    });
  });
});
