/**
 * 출구별 시설 데이터 타입 (#1097 P0).
 *
 * 데이터 출처: 서울특별시 공공데이터 "지하철역 출구별 주요 시설 정보" (OA-15993).
 * https://data.seoul.go.kr/dataList/OA-15993/S/1/datasetView.do
 *
 * exitSide(좌/우 하차 방향)와는 별개 차원이다. 본 타입은 "N번 출구가 무엇과 가까운가"를
 * 표현하며, 도착 안내 시 사용자가 사전에 출구를 결정할 수 있게 돕는다.
 */

import type { LineNumber } from './station';

/**
 * 단일 출구의 부가 정보.
 *
 * - `exitNumber`는 문자열 ("1", "1-1" 형태 포함). 일부 역은 한 글자 suffix를 쓰므로 number 사용 금지.
 * - `facilities`는 출구 인근 주요 시설 목록 (학교/관공서/대형 상가 등).
 * - `nearby`는 자유 텍스트 보조 설명(있는 경우만).
 */
export interface ExitInfo {
  stationName: string;
  line: LineNumber;
  exitNumber: string;
  facilities: string[];
  nearby?: string;
}
