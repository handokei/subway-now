import {
  findBoardableDeparture,
  type DepartureLookupResult,
} from '../../../shared/utils/timetableShared';
import type {
  TimetableLookupParams,
  TimetableLookupResult,
  TimetableProvider,
} from './TimetableProvider';

/**
 * 정적 timetable JSON(`src/data/timetables/line-{1..9}.json`) 기반 Provider (#1480).
 *
 * - 외부 API 호출 0 — 즉시 lookup, latency 0.
 * - 1~9호선만 timetable 보유. 그 외 노선은 `no-timetable` 반환.
 * - 동기 lookup 지원 (`getBoardableDepartureSync`).
 *
 * Follow-up cascade (이슈 #1480 정정 2):
 *   1. `getTrainSch` Provider — 호선/급행 여부 (별도 sub)
 *   2. `SearchSTNTimeTableByIDService` Provider — 역 단위 (별도 sub)
 *   3. **본 Provider — 정적 JSON (즉시 lookup)**
 *   4. 호출자 정적 ETA fallback
 */
export class StaticTimetableProvider implements TimetableProvider {
  readonly source = 'static' as const;

  async getBoardableDeparture(params: TimetableLookupParams): Promise<TimetableLookupResult> {
    return this.getBoardableDepartureSync(params);
  }

  getBoardableDepartureSync(params: TimetableLookupParams): TimetableLookupResult {
    const result: DepartureLookupResult = findBoardableDeparture(params);
    if (result.status === 'ok') {
      return { status: 'ok', departure: result.departure };
    }
    return { status: result.status };
  }
}
