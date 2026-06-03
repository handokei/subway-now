/**
 * `LineNumber` runtime 가드 (#828).
 *
 * 외부 source(AsyncStorage, network payload, telemetry round-trip 등)에서 들어온 string을
 * `LineNumber`로 안전하게 좁힌다. 새 노선 추가 시 `stations.json`만 갱신하면 자동으로
 * 인식되므로 type 단언이나 if-else 체인이 필요없다 (데이터 주도 — CLAUDE.md 글로벌 규칙 3번).
 */

import stations from '../data/stations.json';
import type { LineNumber, Station } from '../types/station';

/**
 * `stations.json`의 line 필드 union set. 모듈 로드 시 1회 계산되어 캐시된다.
 * 새 노선이 stations.json에 추가되면 별도 list 갱신 없이 자동 인식.
 */
const KNOWN_LINE_CODES: ReadonlySet<string> = new Set(
  (stations as Station[]).map((s) => s.line),
);

/** 문자열이 stations.json에 존재하는 line 코드인지 좁힌다. */
export function isLineNumber(value: unknown): value is LineNumber {
  return typeof value === 'string' && KNOWN_LINE_CODES.has(value);
}
