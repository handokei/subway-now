import lineTopology from '../../data/lineTopology.json';

// #2877/#3122 — 신분당·수인분당은 stations.json 정렬 극성이 반대(idx 증가=상행, 나머지 노선은 idx 증가=하행).
// 실측 근거는 lineTopology.json의 `_reversedOrientationLines_comment` 참고. device 내 단일 출처 —
// direction↔idx 부호를 다루는 코드는 이 술어를 거친다(backend는 같은 JSON을 legDirection.ts에서 읽는다).
const REVERSED_ORIENTATION_LINES: ReadonlySet<string> = new Set(lineTopology.reversedOrientationLines);

export function isReversedOrientationLine(line: string): boolean {
  return REVERSED_ORIENTATION_LINES.has(line);
}
