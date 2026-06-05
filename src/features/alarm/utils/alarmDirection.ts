/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import type { AlarmEvent } from './stationAlarm';
import type { Route } from '../../../shared/utils/stationRoute';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import type { TravelDirection } from '../../../shared/types/exitSide';
import { resolveTravelDirection } from '../../route/utils/travelDirection';

interface ResolveAlarmDirectionInput {
  route: NonNullable<Route>;
  destinationName: string;
  // 사용자가 현재 탑승해 있는 출발역. DirectRoute나 첫 환승 전 구간의 방향을 결정한다.
  sourceStationName: string;
}

// 알람 이벤트의 대상역까지 가는 마지막 구간을 찾아, 그 구간의 노선/출발/도착으로
// 진행방향(상행/하행)을 결정한다. 어느 노선·역이라도 매칭 못 하면 undefined를
// 반환해, 알람 본문에서 좌/우 라인이 표시되지 않는다(잘못된 안내 회피).
export function resolveAlarmDirection(
  event: Pick<AlarmEvent, 'type' | 'stationName'>,
  { route, destinationName, sourceStationName }: ResolveAlarmDirectionInput,
): TravelDirection | undefined {
  if (route.type === 'direct') {
    if (!isSameStationName(event.stationName, destinationName)) return undefined;
    return resolveTravelDirection(route.line, sourceStationName, destinationName)?.direction;
  }

  if (route.type === 'transfer') {
    if (isSameStationName(event.stationName, route.transferName)) {
      return resolveTravelDirection(route.fromLine, sourceStationName, route.transferName)?.direction;
    }
    if (isSameStationName(event.stationName, destinationName)) {
      return resolveTravelDirection(route.toLine, route.transferName, destinationName)?.direction;
    }
    return undefined;
  }

  // multi-transfer: 대상역이 transfers의 몇 번째에 해당하는지 또는 최종 목적지인지 판별.
  const { transfers } = route;
  for (let i = 0; i < transfers.length; i++) {
    const segment = transfers[i];
    if (!isSameStationName(event.stationName, segment.transferName)) continue;
    const prevAnchor = i === 0 ? sourceStationName : transfers[i - 1].transferName;
    return resolveTravelDirection(segment.fromLine, prevAnchor, segment.transferName)?.direction;
  }
  if (isSameStationName(event.stationName, destinationName)) {
    const last = transfers.at(-1)!;
    return resolveTravelDirection(last.toLine, last.transferName, destinationName)?.direction;
  }
  return undefined;
}
