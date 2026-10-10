/**
 * #1707 — Backend stations.json 좌표 lookup adapter.
 *
 * Backend는 자체 stations.json을 갖지 않는 정책 (types.ts L187/L399 주석 참조)이지만,
 * destination 도달 자동 종료 시 device GPS cross-check를 위해 destination station 좌표가 필요하다.
 * 직접 import 대신 shared `findStationByNameAndLine`을 backend adapter로 wrap해 device-shared
 * stations.json을 단일 SSoT로 활용한다 (#1604 `dijkstraRoute.ts`와 같은 패턴).
 *
 * 사용처: `scheduled.ts` `advanceBoardingLockWaypoint` destination 분기 +
 *         lockless intermediate destination 분기에서 마지막 device position 좌표와
 *         destination station 좌표 distance 계산.
 *
 * Backend가 frontend shared를 import하는 패턴은 [[lesson_backend_imports_frontend_shared]] 참조.
 * tsconfig include로 shared file 직접 컴파일.
 */
import type { EvidenceEnvironment } from './advanceTripPosition';
import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import type { LineNumber, Waypoint } from './types';

/** Station 좌표 (좌표만 필요한 호출자가 전체 Station 객체에 의존하지 않도록 좁힌 shape). */
export interface StationCoord {
  lat: number;
  lng: number;
}

/**
 * (stationName, line) → 좌표 lookup. shared `findStationByNameAndLine` 재사용 (canonical
 * fallback 포함, #1405). 매치 없으면 null — 호출자가 graceful skip.
 *
 * backend `LineNumber = string`이지만 shared lookup은 union LineNumber를 받음 — string
 * 호환성 보장(런타임 비교는 `===`). cast로 타입 시스템 경계만 통과.
 */
export function findStationCoordsByNameAndLine(
  name: string,
  line: LineNumber,
): StationCoord | null {
  const station = findStationByNameAndLine(
    name,
    line as Parameters<typeof findStationByNameAndLine>[1],
  );
  if (station === null) return null;
  return { lat: station.lat, lng: station.lng };
}

/**
 * #2623 — waypoint(다음 정차역) → stations.json `environment` 필드 파생.
 *
 * 발사/advance 판정(`advanceTripPosition` gate #3 evidence.environment)의 environment 입력을
 * device 기압계(`trip.subsurface`)가 아닌 역 데이터로 산출한다. `consensusGate.StationEnvironment`
 * docstring(E1 #1444)이 원래 stations.json 필드를 명시했으나 wire가 device subsurface로 잘못
 * 연결돼 지하 GPS 사망 상황에서 env=unknown이 GPS 증명을 강제하는 자기모순 회귀(#2623)를 냈다.
 *
 * `AdvanceEvidence.environment`(EvidenceEnvironment 어휘)와 타입 정합을 위해 stations.json
 * `mixed`는 `hybrid`로 매핑 — `mapEvidenceEnvironment`의 역방향 관례(advanceTripPosition.ts:97
 * 주석)와 동일. 역 lookup 실패 / environment 필드 부재 시 'unknown' fallback (기존 보수 정책 유지).
 */
export function deriveWaypointEnvironment(
  waypoint: Pick<Waypoint, 'stationName' | 'line'>,
): EvidenceEnvironment {
  const station = findStationByNameAndLine(
    waypoint.stationName,
    waypoint.line as Parameters<typeof findStationByNameAndLine>[1],
  );
  const environment = station?.environment;
  if (environment === 'mixed') return 'hybrid';
  if (environment === 'surface' || environment === 'underground') return environment;
  return 'unknown';
}
