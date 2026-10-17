/**
 * #2949 C-2 — 2호선 순환선 seam(시청↔충정로) 출발 42쌍 전수 매트릭스 (backend `inferLegDirection`).
 *
 * device 쪽 동등 테스트(`src/features/route/utils/__tests__/line2SeamDirectionMatrix.test.ts`)와
 * 같은 #2867 arc-length ground truth 오라클을 backend `inferLegDirection`에 대조한다 — #2949
 * 코디네이터 범위 정정 ③이 요구하는 "같은 공식을 쓰는 세 번째 함수"를 device와 **동일 입력에
 * 동일 값**(거부 케이스 ⓕ, device↔backend 일관성)으로 고정한다.
 *
 * fix 전에는 device와 똑같이 84개 중 42개(시청 21 + 충정로 21)가 red다.
 */
import { describe, expect, it } from 'vitest';
import { inferLegDirection } from '../legDirection';
import stationsRaw from '../../../../src/data/stations.json';

type Station = { id: string; line: string; name: string };
const stations = stationsRaw as Station[];

const MAIN_FIRST_ID = '2-001'; // 시청
const MAIN_LAST_ID = '2-043'; // 충정로(경기대입구)

const line2 = stations.filter((s) => s.line === '2').sort((a, b) => a.id.localeCompare(b.id));
const mainStations = line2.filter((s) => s.id >= MAIN_FIRST_ID && s.id <= MAIN_LAST_ID);
const subLen = mainStations.length; // 43

/** #2867 arc-length ground truth — 구현과 독립적으로 계산한 오라클 (device 테스트와 동일 공식). */
function groundTruthDirection(fromPos: number, toPos: number): 'up' | 'down' {
  const plusHops = (toPos - fromPos + subLen) % subLen;
  const minusHops = subLen - plusHops;
  return plusHops <= minusHops ? 'up' : 'down';
}

const sicheongPos = mainStations.findIndex((s) => s.id === MAIN_FIRST_ID);
const chungjeongnoPos = mainStations.findIndex((s) => s.id === MAIN_LAST_ID);

type Pair = { fromName: string; toName: string; expected: 'up' | 'down' };

function buildPairsFrom(fromPos: number): Pair[] {
  const fromName = mainStations[fromPos].name;
  const pairs: Pair[] = [];
  for (let toPos = 0; toPos < subLen; toPos++) {
    if (toPos === fromPos) continue;
    pairs.push({
      fromName,
      toName: mainStations[toPos].name,
      expected: groundTruthDirection(fromPos, toPos),
    });
  }
  return pairs;
}

const allPairs = [...buildPairsFrom(sicheongPos), ...buildPairsFrom(chungjeongnoPos)];

describe('2호선 seam 출발(시청·충정로) 42쌍 전수 매트릭스 — backend inferLegDirection (#2949 C-2)', () => {
  it('정확히 84쌍을 검사하고, 그중 42쌍이 시청, 42쌍이 충정로 출발이다 (전제 검증)', () => {
    expect(allPairs.length).toBe(84);
    expect(allPairs.filter((p) => p.fromName === mainStations[sicheongPos].name).length).toBe(42);
    expect(allPairs.filter((p) => p.fromName === mainStations[chungjeongnoPos].name).length).toBe(42);
  });

  it.each(allPairs.map((p) => [p.fromName, p.toName, p.expected] as const))(
    '%s → %s → %s',
    (fromName, toName, expected) => {
      expect(inferLegDirection('2', fromName, toName)).toBe(expected);
    },
  );
});
