/**
 * #3177 — backend 알림 본문의 하차문(좌/우) 판정.
 *
 * device `resolveExitSide`(stationNotification.ts)와 같은 SSoT(`resolveExitSideForStation`)를 그대로 쓴다.
 *  - 입력은 `Waypoint.stationId`(실제 내리는 승강장 id, 환승은 fromLine 쪽)뿐 — 이름 조회 없음(환승역에서 다른 노선 값을 집지 않는다).
 *  - transfer/destination만. intermediate는 하차하지 않으므로 대상이 아니다.
 *  - 판정 불가(stationId 없음 / 미지 id / 데이터 없음 / 방향별 근거 없음)는 null — 호출부는 줄을 생략한다(ADR-010: 틀린 줄보다 없는 줄).
 *  - 종착 관계: backend는 열차 종착역을 보유하지 않으므로 'unknown'. SSoT가 종착 여부에 따라 값이 달라지는 역은 스스로 null을 낸다.
 */
import type { TravelDirection } from '../../../src/shared/types/exitSide';
import type { PlatformExitSide } from '../../../src/shared/types/platformExitSide';
import { resolveExitSideForStation } from '../../../src/shared/utils/resolveExitSideForStation';
import type { Waypoint } from './types';

export function resolveWaypointExitSide(waypoint: Waypoint, direction: TravelDirection | null): PlatformExitSide | null {
  const { kind, stationId } = waypoint;
  if (kind === 'intermediate' || !stationId) return null;
  const { side } = resolveExitSideForStation({
    stationId,
    direction: direction ?? undefined,
    terminus: 'unknown',
  });
  return side;
}
