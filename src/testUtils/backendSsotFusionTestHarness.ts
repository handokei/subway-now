/* eslint-disable import/no-restricted-paths -- shared test fixtures cross feature slices */
/**
 * #2414 (SonarCloud dup fix) — `useFusedNearestStation` backend-ssot 계열 테스트 공통
 * mock/harness setup. `useFusedNearestStation.estimatorBackendSsotOverride.test.ts`와
 * `useFusedNearestStation.backendSsotLastObserved.test.ts`가 리터럴 동일한 jest.mock 세트 +
 * mock 캐스팅 + 기준 station(용마산/청담) 상수를 각자 선언해 SonarCloud dup 임계(3%)를 초과했다
 * (7.8%). 순수 셋업만 이 파일로 추출 — 테스트 케이스/assertion은 각 파일에 그대로 유지.
 *
 * 사용법(중요 — import 순서): 이 harness를 **파일 최상단, 다른 어떤 import보다도 먼저** import한다.
 * jest.mock()은 babel-plugin-jest-hoist가 "그 콜이 작성된 파일" 안에서만 자기 파일의 다른 import보다
 * 위로 끌어올린다 — 다른 파일(this harness)의 jest.mock 호출은 그 파일이 import된 시점에 실행된다.
 * 따라서 harness import가 `useFusedNearestStation`(또는 그 내부에서 이 모듈들을 require하는 어떤
 * import)보다 뒤에 오면, 실제(비-mock) 모듈이 먼저 require&캐시되어 mock 등록이 무의미해진다.
 * 두 소비 파일 모두 첫 import 문으로 harness를 두는 것으로 이미 검증됨(대상 테스트 스위트 그린).
 */

import { useNearestStation } from '../features/nearest-station/hooks/useNearestStation';
import { useArrivalInfo } from '../features/arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../features/route/hooks/useTrainPositions';
import { findTopNearestStations } from '../features/nearest-station/utils/findNearestStation';
import { readBackendSsotMirror } from '../features/alarm/utils/backendSsotMirror';
import { findStationByNameAndLine } from '../shared/utils/stationRoute';

jest.mock('../features/nearest-station/hooks/useNearestStation');
jest.mock('../features/arrival/hooks/useArrivalInfo');
jest.mock('../features/route/hooks/useTrainPositions');
jest.mock('../features/nearest-station/utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../features/alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../features/alarm/utils/backendSsotMirror', () => ({ readBackendSsotMirror: jest.fn() }));

export const mockNearest = useNearestStation as jest.Mock;
export const mockArrival = useArrivalInfo as jest.Mock;
export const mockPos = useTrainPositions as jest.Mock;
export const mockFindTop = findTopNearestStations as jest.Mock;
export const mockRead = readBackendSsotMirror as jest.Mock;

// 두 소비 테스트가 공통 시나리오 기준으로 쓰는 7호선 역(용마산 origin / 청담 destination).
export const yongmasan = findStationByNameAndLine('용마산', '7')!;
export const chungdam = findStationByNameAndLine('청담', '7')!;
