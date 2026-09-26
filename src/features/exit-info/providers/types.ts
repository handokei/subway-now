/**
 * ExitInfoProvider — 역 + 노선을 받아 출구별 시설 정보를 반환하는 추상 인터페이스.
 *
 * 구현체:
 *  - `MockExitInfoProvider`: `src/data/exit-info-sample.json` 기반 (개발/테스트)
 *  - `SeoulOdExitInfoProvider`: 서울 OD OA-15993 실 API (키 발급 후 활성)
 */

import type { LineNumber } from '../../../shared/types/station';
import type { ExitInfo } from '../../../shared/types/exitInfo';

export interface ExitInfoProvider {
  /**
   * 주어진 역+노선에 대한 모든 출구 정보를 반환한다.
   * 데이터가 없으면 빈 배열을 반환한다 (throw 금지 — UI는 "출구 정보 없음"으로 표시).
   */
  getExits(stationName: string, line: LineNumber): Promise<ExitInfo[]>;
}
