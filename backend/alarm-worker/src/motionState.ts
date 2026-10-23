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
 * 알고리즘 (issue #1556 보강 섹션, #2763로 2단계 개정)
 * ================================
 * 1. device explicit motion(walking/automotive) → 'moving' 즉시
 * 2. device explicit 'stationary' → 'stationary', 단 arvlcd train-progress 있으면 'unknown'으로
 *    완화 (#2763 — CMMotionActivity가 승차 중에도 간헐적으로 'stationary'를 보내는 실측 패턴이
 *    있어, 서버 열차데이터가 device 모션보다 권위라는 확정 아키텍처(2026-09-03)를 이 분기에도
 *    적용. 원 판정 없음/사용자 의도 신뢰 정책은 arvlcd train-progress 부재 시 그대로 유지)
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
// #3007 — due-tick 마진으로 cron 명목 주기를 재사용한다(새 상수 금지).
import { CRON_INTERVAL_MS } from './cronConstants';
import { CRON_READ_CACHE_TTL_SEC } from './kvConsistency';
import type { PositionPoint, Trip } from './types';

/** GPS displacement 평가 윈도우 (ms). 5분. */
export const MOTION_WINDOW_MS = 5 * 60_000;

/** unknown→stationary 판정에 필요한 최소 GPS sample 수. */
export const MOTION_MIN_SAMPLES = 10;

/** stationary 판정 GPS displacement 상한 (meters). */
export const MOTION_STATIONARY_DISPLACEMENT_M = 10;

/** moving 판정 GPS displacement 하한 (meters). */
export const MOTION_MOVING_DISPLACEMENT_M = 50;

/**
 * SSOT write 최소 간격 (ms) — CF Free tier 1,000 writes/day quota 소진 방지.
 *
 * POST /position은 10s마다 호출되지만 evidence push + writeSsot는 이 간격으로 스로틀한다:
 * 최근 'device-position' evidence가 이 값보다 어리면(now 기준) push/write 둘 다 skip.
 * 5분 윈도우(MOTION_WINDOW_MS)에 25s 간격이면 ~12 sample — MOTION_MIN_SAMPLES(10) 대비
 * 20% 여유. token의 첫 evidence(cold start)는 항상 write.
 */
export const SSOT_MOTION_WRITE_MIN_INTERVAL_MS = 25_000;

/**
 * #3007 — "종료할까요?" 제안까지의 정지 지속 시간. device `PAUSE_AUTO_END_MS`
 * (`src/shared/constants/realtime.ts`)와 **같은 값의 backend 미러**다 — backend는 device 상수를
 * import할 수 없다. 새 임계가 아니므로 **한쪽을 바꾸면 반드시 다른 쪽도 바꿔야 한다.**
 */
export const END_PROMPT_STATIONARY_MS = 15 * 60_000;

/**
 * #3007 — `durationMs` 내내 "이동 없음"이었는가.
 *
 * **왜 기기 모션 플래그를 쓰지 않는가**: `signal.motion`(CMMotionActivity)은 승차 중에도
 * 간헐적으로 `'stationary'`를 보낸다 — #2763이 그 실측 패턴 때문에 이 신호의 권위를 이미
 * 낮췄다(`computeMotionState` 2번 분기). 그래서 **GPS 변위**로 판정하고, 임계·샘플 수는
 * 기존 상수(`MOTION_STATIONARY_DISPLACEMENT_M` / `MOTION_MIN_SAMPLES`)를 그대로 재사용한다.
 *
 * **fail-safe로 false를 반환하는 두 경우** — 잘못된 종료 제안보다 침묵이 낫다:
 *  1. 샘플이 `MOTION_MIN_SAMPLES` 미만 (판정 근거 부족)
 *  2. evidence가 윈도우를 **실제로 덮지 못함** — 가장 오래된 샘플이 `now - durationMs`보다
 *     최근이면 그 앞 구간을 모른다. ring cap(50) × push throttle(25s) ≈ 20.8분이 상한이므로
 *     15분 판정은 가능하지만 여유가 크지 않다. tolerance는 push throttle 1주기.
 *
 * 상태를 저장하지 않는다(KV write 0) — #3006 쿼터 문제를 쿼터로 고치지 않기 위한 제약.
 */
export function hasBeenStationaryFor(
  ssot: TripPositionSSoT,
  now: number,
  durationMs: number,
): boolean {
  const windowStart = now - durationMs;
  const slice = ssot.motionEvidence.filter(
    (e) => e.source === 'device-position' && e.ts >= windowStart && e.ts <= now,
  );
  if (slice.length < MOTION_MIN_SAMPLES) return false;
  const oldestTs = slice.reduce((min, e) => (e.ts < min ? e.ts : min), slice[0].ts);
  // 윈도우 커버리지 — 가장 오래된 샘플이 윈도우 시작 근방까지 닿아야 한다.
  if (oldestTs > windowStart + SSOT_MOTION_WRITE_MIN_INTERVAL_MS) return false;
  return maxDisplacementMeters(slice) < MOTION_STATIONARY_DISPLACEMENT_M;
}

/**
 * #3007 — "정지 15분을 **방금** 넘긴 tick"인가.
 *
 * 마커를 저장하지 않고 무상태로 1회성을 보장한다: 하한 `D`는 만족하는데 `D + cron 1 tick`은
 * 만족하지 않는 구간은 1분 cron 주기(`wrangler.toml` `[triggers] crons`, 매분)에서
 * **정확히 한 tick**만 존재한다.
 * 정지가 더 오래 이어지면 둘 다 true가 되어 false를 반환한다 — 중복 제안 금지.
 */
export function isEndPromptDue(ssot: TripPositionSSoT, now: number): boolean {
  if (!hasBeenStationaryFor(ssot, now, END_PROMPT_STATIONARY_MS)) return false;
  return !hasBeenStationaryFor(ssot, now, END_PROMPT_STATIONARY_MS + CRON_INTERVAL_MS);
}

/** motionEvidence 중 최신 'device-position' sample의 ts. 없으면 null. */
function newestDevicePositionEvidenceTs(
  evidence: readonly MotionEvidence[],
): number | null {
  let newest: number | null = null;
  for (const e of evidence) {
    if (e.source !== 'device-position') continue;
    if (newest === null || e.ts > newest) newest = e.ts;
  }
  return newest;
}

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
 * SSOT.motionEvidence 중 `source === 'seoul-arvlcd'`인 sample이 sinceMs 이후 1건 이상이면 true.
 *
 * 사용자가 정지 GPS 상태에서도 실제로는 탑승해 열차가 진행 중인 케이스를 보수적으로 'unknown'
 * 유지하기 위함.
 *
 * #2763 (2026-09-20 코드리뷰) — 원래는 distinct stationId 2개 이상을 요구했으나, 역간 정차가
 * 4~5분 걸리는 구간(9/15 어대~건대 실측)에서는 5분 창 안에 arvlCd 확정 도착이 1개 station만
 * 잡혀 이 조건이 상시 false였다(실효 무력). `source:'seoul-arvlcd'`의 유일 writer가
 * advanceTripPosition의 advance 확증(arvlCd 원본/realtimePosition으로 이미 검증된 강신호)이므로,
 * 1건만으로도 "열차가 실제 진행 중"이라는 충분한 증거다 — device GPS/가속도처럼 노이즈가 있는
 * 신호가 아니라 Seoul API 확정 도착 기반이라 2건 연속 요구가 과보수적이었다.
 */
export function hasArvlcdTrainProgress(
  ssot: TripPositionSSoT,
  sinceMs: number,
): boolean {
  for (const e of ssot.motionEvidence) {
    if (e.ts < sinceMs) continue;
    if (e.source !== 'seoul-arvlcd') continue;
    const sig = e.signal;
    if (!sig || typeof sig !== 'object') continue;
    const o = sig as Record<string, unknown>;
    if (typeof o.stationId === 'string' && o.stationId.length > 0) return true;
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
  const sinceMs = now - MOTION_WINDOW_MS;
  // 2. device explicit stationary — 원칙은 즉시 stationary(사용자 의도 신뢰), 단 arvlcd
  //    train-progress 확증이 있으면 'unknown'으로 완화한다 (#2763). CMMotionActivity가 승차
  //    중에도 간헐적으로 'stationary'를 보내는 실측 패턴이 있어, 이 분기를 무조건 신뢰하면
  //    서버 열차데이터(더 강한 ground truth, 확정 아키텍처 2026-09-03)가 있어도 무시된다.
  if (devicePosition.motion === 'stationary') {
    if (hasArvlcdTrainProgress(ssot, sinceMs)) return 'unknown';
    return 'stationary';
  }
  // 3. device 'unknown' → GPS displacement 윈도우 판정
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
 * 호출자(/position)는 trip이 존재할 때만 호출하며 **연장 이후** trip을 넘긴다(#3006 PR-1) —
 * SSOT TTL이 trip.expiresAt에 정렬된다.
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
  trip: Trip,
  options?: { onTransition?: (from: MotionState, to: MotionState) => void },
): Promise<TripPositionSSoT | null> {
  const ssot = await readSsot(kv, token, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
  if (!ssot) return null;

  // #KV quota — 최근 device-position evidence가 SSOT_MOTION_WRITE_MIN_INTERVAL_MS 미만
  // 전이면 evidence push + writeSsot 둘 다 skip (cold start는 항상 진행).
  // lastDeviceSyncAt은 write가 실제로 일어날 때만 갱신되지만, 그 write 자체가 최소
  // 이 간격으로는 돌기 때문에 DEVICE_SYNC_STALE_THRESHOLD_MS(5min) 안에서는 항상 신선하다.
  const lastEvidenceTs = newestDevicePositionEvidenceTs(ssot.motionEvidence);
  if (lastEvidenceTs !== null && now - lastEvidenceTs < SSOT_MOTION_WRITE_MIN_INTERVAL_MS) {
    return ssot;
  }

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

  // #3006 PR-1 — trip 수명에 정렬(연장 이후 trip). TTL 없이 쓰면 trip이 사라져도 키가 영구 잔존한다.
  await writeSsot(kv, ssot, { expiresAt: trip.expiresAt });
  return ssot;
}
