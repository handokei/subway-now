import type { ArrivalProvider, ArrivalOptions } from './types';
import { MOCK_ARRIVALS, type StationArrival } from '../api/arrivalApi';
import { findLineByStationName } from '../../nearest-station/utils/stationLookup';
import { buildScheduleArrival, hasHeadwayData } from '../../alarm/utils/scheduleFallback';

/**
 * 개발/테스트용 mock arrival provider.
 *
 * #805: 기존 구현은 하드코딩 정적 `MOCK_ARRIVALS`만 반환해 BoardingTrainList의 "곧 도착"/"전역 출발"
 * 같은 상태 회귀를 mock에서 재현할 수 없었다. 이제는 stationName + lineHint로 실제 시간표 데이터를
 * 조회해 결정적 schedule fallback을 만든다 — 실 서비스의 `getFallbackArrival`과 동일한 정책이라
 * UI 회귀 가드가 mock 경로에서도 동작한다.
 *
 * - stationName이 시간표 데이터에 매핑되면 `buildScheduleArrival`이 SCHED-* trainCode + 결정적
 *   arrivalSeconds를 갖는 StationArrival을 반환.
 * - station/line lookup 실패 또는 headway 데이터 누락 시 하드코딩 `MOCK_ARRIVALS` 최후 fallback —
 *   기존 호출자(스토리북, 테스트)가 station 미지정으로 호출할 때의 동작을 보존한다.
 */
export class MockArrivalProvider implements ArrivalProvider {
  async getArrival(
    stationName: string,
    options?: ArrivalOptions,
  ): Promise<StationArrival> {
    const line = options?.lineHint ?? findLineByStationName(stationName);
    if (!line || !hasHeadwayData(line)) {
      return MOCK_ARRIVALS;
    }
    return buildScheduleArrival(line, stationName, new Date());
  }
}
