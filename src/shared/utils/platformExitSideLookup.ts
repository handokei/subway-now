import platformExitSideData from '../../data/platformExitSide.json';
import directionalData from '../../data/platformExitSideByDirection.json';
import type { TravelDirection } from '../types/exitSide';
import type {
  DirectionalExitSideMap,
  PlatformExitSide,
  PlatformExitSideMap,
  TerminusRelation,
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

// station id + 진행방향 + 종착 관계로 인용 문장 근거가 있는 방향별 하차문 방향을 조회한다(wiki 등급).
//   null          — 항목 없음: caller가 구조 기반 fallback(lookupPlatformExitSide)을 쓴다.
//   { side: null } — 항목은 있으나 이 열차의 문 방향을 단정할 근거가 없음: 문 라인을 생략한다.
//     · 당역 종착인데 terminating 값이 없다.
//     · 종착 여부를 모르는데 terminating 값이 통과 값과 다르다(어느 쪽인지 알 수 없다).
export function lookupDirectionalExitSide(
  stationId: string,
  direction: TravelDirection,
  terminus: TerminusRelation,
): { side: PlatformExitSide | null } | null {
  const entry = DIRECTIONAL_EXIT_SIDE_MAP[stationId];
  if (!entry) return null;
  const through = entry[direction];
  const terminating = entry.terminating?.[direction];
  if (terminus === 'here') return { side: terminating ?? null };
  if (terminus === 'unknown' && terminating && terminating !== through) return { side: null };
  return { side: through };
}
