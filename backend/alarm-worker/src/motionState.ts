/**
 * Motion state machine — ADR-017 Sub #1556 / T3.
 *
 * 배경
 * ====
 * 2026-06-19 회귀: 사용자가 11분 정지 상태였으나 SSOT.motionState가 갱신되지 않아 T2
 * advanceTripPosition 게이트 #2(`motionState=='stationary'` 차단)가 작동 못해 wrong advance
 * fire. T3는 POST /position 수신 시 SSOT.motionState를 정확히 판정/누적해 게이트 #2의 입력을
 * 제공한다.
 *
 * 알고리즘 (issue #1556 보강 섹션)
 * ================================
 * 1. device explicit motion(walking/automotive) → 'moving' 즉시
 * 2. device explicit 'stationary' → 'stationary' 즉시 (보수적 판정 안 함 — 사용자 의도 신뢰)
 * 3. device 'unknown' → backend가 GPS displacement 5분 윈도우로 판정
 *    - sample 10건 미만 → 'unknown' (샘플 부족)
 *    - displacement < 10m AND no arvlcd train-progress → 'stationary'
 *    - displacement < 10m AND arvlcd train-progress → 'unknown' (이동 가능성, 보수)
 *    - displacement > 50m → 'moving'
 *    - 그 사이 (10~50m) → 'unknown' (애매 구간 보수)
 *
 * [[lesson_motion_activity_intermittent_signal]] — iOS CMMotionActivity가 5~10분 주기로 뒤집힐 수
 * 있으나 본 T3는 backend single-update path이므로 매 /position 수신마다 device 신호를 그대로
 * 반영한다. 합의는 T2 게이트 #2가 motionState 1회 stationary로 판정 시 즉시 차단하지 않고
 * (T2 책임 — 여러 cron 사이클 연속 stationary 등) 1차 입력만 제공.
 *
 * 본 T3는 motion 판정 + SSOT 업데이트만. fire path 변경 X.
 */

import {
  pushMotionEvidence,
  readSsot,
  writeSsot,
  type MotionEvidence,
  type MotionState,
  type TripPositionSSoT,
} from './tripPositionSsot';
import { haversineKm } from './positionSeries';
import type { PositionPoint } from './types';

/** GPS displacement 평가 윈도우 (ms). 5분. */
export const MOTION_WINDOW_MS = 5 * 60_000;

/** unknown→stationary 판정에 필요한 최소 GPS sample 수. */
export const MOTION_MIN_SAMPLES = 10;

/** stationary 판정 GPS displacement 상한 (meters). */
export const MOTION_STATIONARY_DISPLACEMENT_M = 10;

/** moving 판정 GPS displacement 하한 (meters). */
export const MOTION_MOVING_DISPLACEMENT_M = 50;

/**
 * SSOT.motionEvidence 중 'device-position' source의 GPS sample 쌍 최대 displacement (m).
 *
 * signal payload는 `{ lat: number; lng: number; ... }` 형태로 stamp되어 들어온다고 가정 —
 * 형식 불일치 sample은 graceful skip.
 *
 * sample 0~1건이면 0 반환 (변위 측정 불가).
 */
export function maxDisplacementMeters(samples: readonly MotionEvidence[]): number {
  const coords: Array<{ lat: number; lng: number }> = [];
  for (const s of samples) {
    if (s.source !== 'device-position') continue;
    const sig = s.signal;
    if (!sig || typeof sig !== 'object') continue;
    const o = sig as Record<string, unknown>;
    if (typeof o.lat !== 'number' || typeof o.lng !== 'number') continue;
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
    coords.push({ lat: o.lat, lng: o.lng });
  }
  if (coords.length < 2) return 0;
  // 모든 쌍 거리의 max — 윈도우 내 가장 멀리 움직인 거리.
  let maxKm = 0;
  for (let i = 0; i < coords.length; i++) {
    for (let j = i + 1; j < coords.length; j++) {
      const d = haversineKm(coords[i].lat, coords[i].lng, coords[j].lat, coords[j].lng);
      if (d > maxKm) maxKm = d;
    }
  }
  return maxKm * 1000;
}

/**
 * 같은 line 내 다른 station을 진행 중인 arvlcd evidence가 sinceMs 이후 2건 이상이면 true.
 *
 * SSOT.motionEvidence 중 `source === 'seoul-arvlcd'`인 sample의 `signal.stationId`가
 * 2가지 이상이면 train progress로 판단. 사용자가 정지 GPS 상태에서도 실제로는 탑승해 다른 역을
 * 지나치는 케이스를 보수적으로 'unknown' 유지하기 위함.
 */
export function hasArvlcdTrainProgress(
  ssot: TripPositionSSoT,
  sinceMs: number,
): boolean {
  const stationIds = new Set<string>();
  for (const e of ssot.motionEvidence) {
    if (e.ts < sinceMs) continue;
    if (e.source !== 'seoul-arvlcd') continue;
    const sig = e.signal;
    if (!sig || typeof sig !== 'object') continue;
    const o = sig as Record<string, unknown>;
    if (typeof o.stationId !== 'string' || o.stationId.length === 0) continue;
    stationIds.add(o.stationId);
    if (stationIds.size >= 2) return true;
  }
  return false;
}

/**
 * 5단 판정 — 보강 섹션 알고리즘 그대로.
 *
 * 호출 시점: POST /position 수신 + SSOT 업데이트 직전.
 */
export function computeMotionState(
  ssot: TripPositionSSoT,
  devicePosition: PositionPoint,
  now: number,
): MotionState {
  // 1. device explicit moving 신호 (CMMotionActivity walking/automotive)
  if (devicePosition.motion === 'walking' || devicePosition.motion === 'automotive') {
    return 'moving';
  }
  // 2. device explicit stationary — 즉시 stationary (사용자 의도 신뢰)
  if (devicePosition.motion === 'stationary') {
    return 'stationary';
  }
  // 3. device 'unknown' → GPS displacement 윈도우 판정
  const sinceMs = now - MOTION_WINDOW_MS;
  const recentGps = ssot.motionEvidence.filter(
    (e) => e.ts >= sinceMs && e.source === 'device-position',
  );
  if (recentGps.length < MOTION_MIN_SAMPLES) return 'unknown';

  const displacement = maxDisplacementMeters(recentGps);
  if (displacement < MOTION_STATIONARY_DISPLACEMENT_M) {
    if (hasArvlcdTrainProgress(ssot, sinceMs)) return 'unknown';
    return 'stationary';
  }
  if (displacement > MOTION_MOVING_DISPLACEMENT_M) return 'moving';
  return 'unknown';
}

/**
 * Motion transition breadcrumb 출력 — PII 금지 (라벨만).
 *
 * Workers 환경에 Sentry SDK 직접 통합은 없으므로 `console.log`로 emit (`wrangler tail`로 수집).
 * S13 외부 breadcrumb 인프라가 도입되면 본 함수만 교체.
 *
 * `from === to`이면 no-op (transition 아님).
 */
export function emitMotionTransitionBreadcrumb(
  from: MotionState,
  to: MotionState,
): void {
  if (from === to) return;
  // PII 금지: 좌표/displacement 값은 절대 포함하지 않는다.
  console.log('[motion-transition]', JSON.stringify({ from, to }));
}

/**
 * POST /position handler가 호출하는 SSOT motion 업데이트 진입점.
 *
 * 1. SSOT read (없으면 no-op — trip 미등록 device의 /position은 series만 누적, T3 입력 없음)
 * 2. device-position evidence push (ring buffer, T1 helper)
 * 3. computeMotionState로 새 state 판정
 * 4. state 전환 시 breadcrumb emit + SSOT.motionState 갱신
 * 5. SSOT write back (last-write-wins — T2와 동일 race 정책)
 *
 * 호출자가 await로 보장해야 BG cron이 새 state를 읽는다. SSOT 부재 시 fast-return.
 */
export async function updateSsotMotion(
  kv: KVNamespace,
  token: string,
  position: PositionPoint,
  now: number,
  options?: { onTransition?: (from: MotionState, to: MotionState) => void },
): Promise<TripPositionSSoT | null> {
  const ssot = await readSsot(kv, token);
  if (!ssot) return null;

  // #2321 (O1-B) — device sync freshness anchor. POST /position 수신 = device가 살아있다는
  // 직접 증거이므로 매 호출마다 stamp. 게이트들이 motionState/lastAdvanceAt을 신뢰할지
  // 판단하는 입력(`isDeviceSyncStale`)이 된다.
  ssot.lastDeviceSyncAt = now;

  // device GPS sample을 evidence로 누적 (signal은 후속 maxDisplacementMeters가 lat/lng 추출).
  pushMotionEvidence(ssot, {
    source: 'device-position',
    ts: position.ts,
    signal: {
      lat: position.lat,
      lng: position.lng,
      motion: position.motion,
    },
  });

  const next = computeMotionState(ssot, position, now);
  if (next !== ssot.motionState) {
    emitMotionTransitionBreadcrumb(ssot.motionState, next);
    // P0-1 (#1577) — Site 5 of 6: motion-transition. caller가 analytics sink을 주입한다.
    options?.onTransition?.(ssot.motionState, next);
    ssot.motionState = next;
  }

  await writeSsot(kv, ssot);
  return ssot;
}
