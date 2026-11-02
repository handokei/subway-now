import { calculateStaticEtaDetail, findRouteCandidatesByCategory, findRoutes, findStationByNameAndLine, routeSignature } from '../stationRoute';

// #1480 PR-1 acceptance (계획 §5) — 10/28 실측 trip 179/180을 trip-register 시각으로 rank한다.
// 입력 근거(불변): backend/alarm-worker fixtures replay_20261028_sync_lockless/events_179.json(trip-register ts 1793136401077 = 06:26:41 KST,
// 뚝섬 도착 06:45:13) / events_180.json(register 1793175206886 = 17:13:26 KST, trip-end 1793176441468).
// 실측 소요 179 ≈ 18.8분 / 180 ≈ 20.6분(register -> 목적지 도착). 통과시키려 조정 금지.
const REGISTER_179_MS = 1793136401077;
const REGISTER_180_MS = 1793175206886;
const floorToMinute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
const id = (name: string, line: '2' | '7') => findStationByNameAndLine(name, line)!.id;

function rankFor(originName: string, originLine: '2' | '7', destName: string, destLine: '2' | '7', registerMs: number) {
  const nowMs = floorToMinute(registerMs);
  return findRouteCandidatesByCategory([id(originName, originLine)], id(destName, destLine), undefined, { nowMs });
}

describe('10/28 실측 trip rank (nowMs = trip-register 시각)', () => {
  it('trip 179 (용마산 -> 뚝섬): 최적경로 1순위 = 실제 탄 건대입구 환승, 총 소요 실측(18.8분) ±2분', () => {
    const [optimal] = rankFor('용마산', '7', '뚝섬', '2', REGISTER_179_MS);
    const { route, elapsed } = optimal.candidate;
    expect(route.type).toBe('transfer');
    expect(route.type === 'transfer' && route.transferName).toBe('건대입구');
    expect(Math.abs(elapsed!.seconds / 60 - 18.8)).toBeLessThanOrEqual(2);
  });

  it('trip 180 (성수 -> 용마산): 최적경로 1순위 = 실제 탄 건대입구 환승, 총 소요 실측(20.6분) ±2분', () => {
    const [optimal] = rankFor('성수', '2', '용마산', '7', REGISTER_180_MS);
    const { route, elapsed } = optimal.candidate;
    expect(route.type).toBe('transfer');
    expect(route.type === 'transfer' && route.transferName).toBe('건대입구');
    expect(Math.abs(elapsed!.seconds / 60 - 20.6)).toBeLessThanOrEqual(2);
  });

  it.each([
    ['trip 179', '용마산', '7', '뚝섬', '2', REGISTER_179_MS],
    ['trip 180', '성수', '2', '용마산', '7', REGISTER_180_MS],
  ] as const)('%s: 두 칩 모두 후보를 내고 elapsed가 부착된다', (_n, o, ol, d, dl, ms) => {
    const result = rankFor(o, ol, d, dl, ms);
    expect(result.map((r) => r.category.key)).toEqual(['optimal', 'minTransfer']);
    for (const { candidate } of result) expect(candidate.elapsed).toBeDefined();
  });

  it.each([
    ['trip 179', '용마산', '7', '뚝섬', '2', REGISTER_179_MS],
    ['trip 180', '성수', '2', '용마산', '7', REGISTER_180_MS],
  ] as const)('%s: 1순위가 아닌 대안(다중 환승)의 총 소요는 1순위보다 크다', (_n, o, ol, d, dl, ms) => {
    const nowMs = floorToMinute(ms);
    const [optimal] = rankFor(o, ol, d, dl, ms);
    const alternatives = findRoutes(id(o, ol), id(d, dl)).filter((c) => routeSignature(c.route) !== routeSignature(optimal.candidate.route));
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alt of alternatives) {
      const detail = calculateStaticEtaDetail(alt.route, { nowMs, originStationId: alt.originStationId })!;
      expect(detail.totalSeconds).toBeGreaterThan(optimal.candidate.elapsed!.seconds);
    }
  });
});
