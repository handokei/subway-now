import type { ArrivalProvider, ArrivalOptions } from './types';
import type { StationArrival } from '../api/arrivalApi';
import type { KorailArrivalProvider } from './KorailArrivalProvider';
import { isKorailLine } from '../../../shared/constants/lineOperators';
import { findLineByStationName } from '../../../shared/utils/stationLookup';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('CompositeArrivalProvider');

/**
 * 운영사 기반 routing arrival provider (#1096 PoC).
 *
 * 의사결정:
 *   1. lineHint(또는 stationName lookup)로 노선 운영사 판정.
 *   2. Korail 운영 노선이고 KorailArrivalProvider가 사용 가능하면 1차 시도.
 *      - null 반환 또는 throw 시 서울 OD provider로 fallback (graceful).
 *   3. 그 외 (Seoul, other, 운영사 미확정)는 기존 서울 OD provider 직행.
 *
 * 기존 SeoulOpenApiProvider 호출 경로는 변경하지 않는다 — Composite는 wrapper일 뿐
 * 호출자가 명시적으로 선택할 때만 활성화된다 (factory에서 USE_KORAIL_FALLBACK env로 게이트).
 */
export class CompositeArrivalProvider implements ArrivalProvider {
  constructor(
    private readonly korail: KorailArrivalProvider,
    private readonly fallback: ArrivalProvider,
  ) {}

  async getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival> {
    const line = options?.lineHint ?? findLineByStationName(stationName);

    if (line && isKorailLine(line) && this.korail.isAvailable) {
      try {
        const result = await this.korail.getArrival(stationName, options);
        if (result) {
          log.info('korail_primary_hit', { station: stationName, line });
          return result;
        }
        log.info('korail_primary_null_fallback', { station: stationName, line });
      } catch (error) {
        log.warn('korail_primary_throw_fallback', {
          station: stationName,
          line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.fallback.getArrival(stationName, options);
  }
}
