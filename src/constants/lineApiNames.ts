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
