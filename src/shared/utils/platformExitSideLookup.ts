import platformExitSideData from '../../data/platformExitSide.json';
import directionalData from '../../data/platformExitSideByDirection.json';
import type { TravelDirection } from '../types/exitSide';
import type {
  DirectionalExitSideMap,
  PlatformExitSide,
  PlatformExitSideMap,
} from '../types/platformExitSide';

// JSON import는 side를 string으로 추론하므로 PlatformExitSideMap으로 명시 캐스팅한다.
const PLATFORM_EXIT_SIDE_MAP = platformExitSideData as PlatformExitSideMap;
const DIRECTIONAL_EXIT_SIDE_MAP = directionalData as DirectionalExitSideMap;

// station id (예: '2-009')로 하차문 방향을 조회한다.
// 매핑이 없으면 null을 반환해 caller가 graceful fallback 할 수 있게 한다.
//
// 본 SSOT는 승강장 구조 기반 정적 데이터로 방향(up/down) 무관.
// 진행 방향별 fine-grained 정보가 필요하면 features/route/utils/exitSide.ts의
// lookupExitSide(stationName, direction)을 사용한다.
export function lookupPlatformExitSide(stationId: string): PlatformExitSide | null {
  return PLATFORM_EXIT_SIDE_MAP[stationId]?.side ?? null;
}

// station id + 진행방향으로 인용 문장 근거가 있는 방향별 하차문 방향을 조회한다(wiki 등급).
// 항목이 없으면 null — 구조 기반 fallback(lookupPlatformExitSide) 또는 라인 생략은 caller 몫.
export function lookupDirectionalExitSide(
  stationId: string,
  direction: TravelDirection,
): PlatformExitSide | null {
  return DIRECTIONAL_EXIT_SIDE_MAP[stationId]?.[direction] ?? null;
}
