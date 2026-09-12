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
import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import type { LineNumber } from './types';

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
