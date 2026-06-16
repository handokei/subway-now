/**
 * #1389 — FG fire site 공통 정합성 게이트 평가 helper.
 *
 * useStationAlarm의 4개 fire effect (phase ETA / API imminent / GPS station-passed /
 * FG arvlcd / subsurface) 가 fire 직전 호출. callsite는 결과(`allowed=false`)면 즉시 return.
 *
 * - `wifiStation` / `motionStationary` / `nearestStation` 은 hook props에서 추출 — 본 helper는
 *   새 신호 입력을 책임지지 않는다 (현 PR scope).
 * - `arcStations` 미전달이면 `computeDeviceHopsBehindTarget`가 null 반환 → 게이트 fallback 허용.
 *
 * fire site별로 `kind`/`phaseId` 메타데이터는 다르지만 정합성 평가 본문은 동일하므로 통합.
 * 차단 시 helper가 `logLocalFireConsistencyBlocked` 적재 — caller는 boolean 결과만 사용.
 */

import type { Station } from '../../../shared/types/station';
import { isSameStationName } from '../../../shared/utils/stationRoute';
import { evaluatePushConsistency } from './pushConsistency';
import {
  extractDeviceSignal,
  computeDeviceHopsBehindTarget,
} from './pushConsistencyContext';
import { logLocalFireConsistencyBlocked } from './alarmLog';

/**
 * #1389 — target stationName의 line을 추정.
 *
 * arcStations에서 같은 이름 stop을 찾아 그 line을 사용 (canonical name 정규화 비교).
 * 없으면 nearestStation.line을 사용 — 사용자가 그 라인을 타고 target에 접근 중이라는 가정.
 * 둘 다 없으면 빈 문자열 — 정합성 helper의 `stationLineEq`가 자연스럽게 mismatch 처리.
 */
export function resolveTargetLine(
  targetStationName: string,
  arcStations: readonly Station[] | undefined,
  nearestStation: Station | null,
): string {
  if (arcStations) {
    const match = arcStations.find((s) => isSameStationName(s.name, targetStationName));
    if (match) return match.line;
  }
  return nearestStation?.line ?? '';
}

export interface LocalFireConsistencyInput {
  targetStationName: string;
  targetLine: string;
  source: 'fg' | 'fg-arvlcd';
  kind?: 'destination' | 'transfer' | 'station-passed';
  phaseId?: 'early' | 'imminent';
  nearestStation: Station | null;
  motionStationary: boolean | undefined;
  wifiStation: Station | null;
  arcStations: readonly Station[] | undefined;
  now: number;
}

/**
 * FG fire 직전 정합성 게이트 평가.
 *
 * 반환:
 *  - { allowed: true }: caller가 fire 진행
 *  - { allowed: false }: caller가 즉시 return. helper가 log 적재 완료.
 */
export function evaluateLocalFireConsistency(
  input: LocalFireConsistencyInput,
): { allowed: true } | { allowed: false } {
  const target = { stationName: input.targetStationName, line: input.targetLine };
  const deviceSignal = extractDeviceSignal({
    currentStation: input.nearestStation,
    motionStationary: input.motionStationary,
    wifiStation: input.wifiStation,
    lastUpdateMs: input.now,
  });
  const tripCtx = {
    deviceHopsBehindTarget: computeDeviceHopsBehindTarget({
      arcStations: input.arcStations,
      currentStationName: deviceSignal.currentStationName,
      target,
    }),
  };
  const result = evaluatePushConsistency(deviceSignal, target, tripCtx, input.now);
  if (result.allowed) return { allowed: true };
  logLocalFireConsistencyBlocked({
    source: input.source,
    stationName: target.stationName,
    reason: result.reason,
    kind: input.kind,
    phaseId: input.phaseId,
  });
  return { allowed: false };
}
