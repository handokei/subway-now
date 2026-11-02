import type { RouteCandidate } from '../stationRoute';
import { makeDirectRoute, makeMultiTransferRoute, makeTransferRoute } from '../../../testUtils/routeFixtures';
import { rankCandidates } from '../routeRanking';

// #1480 PR-1 — 후보 정렬 키 = 엔진 총 소요(대기 포함). 후보는 elapsed가 주입된 상태로 들어온다.
const MIN = 60;

interface Spec {
  tag: string;
  elapsedMin: number;
  transfers?: 0 | 1;
  transferName?: string; // 환승 도보 합 구분용(건대입구=278s, 미등록=180s 폴백)
  stops?: number;
  waitUnknown?: boolean;
  lastTrainEnded?: boolean;
  travelMinutes?: number;
}

function cand(s: Spec): RouteCandidate & { tag: string } {
  const route =
    s.transfers === 1
      ? makeTransferRoute({ transferName: s.transferName ?? '건대입구', fromLine: '7', toLine: '2', stopsToTransfer: 1, stopsFromTransfer: 1 })
      : makeDirectRoute(s.stops ?? 3, '7');
  return {
    tag: s.tag,
    route,
    totalStops: s.stops ?? 3,
    transferCount: s.transfers ?? 0,
    travelMinutes: s.travelMinutes ?? s.elapsedMin,
    elapsed: { seconds: s.elapsedMin * MIN, waitUnknown: s.waitUnknown ?? false, lastTrainEnded: s.lastTrainEnded ?? false },
  };
}
const tags = (list: RouteCandidate[]) => list.map((c) => (c as unknown as { tag: string }).tag);

describe('rankCandidates (elapsed 모드 = 최적경로)', () => {
  it('정거장/travelMinutes가 아니라 총 소요(대기 포함)가 짧은 쪽이 1위', () => {
    const a = cand({ tag: 'A', elapsedMin: 25, travelMinutes: 10 });
    const b = cand({ tag: 'B', elapsedMin: 18, travelMinutes: 14 });
    expect(tags(rankCandidates([a, b], 'elapsed'))).toEqual(['B', 'A']);
  });

  it('|Δ|<=2분 근사 동률이면 환승 횟수가 적은 쪽이 1위(더 느려도)', () => {
    const fast = cand({ tag: 'fast', elapsedMin: 20, transfers: 1 });
    const near = cand({ tag: 'near', elapsedMin: 22, transfers: 0 });
    expect(tags(rankCandidates([fast, near], 'elapsed'))).toEqual(['near', 'fast']);
  });

  it('Δ가 2분을 넘으면(2분 1초) 환승 수와 무관하게 빠른 쪽', () => {
    const fast = cand({ tag: 'fast', elapsedMin: 20, transfers: 1 });
    const slow = { ...cand({ tag: 'slow', elapsedMin: 20, transfers: 0 }), elapsed: { seconds: 20 * MIN + 121, waitUnknown: false, lastTrainEnded: false } };
    expect(tags(rankCandidates([slow, fast], 'elapsed'))).toEqual(['fast', 'slow']);
  });

  it('근사 동률 + 환승 수 동일이면 도보 합이 적은 쪽(미등록 폴백 180s < 건대입구 278s)', () => {
    const long = cand({ tag: 'long', elapsedMin: 20, transfers: 1, transferName: '건대입구' });
    const short = cand({ tag: 'short', elapsedMin: 21, transfers: 1, transferName: '없는역' });
    expect(tags(rankCandidates([long, short], 'elapsed'))).toEqual(['short', 'long']);
  });

  it('다중 환승도 환승마다 도보를 합산해 비교한다(건대입구 278s x2 > 미등록 180s x2)', () => {
    const multi = (tag: string, elapsedMin: number, names: [string, string]) => ({
      ...cand({ tag, elapsedMin, transfers: 1 }),
      transferCount: 2,
      route: makeMultiTransferRoute({
        transfers: [
          { transferName: names[0], fromLine: '7', toLine: '2', stopsToTransfer: 1 },
          { transferName: names[1], fromLine: '2', toLine: '7', stopsToTransfer: 1 },
        ],
        stopsAfterLastTransfer: 1,
      }),
    });
    const heavy = multi('heavy', 20, ['건대입구', '건대입구']);
    const light = multi('light', 21, ['없는역', '없는역']);
    expect(tags(rankCandidates([heavy, light], 'elapsed'))).toEqual(['light', 'heavy']);
  });

  it('근사 동률 + 환승·도보 동일이면 정거장 수가 적은 쪽', () => {
    const many = cand({ tag: 'many', elapsedMin: 20, stops: 9 });
    const few = cand({ tag: 'few', elapsedMin: 21, stops: 4 });
    expect(tags(rankCandidates([many, few], 'elapsed'))).toEqual(['few', 'many']);
  });

  it('근사 동률 + 환승·도보·정거장 모두 같으면 총 소요가 짧은 쪽', () => {
    const slower = cand({ tag: 'slower', elapsedMin: 21 });
    const faster = cand({ tag: 'faster', elapsedMin: 20 });
    expect(tags(rankCandidates([slower, faster], 'elapsed'))).toEqual(['faster', 'slower']);
  });

  it('waitUnknown은 ε(2분)를 넘게 빠를 때만 1위 — 3분 빠르면 1위, 1분 빠르면 확정 후보가 1위', () => {
    const known = cand({ tag: 'known', elapsedMin: 20 });
    const unknownFast = cand({ tag: 'unk', elapsedMin: 17, waitUnknown: true });
    const unknownSlight = cand({ tag: 'unk', elapsedMin: 19, waitUnknown: true });
    expect(tags(rankCandidates([known, unknownFast], 'elapsed'))[0]).toBe('unk');
    expect(tags(rankCandidates([known, unknownSlight], 'elapsed'))[0]).toBe('known');
  });

  it('확정 후보가 하나도 없으면 waitUnknown끼리 총 소요로 비교', () => {
    const a = cand({ tag: 'A', elapsedMin: 21, waitUnknown: true });
    const b = cand({ tag: 'B', elapsedMin: 15, waitUnknown: true });
    expect(tags(rankCandidates([a, b], 'elapsed'))).toEqual(['B', 'A']);
  });

  it('lastTrainEnded는 아무리 짧아도 맨 뒤 — 전부 종료면 travelMinutes 순', () => {
    const ended = cand({ tag: 'ended', elapsedMin: 5, lastTrainEnded: true, travelMinutes: 5 });
    const ok = cand({ tag: 'ok', elapsedMin: 40 });
    expect(tags(rankCandidates([ended, ok], 'elapsed'))).toEqual(['ok', 'ended']);
    const e2 = cand({ tag: 'e2', elapsedMin: 30, lastTrainEnded: true, travelMinutes: 9 });
    const e3 = cand({ tag: 'e3', elapsedMin: 3, lastTrainEnded: true, travelMinutes: 12 });
    expect(tags(rankCandidates([e3, e2], 'elapsed'))).toEqual(['e2', 'e3']);
  });

  it('입력 순서와 무관하게 같은 결과(결정적)이고 입력 배열을 변형하지 않는다', () => {
    const list = [cand({ tag: 'A', elapsedMin: 20, transfers: 1 }), cand({ tag: 'B', elapsedMin: 21, transfers: 0 }), cand({ tag: 'C', elapsedMin: 30 })];
    const before = [...list];
    expect(tags(rankCandidates(list, 'elapsed'))).toEqual(tags(rankCandidates([...list].reverse(), 'elapsed')));
    expect(list).toEqual(before);
  });

  it('elapsed가 없는 후보는 travelMinutes를 총 소요로 본다(폴백)', () => {
    const a = { ...cand({ tag: 'A', elapsedMin: 0, travelMinutes: 30 }), elapsed: undefined };
    const b = { ...cand({ tag: 'B', elapsedMin: 0, travelMinutes: 10 }), elapsed: undefined };
    expect(tags(rankCandidates([a, b], 'elapsed'))).toEqual(['B', 'A']);
  });
});

describe('rankCandidates (transferFirst 모드 = 최소환승)', () => {
  it('환승 횟수 -> 총 소요: 환승 0이 더 느려도 1위', () => {
    const direct = cand({ tag: 'direct', elapsedMin: 40, transfers: 0 });
    const xfer = cand({ tag: 'xfer', elapsedMin: 15, transfers: 1 });
    expect(tags(rankCandidates([xfer, direct], 'transferFirst'))).toEqual(['direct', 'xfer']);
  });

  it('환승 횟수 같으면 총 소요(대기 포함) 짧은 쪽', () => {
    const a = cand({ tag: 'A', elapsedMin: 30, transfers: 1 });
    const b = cand({ tag: 'B', elapsedMin: 22, transfers: 1 });
    expect(tags(rankCandidates([a, b], 'transferFirst'))).toEqual(['B', 'A']);
  });

  it('lastTrainEnded는 환승 수가 적어도 맨 뒤', () => {
    const ended = cand({ tag: 'ended', elapsedMin: 5, transfers: 0, lastTrainEnded: true });
    const ok = cand({ tag: 'ok', elapsedMin: 40, transfers: 1 });
    expect(tags(rankCandidates([ended, ok], 'transferFirst'))).toEqual(['ok', 'ended']);
  });
});
