import type { LineNumber } from '../types/station';

/**
 * 서울 열린데이터 API `realtimePosition` 호출 시 `subwayNm` 파라미터로 사용하는 호선명.
 * 새 호선 추가 시 LineNumber 타입과 이 매핑 한 줄씩만 추가.
 *
 * 스펙 매핑(subwayId → 호선명):
 *   1001:1호선 ~ 1009:9호선
 *   1063:경의중앙선, 1065:공항철도, 1075:수인분당선, 1077:신분당선
 */
export const LINE_API_NAMES: Record<LineNumber, string> = {
  '1': '1호선',
  '2': '2호선',
  '3': '3호선',
  '4': '4호선',
  '5': '5호선',
  '6': '6호선',
  '7': '7호선',
  '8': '8호선',
  '9': '9호선',
  airport: '공항철도',
  gyeongui: '경의중앙선',
  bundang: '수인분당선',
  sinbundang: '신분당선',
};

export function getLineApiName(line: LineNumber): string {
  return LINE_API_NAMES[line];
}

/**
 * 서울 열린데이터 `realtimeStationArrival` 응답 `subwayId`(예: "1001") → LineNumber 역매핑.
 * 환승역에서 같은 statnNm으로 두 노선 열차가 함께 응답되므로, 각 row의 정확한 호선 식별에 필요.
 * LINE_API_NAMES 추가 시 이 매핑도 함께 확장 — 호선 누락 시 어댑터에서 row 식별 실패.
 */
const SUBWAY_ID_TO_LINE: Record<string, LineNumber> = {
  '1001': '1',
  '1002': '2',
  '1003': '3',
  '1004': '4',
  '1005': '5',
  '1006': '6',
  '1007': '7',
  '1008': '8',
  '1009': '9',
  '1063': 'gyeongui',
  '1065': 'airport',
  '1075': 'bundang',
  '1077': 'sinbundang',
};

/**
 * subwayId → LineNumber. 매핑 실패 시 null.
 * value는 unknown — 서울 API raw 응답에서 string·number·undefined 모두 가능하기 때문.
 * object/array는 의미 없는 stringification("[object Object]") 방지를 위해 거부.
 */
export function subwayIdToLine(value: unknown): LineNumber | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return SUBWAY_ID_TO_LINE[String(value)] ?? null;
}
