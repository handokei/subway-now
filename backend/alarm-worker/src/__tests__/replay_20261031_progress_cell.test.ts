/**
 * #3055 / #3300 옵션 D PR-4b — 10/31 재등록 폭주를 **진행 셀만으로** 막는다(cron 맞춤 off).
 *
 * 사고(replay_20261031_reregister_storm 헤더): cron이 강남구청을 소비한 직후 같은 세션 재등록이 KV 60s 캐시의 낡은 trip으로 head를
 * 되돌려 같은 역을 4번 소비(D1 prepare-alarm 1915/1921/1926/1929). ADR-052는 cron 맞춤(`reconcileTripWithProgress`)이 **사후 복구**했다.
 * 계획(§4 PR-4a/4b red): "맞춤을 끈 상태로 강남구청 1회 소비 — DO 직렬화만으로 해결됨을 증명".
 *
 * 입력은 불변 실측(fixtures/replay_20261031_reregister_storm). 이 파일은 `../progress`의 `reconcileTripWithProgress`를 항상 null로 대체해
 * 맞춤을 끄고, progress KV 시드도 심지 않는다. 그래서 head 되감김을 막을 수 있는 유일한 것은 DO 진행 셀이다.
 *  - `lock@1`(control): 진행 셀 없음 -> 되감김 재현(같은 역이 2개 tick에서 평가됨) — 이 테스트가 결함을 실제로 보는지 증명.
 *  - `progress@1`: 같은 역 재소비 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import {
  ARRIVAL_TICK_INDEX,
  attemptStationsByTick,
  FULL_ROUTE_NAMES,
  replayStorm,
  stationAlertTicks,
  STORM_STATIONS,
} from './helpers/stormReplay20261031';

vi.mock('../progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../progress')>()),
  reconcileTripWithProgress: () => null,
}));

useApnsHarness();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Storm = Awaited<ReturnType<typeof replayStorm>>;

/** 2개 이상 tick에서 평가된 역(같은 역 재소비). */
function reconsumedStations(r: Storm): string[] {
  const seenInTicks = new Map<string, number>();
  attemptStationsByTick(r).forEach((stations) => {
    new Set(stations).forEach((station) => seenInTicks.set(station, (seenInTicks.get(station) ?? 0) + 1));
  });
  return [...seenInTicks].filter(([, ticks]) => ticks > 1).map(([station]) => station);
}

describe.each([
  ['재등록에 lock 실음', true],
  ['재등록에 lock 없음', false],
])('#3055 PR-4b 10/31 폭주 — 맞춤 off · progress KV 없음 — %s', (_label, registerCarriesLock) => {
  it('전제(control): lock@1(진행 셀 없음)은 같은 역을 두 tick에서 소비한다 — 폭주 재현', async () => {
    const r = await replayStorm({ registerCarriesLock, cells: 'lock@1', primeProgress: false });
    expect(reconsumedStations(r).length).toBeGreaterThan(0);
  });

  it('progress@1: 어떤 역도 2개 tick에 걸쳐 평가되지 않는다 (같은 역 재소비 0)', async () => {
    const r = await replayStorm({ registerCarriesLock, cells: 'progress@1', primeProgress: false });
    expect(reconsumedStations(r)).toEqual([]);
  });

  it('progress@1: 강남구청 평가는 첫 tick 1회뿐이다', async () => {
    const r = await replayStorm({ registerCarriesLock, cells: 'progress@1', primeProgress: false });
    const byTick = attemptStationsByTick(r);
    expect(byTick[0]).toContain(STORM_STATIONS.head);
    expect(byTick.slice(1).flat()).not.toContain(STORM_STATIONS.head);
  });

  it('progress@1: 학동 매역 alert push는 09:57:45 tick 이하에서 정확히 1건', async () => {
    const r = await replayStorm({ registerCarriesLock, cells: 'progress@1', primeProgress: false });
    const arrivalTick = r.result.cycles[ARRIVAL_TICK_INDEX].simNowMs;
    const ticks = stationAlertTicks(r, STORM_STATIONS.next);
    expect({ count: ticks.length, withinArrivalTick: ticks.every((t) => t <= arrivalTick) }).toEqual({ count: 1, withinArrivalTick: true });
  });

  it('progress@1: tick 사이에 trip head가 뒤로 가지 않는다 (KV blob 기준 단조 비감소)', async () => {
    const r = await replayStorm({ registerCarriesLock, cells: 'progress@1', primeProgress: false });
    const positions = r.headsAfterTick.map((name) => (name === undefined ? FULL_ROUTE_NAMES.length : FULL_ROUTE_NAMES.indexOf(name)));
    const backwards = positions.flatMap((pos, i) => (i > 0 && pos < positions[i - 1] ? [{ tick: i, from: r.headsAfterTick[i - 1], to: r.headsAfterTick[i] }] : []));
    expect(backwards).toEqual([]);
  });
});
