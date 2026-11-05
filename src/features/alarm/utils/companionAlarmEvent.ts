/**
 * #3100 — companion(sleep-alarm-companion) 수신 시 오버레이·Live Activity 알람 레이어에 넘길 AlarmEvent 조립.
 *
 * 오버레이의 단일 소스는 칸마다 1회 도착하는 백엔드 companion이다. LA 출구 안내(좌/우 문)는 `stationId`+`direction`이
 * 있어야 나오므로, phase 이벤트와 같은 조회(`resolveAllTargets` / `resolveAlarmDirection`)로 채운다.
 * 조회에 실패하면 두 필드만 생략한다(출구 안내만 빠지고 오버레이·진동·소리는 정상).
 */
import type { AlarmEvent } from '../../../shared/types/alarm';
import type { Route } from '../../../shared/utils/stationRoute';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { resolveAllTargets } from './stationAlarm';
import { resolveAlarmDirection } from './alarmDirection';

export interface CompanionAlarmEventInput {
  route: Route;
  destinationName: string | null;
  nextStation: string;
  /** 타깃역에 진입하는 노선(payload.nextLine). 같은 역이 여러 번 나올 때 진입 노선 일치를 우선한다. */
  nextLine: string;
  targetKind: AlarmEvent['type'];
  /** 사용자가 직전에 있던 역(payload.originStation) — 같은 노선 내 상대 방향 계산용. */
  originStation: string;
  /** 칸(타깃까지 실제 남은 정거장 수). 기본 칸(1역 전)은 생략. */
  band?: number;
}

/**
 * 도착 노선(payload.nextLine)의 승강장 id — route 조회가 실패했을 때의 대체 출처. nextLine은 backend가
 * 타깃역에 진입한다고 알려 준 노선이라 이름 첫 매칭(#3177 결함)과 달리 노선을 구분한다.
 */
function lookupStationIdByLine(stationName: string, line: string): string | undefined {
  if (!isValidLineNumber(line)) return undefined;
  return findStationByNameAndLine(stationName, line)?.id;
}

/**
 * 오버레이용 AlarmEvent. `AlarmEvent.stationId`는 필수라 route 조회와 (역명, nextLine) 조회가 모두 실패하면
 * null — 호출자는 오버레이를 생략한다(payload 역이 stations.json에 없는 경우뿐).
 */
export function buildCompanionAlarmEvent({
  route,
  destinationName,
  nextStation,
  nextLine,
  targetKind,
  originStation,
  band,
}: CompanionAlarmEventInput): AlarmEvent | null {
  const base = {
    phaseId: 'early' as const,
    type: targetKind,
    stationName: nextStation,
    ...(band !== undefined && { band }),
  };
  const lineStationId = lookupStationIdByLine(nextStation, nextLine);
  if (!route || !destinationName) return lineStationId ? { ...base, stationId: lineStationId } : null;

  const candidates = resolveAllTargets(route, destinationName).filter(
    (target) => isSameStationName(target.name, nextStation) && target.alarmType === targetKind,
  );
  const target = candidates.find(({ approachLine }) => String(approachLine) === nextLine) ?? candidates[0];
  const stationId = target?.stationId ?? lineStationId;
  if (!stationId) return null;
  const event: AlarmEvent = { ...base, stationId };
  if (!target) return event;

  const direction = resolveAlarmDirection(event, { route, destinationName, sourceStationName: originStation });
  return { ...event, ...(direction && { direction }) };
}
