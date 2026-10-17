/**
 * #2949 C-2 — 2호선 순환선 seam(시청↔충정로) 출발 42쌍 전수 매트릭스.
 *
 * 이슈 본문 실측: 2호선 본선 43역 × 전체 1,806쌍 중 불일치는 42쌍(2.3%)뿐이고, 그 출발역은
 * **시청(21쌍) · 충정로(21쌍)** 둘뿐이다. 시청은 본선 idx 최솟값(0)이라 옛 공식
 * (`firstStepIdx > fromIdx ? 'up' : 'down'`)이 항상 참이 되어 영원히 'up', 충정로는 idx
 * 최댓값(42)이라 항상 거짓이 되어 영원히 'down' — 그래서 두 역에서 출발하는 쌍만 틀린다.
 *
 * 본 테스트는 두 역에서 출발해 나머지 42개 본선역으로 가는 전체 84쌍을 **#2867 arc-length
 * ground truth**(두 역의 본선 subset 내 위치를 plusHops/minusHops로 비교, `plusHops <= minusHops`
 * → 'up')와 대조한다. 이 오라클은 구현(`directionOnLine`/`resolveTripDirection`)을 호출하지
 * 않고 독립적으로 계산한다 — 84쌍 중 42쌍(시청 21 + 충정로 21)이 옛 공식과 불일치해 **fix 전
 * red 42건**이 나와야 한다(나머지 42쌍은 옛 공식이 우연히 맞았던 쌍).
 *
 * `directionOnLine`과 `resolveTripDirection`을 **함께** 검증한다 — #2949 거부 케이스 ⓓ
 * (`detectMisBoarding`의 "오탐 없음"이 두 함수의 일관된 값에 의존)가 요구하는 대로, 한쪽만
 * 고치고 한쪽을 빠뜨리는 회귀를 이 테스트가 바로 잡는다.
 */
import { directionOnLine } from '../directionOnLine';
import { resolveTripDirection } from '../tripDirection';
import { getStationsOnLine, type DirectRoute } from '../../../../shared/utils/stationRoute';

const MAIN_FIRST_ID = '2-001'; // 시청
const MAIN_LAST_ID = '2-043'; // 충정로(경기대입구)

const line2 = getStationsOnLine('2');
const mainStations = line2.filter((s) => s.id >= MAIN_FIRST_ID && s.id <= MAIN_LAST_ID);
const subLen = mainStations.length; // 43

/** #2867 arc-length ground truth — 구현과 독립적으로 계산한 오라클. */
function groundTruthDirection(fromPos: number, toPos: number): 'up' | 'down' {
  const plusHops = (toPos - fromPos + subLen) % subLen;
  const minusHops = subLen - plusHops;
  return plusHops <= minusHops ? 'up' : 'down';
}

const sicheongPos = mainStations.findIndex((s) => s.id === MAIN_FIRST_ID);
const chungjeongnoPos = mainStations.findIndex((s) => s.id === MAIN_LAST_ID);

type Pair = { fromName: string; fromPos: number; toName: string; toId: string; toPos: number; expected: 'up' | 'down' };

function buildPairsFrom(fromPos: number): Pair[] {
  const fromName = mainStations[fromPos].name;
  const pairs: Pair[] = [];
  for (let toPos = 0; toPos < subLen; toPos++) {
    if (toPos === fromPos) continue;
    pairs.push({
      fromName,
      fromPos,
      toName: mainStations[toPos].name,
      toId: mainStations[toPos].id,
      toPos,
      expected: groundTruthDirection(fromPos, toPos),
    });
  }
  return pairs;
}

const allPairs = [...buildPairsFrom(sicheongPos), ...buildPairsFrom(chungjeongnoPos)];

describe('2호선 seam 출발(시청·충정로) 42쌍 전수 매트릭스 — #2867 ground truth 대조 (#2949 C-2)', () => {
  it('정확히 84쌍을 검사하고, 그중 42쌍이 시청, 42쌍이 충정로 출발이다 (전제 검증)', () => {
    const fromSicheong = allPairs.filter((p) => p.fromPos === sicheongPos);
    const fromChungjeongno = allPairs.filter((p) => p.fromPos === chungjeongnoPos);
    expect(allPairs.length).toBe(84);
    expect(fromSicheong.length).toBe(42);
    expect(fromChungjeongno.length).toBe(42);
  });

  describe.each(allPairs.map((p) => [p.fromName, p.toName, p.toId, p.fromPos, p.toPos, p.expected] as const))(
    '%s → %s',
    (fromName, toName, toId, fromPos, toPos, expected) => {
      const fromId = mainStations[fromPos].id;

      it(`directionOnLine → ${expected}`, () => {
        expect(directionOnLine('2', fromId, toId)).toBe(expected);
      });

      it(`resolveTripDirection (direct route) → ${expected}`, () => {
        const route: DirectRoute = { type: 'direct', stops: 1, line: '2', travelSeconds: 0 };
        expect(resolveTripDirection(route, toName, fromId)).toBe(expected);
      });
    },
  );
});
