/**
 * #3158 PR-0 — 2026-10-22 18:46:45 왕십리 vanish-swap replay.
 * 성수지선 열차 1655 lock이 사라지고 외선 본선 6405로 교체됐다(맞는 교체). 이 교체는 PR-1 이후에도 유지돼야 한다
 * (게이트는 성수 번호 변경 leg의 시간표 재부착만 대상으로 한다).
 * 입력은 불변 실측 `fixtures/replay_20261022_wangsimni/caps` (R2 seoul-capture 18:42:45~18:49:45, R2 원문과 byte 동일).
 * 앞 3 cycle은 시작 전 맥락이라 건너뛴다(18:45:54부터). 통과시키려 조정 금지.
 */
import { describe, expect, it } from 'vitest';
import type { Trip } from '../types';
import { loadCaptures, runCaptureTicks } from './helpers/renumberProbe';

const TOKEN = 'replay-20261022-wangsimni';
const CONTEXT_CYCLES_TO_SKIP = 3;

function makeTrip1022(t0: number, token: string): Trip {
  return {
    token,
    expiresAt: Date.now() + 3600_000,
    alarmAtEpochMs: t0 + 60_000,
    promptOptIn: true,
    consecutiveEtaMissing: 0,
    route: { type: 'transfer', line: '2', stops: 7 },
    destination: '한강진',
    originStationName: '성수',
    createdAt: t0 - 300_000,
    lastTrackedArrivalEpoch: t0 - 60_000,
    waypoints: [
      { stationName: '왕십리(성동구청)', line: '2', kind: 'intermediate' },
      { stationName: '상왕십리', line: '2', kind: 'intermediate' },
      { stationName: '신당', line: '2', kind: 'transfer' },
      { stationName: '청구', line: '6', kind: 'intermediate' },
      { stationName: '약수', line: '6', kind: 'intermediate' },
      { stationName: '버티고개', line: '6', kind: 'intermediate' },
      { stationName: '한강진', line: '6', kind: 'destination' },
    ],
    boardingLock: {
      trainCode: '1655',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: t0 - 165_000,
      segmentStations: ['성수', '뚝섬', '한양대', '왕십리(성동구청)', '상왕십리', '신당'],
      expiresAt: Date.now() + 3600_000,
    },
  } as unknown as Trip;
}

describe('#3158 10/22 왕십리 — 맞는 vanish-swap 1655 -> 6405', () => {
  it('18:46:45 vanish-swap 1655 -> 6405 (시간표 재부착 게이트와 무관하게 유지)', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261022_wangsimni', CONTEXT_CYCLES_TO_SKIP), makeTrip1022, TOKEN);
    const swapTick = ticks.find((t) => t.kst === '18:46:45');
    expect(swapTick?.lock).toBe('6405');
    expect(swapTick?.d1.find((r) => r.kind === 'lock-reattach')?.meta).toEqual({
      source: 'vanish-swap',
      from: '1655',
      to: '6405',
    });
  });
});
