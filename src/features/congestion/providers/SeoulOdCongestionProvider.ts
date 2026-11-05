import type { CongestionProvider } from './types';
import type { LineNumber } from '../../../shared/types/station';
import type {
  CongestionDirection,
  CongestionEntry,
} from '../../../shared/types/congestion';

/**
 * 서울 열린데이터 OA-12928 (지하철혼잡도정보) 연동 provider — **stub**.
 *
 * #1097 P0-A PoC: 실제 인증키 발급 + endpoint 명세 확정 후 구현 예정.
 * 발급 키는 `EXPO_PUBLIC_SEOUL_DATA_API_KEY`를 재사용 가능.
 *
 * 구현 시 고려사항:
 * - OA-12928는 실시간이 아닌 30분 단위 평균 데이터셋이므로 in-memory cache(앱 lifetime)로 충분.
 * - 첫 호출 시 전체 fetch → in-memory index 구축, 이후 lookup은 O(1).
 * - 응답 필드: `STATN_NM`, `LINE_NUM`, `WEEK_TAG`, `INNER_OUTER`, `HR_5_30`...`HR_24_00`.
 */
export class SeoulOdCongestionProvider implements CongestionProvider {
  getCongestion(
    _stationName: string,
    _line: LineNumber,
    _direction: CongestionDirection,
    _now: Date,
  ): CongestionEntry | null {
    throw new Error(
      'SeoulOdCongestionProvider not implemented — 키 발급 후 후속 PR에서 endpoint 채울 것 (#1097)',
    );
  }
}
