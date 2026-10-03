import type { LineNumber } from '../../../shared/types/station';
import type { ExitInfo } from '../../../shared/types/exitInfo';
import type { ExitInfoProvider } from './types';

/**
 * 서울 OD OA-15993 ('지하철역 출구별 주요 시설 정보') 실 API 구현 stub.
 *
 * 키 발급 + 응답 스키마 확정 후 follow-up PR에서 fetch 로직 채움. 본 PoC 단계에서는
 * `EXPO_PUBLIC_SEOUL_DATA_API_KEY`를 받아 보관만 한다. 호출 시 빈 배열을 돌려주면
 * UI는 graceful하게 "출구 정보 없음"으로 표시한다 (interface 계약).
 *
 * 명세 참고: http://openapi.seoul.go.kr:8088/{KEY}/json/SearchInfoBySubwayNameService/...
 */
export class SeoulOdExitInfoProvider implements ExitInfoProvider {
  constructor(private readonly apiKey: string) {}

  async getExits(_stationName: string, _line: LineNumber): Promise<ExitInfo[]> {
    // PoC stub — API 키 발급 후 fetch + parse 채울 예정.
    // apiKey가 의도적으로 보관됨을 표시 (lint/TS unused 회피).
    void this.apiKey;
    return [];
  }
}
