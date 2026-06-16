/**
 * #1389 — 정합성 게이트 callsite 어댑터.
 *
 * `evaluatePushConsistency`(`pushConsistency.ts`)는 순수 함수라 callsite마다 다양한 입력
 * 형태(LocationObject / motion=boolean / Station | null / arcStations + currentStationName 등)를
 * 직접 알지 않는다. 본 모듈이 callsite의 다양한 입력을 helper의 `DeviceSignal` / `TripContext`
 * 로 정규화하는 단일 진입점이다.
 *
 * 사용 패턴:
 * ```ts
 * const deviceSignal = extractDeviceSignal({ ... });
 * const tripCtx: TripContext = {
 *   deviceHopsBehindTarget: computeDeviceHopsBehindTarget({ arcStations, ... }),
 * };
 * const consistency = evaluatePushConsistency(deviceSignal, target, tripCtx, now);
 * ```
 *
 * 4개 fire site(silentPushTask / boardingLockScheduler / tripBoundScheduler / useStationAlarm)가
 * 공통 호출 — 다른 callsite가 추가되어도 입력 어댑터 재구성 없이 본 함수만 호출하면 된다.
 */

import { isSameStationName } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import type { DeviceSignal, Motion, PushTarget } from './pushConsistency';

/**
 * 다양한 callsite의 원시 입력을 `DeviceSignal`로 정규화.
 *
 * - `currentStation`은 Station | string | null 어느 쪽도 수용. Station 객체면 `.name`을 사용.
 * - `motionStationary` boolean을 helper의 `Motion` enum으로 매핑:
 *     - `true` → `'stationary'`
 *     - `false` → `'unknown'` (motion 신호가 stationary가 아닌 것만 알지, walking/automotive 구분 불가)
 *     - `undefined` → `'unknown'` (모티브 미초기화 / 권한 X)
 * - `wifiStation`은 `{ stationName, line } | null` (이미 helper 입력과 동형).
 * - `lastUpdateMs` 미상이면 호출자가 `Date.now()`를 명시 — 본 helper가 임의 fallback하지 않는다
 *   (callsite가 stale 판정 컨텍스트를 정확히 알아야 한다).
 */
export interface ExtractDeviceSignalInput {
  currentStation: Station | string | null;
  motionStationary: boolean | undefined;
  wifiStation: Station | null;
  lastUpdateMs: number;
}

export function extractDeviceSignal(input: ExtractDeviceSignalInput): DeviceSignal {
  const currentStationName =
    input.currentStation === null
      ? null
      : typeof input.currentStation === 'string'
        ? input.currentStation
        : input.currentStation.name;

  const motion: Motion =
    input.motionStationary === true ? 'stationary' : 'unknown';

  const wifiStation = input.wifiStation
    ? { stationName: input.wifiStation.name, line: input.wifiStation.line }
    : null;

  return {
    currentStationName,
    motion,
    wifiStation,
    lastUpdateMs: input.lastUpdateMs,
  };
}

/**
 * device 현재 위치(currentStationName)와 target station 사이의 hop count를 산출.
 *
 * - `arcStations` 빈 배열 / 미전달 → null (게이트 fallback 허용 — `useStationAlarm` 이외 callsite에서
 *   route+destination만 알고 arcStations 산출이 비싼 경우).
 * - `currentStationName` 또는 `target.stationName`이 arcStations에 없음 → null (다른 라인 / 미확정 위치).
 * - 둘 다 매칭되면 `targetIdx - deviceIdx` 반환.
 *
 * 매칭은 `isSameStationName`(canonical name 정규화) 기반 — '서울대입구역(관악구청)' 같은 노선별 부제 차이 흡수.
 *
 * 결과 의미(`evaluatePushConsistency.deviceHopsBehindTarget`):
 *  - 0  : device == target
 *  - >0 : device가 target보다 N hop behind
 *  - <0 : device가 target보다 N hop ahead
 *  - null: 산출 불가 → 게이트 허용으로 fallback
 */
export interface ComputeDeviceHopsBehindTargetInput {
  arcStations: readonly Station[] | undefined | null;
  currentStationName: string | null;
  target: PushTarget;
}

export function computeDeviceHopsBehindTarget(
  input: ComputeDeviceHopsBehindTargetInput,
): number | null {
  const { arcStations, currentStationName, target } = input;
  if (!arcStations || arcStations.length === 0) return null;
  if (!currentStationName) return null;

  const deviceIdx = arcStations.findIndex((s) => isSameStationName(s.name, currentStationName));
  if (deviceIdx === -1) return null;

  const targetIdx = arcStations.findIndex((s) => isSameStationName(s.name, target.stationName));
  if (targetIdx === -1) return null;

  return targetIdx - deviceIdx;
}
