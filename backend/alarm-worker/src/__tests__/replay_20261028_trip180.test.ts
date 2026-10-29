/**
 * #3158 PR-0 — 2026-10-28 17:13 트립 180(성수 -> 건대입구 2호선 내선, 건대입구에서 7호선 환승) whole-trip replay.
 * 사용자 열차 3286은 성수에서 3324로 번호가 바뀌었는데(저녁 +14분), 고정 시간창이 시간표 재부착을 꺼서
 * vanish-swap이 뒤 열차 2288로 lock을 옮겼다.
 * 입력은 불변 실측 — `fixtures/replay_20261028_trip180/`:
 *   - caps/*.json : R2 seoul-capture 21 cycle (17:13:45~17:33:46, R2 원문과 byte 동일)
 *   - events_180.json : D1 trip_events (token_hash b00dd879, 17:13~17:35) — 시작 상태(lock 3286, path:sync) 근거
 * 통과시키려 조정 금지.
 *
 * PR-0 커밋은 현 dev 동작(vanish-swap 3286 -> 2288 @17:15:45)을 재현해 박제했다. 이 파일의 assert는 그 위에서
 * "같은 열차 3324를 따라간다"로 뒤집은 것이다(#3161 결정: 번호가 바뀌어도 같은 열차).
 */
import { describe, expect, it } from 'vitest';
import { RENUMBER_SWAP_DEFER_TICKS } from '../renumberSuccessor';
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

const WRONG_TRAINS = ['2288', '3290']; // 같은 방향 뒤 열차(17:18:16 뚝섬 등) — 사용자 열차가 아니다.
/** 사용자 sync(17:17:06 건대입구) 이후 transfer advance로 lock이 풀린다 — 풀린 상태(undefined)는 허용. */
const ALLOWED_LOCKS: ReadonlyArray<string | undefined> = ['3286', '3324', undefined];
/** 17:13:45 ~ 17:16:45 = 재부착 판정이 도는 구간(dev에서는 판정 read 0회). */
const REATTACH_WINDOW_END = '17:16:45';
/** dev(PR-0) 실측: 위 구간 tick별 realtime-position:2 KV get = 1,1,2,1. */
const DEV_BASELINE_POSITION_GETS = 5;
/** 재부착 판정 read는 tick당 1회 — 4 tick. */
const MAX_EXTRA_READS = 4;

describe('#3158 트립 180 — 번호가 바뀐 같은 열차(3286 -> 3324)를 따라간다', () => {
  it('모든 tick lock ∈ {3286, 3324, 해제}: 뒤 열차 2288·3290으로 교체되지 않는다', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261028_trip180'), makeTrip180, TOKEN);
    for (const tick of ticks) {
      expect({ kst: tick.kst, allowed: ALLOWED_LOCKS.includes(tick.lock) }).toEqual({ kst: tick.kst, allowed: true });
      expect(WRONG_TRAINS).not.toContain(tick.lock);
    }
    const allReattaches = ticks.flatMap((t) => t.d1.filter((r) => r.kind === 'lock-reattach').map((r) => r.meta));
    expect(allReattaches.filter((m) => WRONG_TRAINS.includes(String(m.to)))).toEqual([]);
  });

  it('17:16:45 lock-reattach {timetable-successor, 3286 -> 3324} 정확히 1행 + 같은 tick 건대입구 transfer 발사', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261028_trip180'), makeTrip180, TOKEN);
    const reattaches = ticks.flatMap((t) => t.d1.filter((r) => r.kind === 'lock-reattach').map((r) => ({ kst: t.kst, meta: r.meta })));
    expect(reattaches).toEqual([
      { kst: '17:16:45', meta: { source: 'timetable-successor', from: '3286', to: '3324', timetableFrom: '3286' } },
    ]);
    const tick = ticks.find((t) => t.kst === '17:16:45');
    const sent = tick?.d1.filter((r) => r.kind === 'cron-fire-attempt' && r.meta.outcome === 'sent' && r.meta.waypointKind === 'transfer');
    expect(sent?.map((r) => r.station)).toEqual(['건대입구']);
  });

  it('KV 비용: 재부착 판정 read는 17:13:45~17:16:45 4 tick에 tick당 1회 이하', async () => {
    const ticks = await runCaptureTicks(loadCaptures('replay_20261028_trip180'), makeTrip180, TOKEN);
    const end = ticks.findIndex((t) => t.kst === REATTACH_WINDOW_END);
    const gets = ticks.slice(0, end + 1).reduce((sum, t) => sum + t.position2Gets, 0);
    expect(gets).toBeLessThanOrEqual(DEV_BASELINE_POSITION_GETS + MAX_EXTRA_READS);
  });

  it('hold 상한: 후속 3324가 끝내 관측되지 않으면 vanish-swap은 dev(miss 3)보다 정확히 RENUMBER_SWAP_DEFER_TICKS tick만 늦어진다', async () => {
    const withoutSuccessor = loadCaptures('replay_20261028_trip180').map((cap) => ({
      ...cap,
      entries: cap.entries.map((e) => ({ ...e, body: stripTrain(e.body, '3324') })),
    }));
    const ticks = await runCaptureTicks(withoutSuccessor, makeTrip180, TOKEN);
    expect(ticks.flatMap((t) => t.d1).filter((r) => r.kind === 'lock-reattach' && r.meta.source === 'timetable-successor')).toEqual([]);
    // dev는 17:15:45(miss 3)에 교체. 유예 구간(17:15:45~17:16:45)에는 lock 3286을 유지하고, 유예가 끝나는 tick에 기존 vanish-swap으로 수렴한다.
    const devSwapIndex = ticks.findIndex((t) => t.kst === '17:15:45');
    const firstSwap = ticks.findIndex((t) => t.lock !== '3286');
    expect(firstSwap).toBe(devSwapIndex + RENUMBER_SWAP_DEFER_TICKS);
    expect(ticks.slice(0, firstSwap).map((t) => t.lock)).toEqual(Array(firstSwap).fill('3286'));
    expect(ticks[firstSwap].d1.find((r) => r.kind === 'lock-reattach')?.meta).toMatchObject({ source: 'vanish-swap', from: '3286' });
  });
});

/** position/arrival 응답 body에서 trainNo/btrainNo == code 행을 제거한다(후속 미출현 변형 — 원본 fixture는 불변). */
function stripTrain(body: string, code: string): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body; // 캡처에 그대로 남은 비JSON 응답(예: CF 522)은 건드리지 않는다.
  }
  for (const key of ['realtimePositionList', 'realtimeArrivalList']) {
    const rows = json[key];
    if (Array.isArray(rows)) json[key] = (rows as Array<Record<string, unknown>>).filter((r) => r.trainNo !== code && r.btrainNo !== code);
  }
  return JSON.stringify(json);
}
