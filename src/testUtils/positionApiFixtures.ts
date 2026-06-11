/**
 * useFusedNearestStation 계열 테스트에서 공통으로 사용하는 mock 응답 빌더.
 * 여러 테스트 파일에 동일 함수가 중복 정의되는 것을 방지하기 위해 추출.
 */
import type { StationArrival } from '../shared/types/arrival';
import type { LinePositions, TrainPosition } from '../features/nearest-station/api/positionApi';

export function arrivalRet(stationArrival: StationArrival | null = null) {
  return { arrival: stationArrival, loading: false, isMock: false };
}

export function positionRet(positions: LinePositions | null = null) {
  return { positions, loading: false, isMock: false };
}

export function makeTrain(
  statnNm: string,
  trainStatus: number,
  overrides?: Partial<TrainPosition>,
): TrainPosition {
  return {
    statnId: '',
    statnNm,
    trainNo: 'T',
    trainStatus,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}
