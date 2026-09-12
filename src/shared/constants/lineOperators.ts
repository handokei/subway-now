/**
 * 노선 → 운영사 매핑 (#1096 PoC).
 *
 * 서울 열린데이터 API(서울교통공사)는 코레일 운영 구간(경의중앙, 수인분당 등)에서 데이터
 * 품질 격차가 있어, 코레일 자체 API를 1차로 시도하고 실패 시 서울 OD로 fallback하는 routing의
 * 기반 데이터다.
 *
 * 매핑 원칙: "해당 노선의 다수 구간을 누가 운영하는가" 기준.
 * - 1~8호선: 서울교통공사 (Seoul Metro)
 * - 9호선: 서울시메트로9호선㈜ — 서울 OD가 정식 데이터 제공자라 'seoul'로 묶는다
 * - 경의중앙선, 수인분당선: 한국철도공사 (Korail)
 * - 공항철도: 공항철도㈜ (서울/코레일 모두 아님) — 서울 OD 사용
 * - 신분당선: 네오트랜스/새서울철도 — 서울 OD 사용
 *
 * 새 운영사 추가 시 LineOperator 유니온과 LINE_OPERATORS 매핑만 확장.
 */

import type { LineNumber } from '../types/station';

export type LineOperator = 'seoul' | 'korail' | 'other';

export const LINE_OPERATORS: Record<LineNumber, LineOperator> = {
  '1': 'seoul',
  '2': 'seoul',
  '3': 'seoul',
  '4': 'seoul',
  '5': 'seoul',
  '6': 'seoul',
  '7': 'seoul',
  '8': 'seoul',
  '9': 'seoul',
  airport: 'other',
  gyeongui: 'korail',
  bundang: 'korail',
  sinbundang: 'other',
};

export function getLineOperator(line: LineNumber): LineOperator {
  return LINE_OPERATORS[line];
}

/** Korail 자체 API로 1차 조회를 시도해야 하는 노선인지. */
export function isKorailLine(line: LineNumber): boolean {
  return LINE_OPERATORS[line] === 'korail';
}
