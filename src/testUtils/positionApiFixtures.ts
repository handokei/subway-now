/**
 * useFusedNearestStation 계열 테스트에서 공통으로 사용하는 mock 응답 빌더.
 * 여러 테스트 파일에 동일 함수가 중복 정의되는 것을 방지하기 위해 추출.
 */
import type { StationArrival } from '../shared/types/arrival';
import type { LinePositions, TrainPosition } from '../features/nearest-station/api/positionApi';

/**
 * useNearestStation mock의 고정 필드 기본값.
 * 각 테스트 파일은 result/variants/userLocation만 오버라이드하면 된다.
 */
export const GPS_BASE_DEFAULTS = {
  speedMps: 1,
  accuracyMeters: 50,
  loading: false,
  error: null,
  permissionDenied: false,
  locationUncertain: false,
} as const;

export function arrivalRet(stationArrival: StationArrival | null) {
  return { arrival: stationArrival, loading: false, isMock: false };
}

export function positionRet(positions: LinePositions | null) {
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
