/**
 * #3055 / #3300 옵션 D PR-5 — 10/31 재등록 폭주 실측(`replay_20261031_reregister_storm`)을 **매역 push 마커가 지연되는 창 + 2차(midCycle) pass**로 재생한다.
 *
 * 입력은 불변 실측 — `fixtures/replay_20261031_reregister_storm/`. 이 파일은 맞춤을 끄고(진행 셀만 권위) `station-passed-fired:` 마커 읽기를 엣지 캐시(60s)
 * 지연으로 모델링해, 1차 tick의 도착 발사와 +30s 2차 pass의 진입/도착 발사(둘 다 같은 역을 본다)가 서로의 마커를 못 보는 상황을 만든다.
 *  - `lock@1`(control): 진행 셀 없음 -> 같은 역이 2번 발사된다(강남구청·논현). 결함이 실제로 보인다는 증명.
 *  - `progress@1`: 역당 매역 push 정확히 1건. 이 재생에서는 head overlay가 낡은 head를 이미 걸러 **claim 이전에도 green**이다 — 직접 호출 테스트
 *    (`stationPushClaim.test.ts`, 두 소비자가 같은 head를 동시에 보는 경우)가 claim의 red를 가진다. 이 재생은 whole-trip 회귀 가드다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import { replayStorm } from './helpers/stormReplay20261031';

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

const stationCounts = async (cells: 'lock@1' | 'progress@1') => {
  const r = await replayStorm({ registerCarriesLock: true, cells, primeProgress: false, twoPass: true, laggedFireDedup: true });
  const counts: Record<string, number> = {};
  for (const station of firedStationOccurrences(r.result.pushes)) counts[station] = (counts[station] ?? 0) + 1;
  return counts;
};

describe('#3055 PR-5 — 10/31 폭주 재생 · 마커 지연 + 2차 pass', () => {
  it('control(lock@1): 마커가 지연되면 같은 역이 2번 발사된다 (결함 재현)', async () => {
    const counts = await stationCounts('lock@1');
    expect(Object.values(counts).some((n) => n > 1)).toBe(true);
  });

  it('progress@1: 어떤 역도 매역 push가 2건 이상 나가지 않는다', async () => {
    const counts = await stationCounts('progress@1');
    expect(Object.entries(counts).filter(([, n]) => n > 1)).toEqual([]);
  });
});
