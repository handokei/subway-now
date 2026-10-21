/**
 * RED STUB (#3132) — 레거시 의미(모름을 0으로 접음)를 그대로 돌려줘서 테스트가 import 실패가 아니라
 * 단정 실패로 red가 되게 한다. fix 커밋에서 실제 구현으로 교체된다.
 */
import type { ArrivalInfo } from '../types/arrival';

export interface ArrivalEtaPosition {
  primary: string;
  secondary?: string;
}

export function isEtaUnknownRow(_barvlDt: number, _arrivalCode: number): boolean {
  return false;
}

export function parseStopsAway(
  _statusMessage: string,
  _arrivalCode: number,
  _etaUnknown: boolean,
): number | null {
  return null;
}

export function hasKnownEta<T extends { arrivalSeconds: number | null }>(
  _row: T,
): _row is T & { arrivalSeconds: number } {
  return true;
}

export function orderKnownEtaFirst<T extends Pick<ArrivalInfo, 'arrivalSeconds' | 'stopsAway'>>(
  rows: readonly T[],
): T[] {
  return [...rows];
}

export function formatArrivalEtaPosition(
  row: Pick<ArrivalInfo, 'statusMessage' | 'stopsAway' | 'locationStation'>,
): ArrivalEtaPosition {
  return { primary: row.statusMessage };
}
