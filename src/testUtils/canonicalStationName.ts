import { findStationByNameAndLine } from '../shared/utils/stationLookup';
import type { LineNumber } from '../shared/types/station';

/**
 * 테스트에서 base name(예: '교대')으로 정식 표기(예: '교대(법원.검찰청)')를 룩업.
 *
 * stations.json은 Seoul Open API BLDN_NM 정식 표기를 SSOT로 사용하므로,
 * 테스트가 base 문자열을 hardcoding하면 파이프라인 재실행마다 drift 발생.
 * 이 헬퍼는 production `findStationByNameAndLine`(stationLookup.ts, #1405)에
 * 위임하여 normalize + alias(예: 자양↔뚝섬유원지) + 괄호 부제 fallback 등
 * canonical 매칭 규칙을 그대로 공유한다 — 테스트와 production 의미 정합성 1곳에서 보장.
 *
 * 매칭 실패 시 base 그대로 반환 (테스트 fallback).
 */
export function canonicalStationName(base: string, line: LineNumber): string {
  return findStationByNameAndLine(base, line)?.name ?? base;
}
