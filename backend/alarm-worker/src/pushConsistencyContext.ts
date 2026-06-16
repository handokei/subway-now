/**
 * #1389 — backend 발사 사이트가 `evaluatePushConsistency`에 넘기는 입력을 만들어 주는 어댑터 helper.
 *
 * 두 가지 책임만 가진다(SRP):
 *   1. `extractDeviceSignal(series, now)` — backend가 KV에 저장해 둔 `PositionPoint[]`에서
 *      가장 최근 sample을 골라 `DeviceSignal`(currentStationName / motion / lastUpdateMs)로 변환.
 *      WiFi는 #1286 device 업로드 전까지 backend에 신호가 없으므로 항상 `null`.
 *   2. `computeDeviceHopsBehindTarget(lock, target, currentStationName)` — boardingLock의
 *      `segmentStations`(현재 leg 정차 시퀀스)에서 device 현재역 ↔ target waypoint 사이의 hop 차이를 산출.
 *      - 0       : device가 target과 같음
 *      - 양수    : device가 target보다 N hop behind
 *      - 음수    : device가 target보다 N hop ahead
 *      - `null`  : 둘 중 하나라도 segment에서 찾지 못함 → helper가 fallback(허용)으로 처리
 *
 * fire site는 위 두 helper로 (DeviceSignal, TripContext)를 만들고 `evaluatePushConsistency`로 평가만 한다.
 * helper는 backend 전용 (frontend mirror는 device 자체 신호를 직접 가지므로 동일 추출 helper가 필요 없음).
 */

import type { PositionPoint, BoardingLockMeta } from './types';
import { evaluateWindow } from './positionSeries';
import type { DeviceSignal, PushTarget, TripContext } from './pushConsistency';

/**
 * positionSeries에서 가장 최근 sample 기준으로 DeviceSignal을 만든다.
 *
 *  - currentStationName : 가장 최근에 `currentStationName` 필드를 stamp한 sample의 값.
 *                          stamp가 한 번도 없으면 null. `scheduled.ts:pickLatestCurrentStationName`과
 *                          같은 의미(가장 최근부터 backward backfill).
 *  - motion             : 최근 6개 sample의 최빈값(positionSeries.evaluateWindow). 빈 시리즈는 'unknown'.
 *  - wifiStation        : 현재 backend에는 신호가 없어 항상 null (#1286 frontend 업로드 후 갱신).
 *  - lastUpdateMs       : 가장 마지막 sample의 `ts`. 시리즈가 비면 0 (= now와 비교 시 항상 stale → 게이트 허용).
 */
export function extractDeviceSignal(
  series: readonly PositionPoint[],
  now: number,
): DeviceSignal {
  // currentStationName — 가장 최근부터 backfill.
  let currentStationName: string | null = null;
  for (let i = series.length - 1; i >= 0; i--) {
    const name = series[i].currentStationName;
    if (typeof name === 'string' && name.length > 0) {
      currentStationName = name;
      break;
    }
  }

  // motion — 기존 positionSeries.evaluateWindow가 최근 6개 sample 최빈값 산출.
  // 빈 시리즈에서도 'unknown'으로 graceful — 게이트 분기 #4(모든 signal null)에 그대로 매핑.
  const metrics = evaluateWindow(series, now);

  // lastUpdateMs — 가장 마지막 sample의 ts. 빈 시리즈는 0 (게이트 #3 stale 분기 → 허용).
  const last = series[series.length - 1];
  const lastUpdateMs = last ? last.ts : 0;

  return {
    currentStationName,
    motion: metrics.motion,
    wifiStation: null,
    lastUpdateMs,
  };
}

/**
 * BoardingLock의 `segmentStations`(현재 leg 정차 시퀀스)에서 device 현재역 ↔ target 사이의
 * hop 차이를 산출. lock 부재 시 `null` 반환 — 호출자가 lock 없는 경로(lockless 등)에서는
 * 이 helper 대신 다른 산출 방법을 쓰거나 trip context를 null로 두고 fallback 허용해야 한다.
 *
 *  - 0 : device == target
 *  - >0 : device가 target보다 N hop behind
 *  - <0 : device가 target보다 N hop ahead
 *  - null : currentStationName이 null, 또는 segmentStations에서 둘 중 하나라도 못 찾음
 */
export function computeDeviceHopsBehindTarget(
  lock: Pick<BoardingLockMeta, 'segmentStations'> | undefined,
  target: PushTarget,
  currentStationName: string | null,
): number | null {
  if (!lock || currentStationName === null) return null;
  const segmentStations = lock.segmentStations;
  const deviceIdx = segmentStations.indexOf(currentStationName);
  const targetIdx = segmentStations.indexOf(target.stationName);
  if (deviceIdx < 0 || targetIdx < 0) return null;
  return targetIdx - deviceIdx;
}

/**
 * fire site 1줄 호출용 — series + lock + target에서 (DeviceSignal, TripContext)를 모두 만든다.
 * 일반 패턴:
 *
 * ```ts
 * const ctx = await buildPushConsistencyContext(env.TRIPS, trip.token, lock, target, now);
 * const result = evaluatePushConsistency(ctx.device, target, ctx.trip, now);
 * if (!result.allowed) { ... return; }
 * ```
 *
 * 사이트가 이미 series를 다른 용도(fusion 등)로 읽었으면 `extractDeviceSignal` + `computeDeviceHopsBehindTarget`을
 * 각자 직접 호출해 KV read를 절약할 수 있다 (lockless/boarding-prompt 경로).
 */
export interface PushConsistencyContext {
  device: DeviceSignal;
  trip: TripContext;
}

export function buildPushConsistencyContextFromSeries(
  series: readonly PositionPoint[],
  lock: Pick<BoardingLockMeta, 'segmentStations'> | undefined,
  target: PushTarget,
  now: number,
): PushConsistencyContext {
  const device = extractDeviceSignal(series, now);
  const hops = computeDeviceHopsBehindTarget(lock, target, device.currentStationName);
  return { device, trip: { deviceHopsBehindTarget: hops } };
}
