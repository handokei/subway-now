import type { Route } from '../../../shared/utils/stationRoute';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import type { LineNumber } from '../../../shared/types/station';
import type { AlarmType, AlarmEvent } from '../../../shared/types/alarm';
import { ALARM_PHASES, type AlarmContext, type AlarmPhase, type AlarmPhaseId } from './alarmPhases';

// AlarmType/AlarmEvent는 shared/types/alarm으로 추출됨 (#890, Phase 5).
// 기존 호출자 호환을 위해 re-export 유지.
export type { AlarmType, AlarmEvent };

export function alarmKey(event: Pick<AlarmEvent, 'phaseId' | 'stationName'>): string {
  return `${event.phaseId}:${event.stationName}`;
}

export interface CurrentTarget {
  name: string;
  stops: number;
  alarmType: AlarmType;
  // 이 웨이포인트를 향해 사용자가 타고 가는 구간의 노선(approach line).
  // 환승 1회 경로의 destination은 toLine, 환승 0회(direct)는 route.line이다.
  // currentLine 게이트(#579)에서 이 값이 사용자가 실제로 탑승 중인 노선과 일치할 때만
  // phase가 평가된다 — 환승 전 도착역 stops가 작더라도 다른 노선에서 발사되지 않는다.
  approachLine: LineNumber;
}

/**
 * 경로의 모든 웨이포인트(환승역 + 도착역)를 경로 순서대로 반환한다.
 * transfers 배열을 순회하므로 N번 환승까지 확장 가능하다.
 */
export function resolveAllTargets(
  route: NonNullable<Route>,
  destinationName: string,
): CurrentTarget[] {
  if (route.type === 'direct') {
    return [{ name: destinationName, stops: route.stops, alarmType: 'destination', approachLine: route.line }];
  }

  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, destinationName)) {
      return [{ name: destinationName, stops: route.stopsToTransfer, alarmType: 'destination', approachLine: route.fromLine }];
    }
    return [
      { name: route.transferName, stops: route.stopsToTransfer, alarmType: 'transfer', approachLine: route.fromLine },
      { name: destinationName, stops: route.stopsFromTransfer, alarmType: 'destination', approachLine: route.toLine },
    ];
  }

  const targets: CurrentTarget[] = route.transfers.map((t) => {
    const isDestination = isSameStationName(t.transferName, destinationName);
    return {
      name: isDestination ? destinationName : t.transferName,
      stops: t.stopsToTransfer,
      alarmType: isDestination ? ('destination' as const) : ('transfer' as const),
      approachLine: t.fromLine,
    };
  });
  // MultiTransferRoute는 최소 2개 transfer로 구성되므로 targets는 항상 비어있지 않음.
  const lastTransfer = route.transfers[route.transfers.length - 1];
  const lastName = targets[targets.length - 1].name;
  const lastTransferIsDestination = isSameStationName(lastName, destinationName);
  if (!lastTransferIsDestination) {
    targets.push({
      name: destinationName,
      stops: route.stopsAfterLastTransfer,
      alarmType: 'destination',
      approachLine: lastTransfer.toLine,
    });
  }
  return targets;
}

export interface AlarmSource {
  route: Route;
  destinationName: string;
  etaSeconds: number | null;
  // 사용자가 실제로 탑승 중인 노선 (nearestStation.line). #579 회귀 방지:
  // approachLine이 일치하는 웨이포인트만 phase 평가 대상이 된다.
  // GPS 미확정 등으로 노선을 알 수 없을 때만 명시적으로 null을 전달 — 모든 leg 평가가 skip된다.
  currentLine: LineNumber | null;
  /**
   * #903 (Seam G) — fusion confidence가 'gps-only-underground'로 강등됐는가.
   * true면 transfer 알람과 early phase 알람을 차단한다(지하 GPS는 wifi/cell 삼각측량 fallback일
   * 가능성이 높아 정거장 단위 추정이 부정확). imminent phase는 destination 카테고리에 한해 통과 —
   * 거리 게이트(useStationAlarm.isAccuracyAcceptable)와 ETA 임계(10s)가 이중 가드.
   * 미전달/false면 기존 동작 유지(graceful — 기압계 미지원 환경 호환).
   */
  degradedConfidence?: boolean;
}

/**
 * 경로상 웨이포인트를 순회하며 phase 조건을 평가한다.
 *
 * - etaSeconds는 최종 목적지 웨이포인트에만 적용된다 (GPS 거리 산출이 도착역 기준이므로).
 *   환승역은 정거장 수 기반(early) 으로만 평가된다.
 * - currentLine(#579) approachLine이 일치하는 웨이포인트만 평가한다.
 *   환승 전인데 다음 leg의 stopsFromTransfer가 작아서 도착역 알람이 먼저 울리는 회귀(#579)와
 *   환승 전 도착역 알람이 먼저 울리는 회귀(#152)를 동시에 차단한다.
 * - currentLine이 null이거나 어느 leg와도 일치하지 않으면 알람을 발사하지 않는다 (silent skip).
 *   다음 GPS fix에서 leg가 일치하면 그때 발사된다.
 * - #580 옵셔널 out-param `suppressedOut`: phase 조건은 만족했으나 firedAlarms로 dedup된 이벤트를
 *   배열에 push. caller가 alarmLog에 'dedup-alarm' 엔트리를 적재해 dedup 동작을 관찰 가능하게 한다.
 *   미전달이면 dedup은 silent (이전 동작 유지).
 */
export function evaluateAlarmPhase(
  source: AlarmSource,
  firedAlarms: Set<string>,
  phases: AlarmPhase[] = ALARM_PHASES,
  suppressedOut?: AlarmEvent[],
): AlarmEvent | null {
  if (!source.route) return null;
  const { currentLine } = source;
  if (currentLine == null) return null;

  const targets = resolveAllTargets(source.route, source.destinationName);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target.approachLine !== currentLine) continue;

    const isFinal = i === targets.length - 1;
    const context: AlarmContext = {
      remainingStops: target.stops,
      etaSeconds: isFinal ? source.etaSeconds : null,
    };

    for (const phase of phases) {
      const key = `${phase.id}:${target.name}`;
      if (firedAlarms.has(key)) {
        // dedup hit. phase 조건도 만족했을 때만 suppressed로 적재 — "조건 미충족이지만 dedup된"
        // 케이스(예: imminent eta>10s)는 노이즈라 기록하지 않는다.
        if (suppressedOut && phase.evaluate(context)) {
          suppressedOut.push({ phaseId: phase.id, type: target.alarmType, stationName: target.name });
        }
        continue;
      }
      if (!phase.evaluate(context)) continue;
      // #903 (Seam G) — confidence 'gps-only-underground' 강등 시 early phase / transfer 카테고리 보류.
      // 지하 진입 진행 중엔 정거장 단위 추정이 부정확해 환승역 미리 알림이나 다음 hop 도달 알람이
      // 잘못 발사될 위험. imminent + destination만 통과 — useStationAlarm의 accuracy 200m 게이트와
      // ETA 10s 임계가 이중 가드. dedup으로는 적재하지 않음(silenced — 다음 tick에서 신호 복귀 시 재평가).
      if (source.degradedConfidence === true) {
        if (phase.id === 'early' || target.alarmType === 'transfer') continue;
      }
      return { phaseId: phase.id, type: target.alarmType, stationName: target.name };
    }
    // 매칭된 leg는 현재 사용자가 탑승 중인 구간 — 발사 조건 미달이면 다음 leg를 평가하지 않는다.
    // 다음 leg는 user가 그 leg의 approachLine으로 이동한 다음 tick에 평가된다.
    return null;
  }

  return null;
}
