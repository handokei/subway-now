import * as Location from 'expo-location';
import { haversine } from '../../../shared/utils/haversine';
import { findStationByName } from '../../../shared/utils/stationLookup';
import { createLogger } from '../../../shared/utils/logger';
import { isValidGpsSpeedMps } from '../../../shared/constants/location';
import {
  THRESHOLDS_M,
  LOCKLESS_INTERMEDIATE_THRESHOLDS_M,
  LOCKLESS_HOP_WINDOW_TOLERANCE,
} from '../../../shared/constants/silentPushThresholds';

const logger = createLogger('SilentPushLocationGate');

// 위치 캐시 신뢰 TTL — 초과 시 stale로 간주하고 보수적 skip.
// silent push imminent 알림은 도착 직전이라 60초 이상 stale 캐시로 발사하면
// 사용자가 이미 통과/이전 역에 있을 위험.
export const LOCATION_CACHE_TTL_MS = 60_000;

// 콜드 GPS fetch 타임아웃 — BG 깨움 시 OS가 즉답 못 하면 보수적 skip.
export const FRESH_FETCH_TIMEOUT_MS = 3_000;

export type GateKind = 'transfer' | 'destination' | 'intermediate';
export type GatePhase = 'early' | 'imminent';

export type GateSkipReason =
  | 'unknown-station'
  | 'no-location'
  | 'stale-location'
  | 'out-of-range'
  | 'line-mismatch';
/**
 * pass=true일 때 어떤 경로로 통과했는지 식별. 운영 측정/디버깅용.
 * - 'within-threshold': 거리 임계값 이내 (기존 경로)
 * - 'hop-window-match': lockless + hop index 매치(거리 검증 우회, #1209 D3)
 * - 'subsurface-bypass': 지하 intermediate 푸시 — GPS stale/spoof 회피 위해 거리 검증 우회(#1307)
 */
export type GatePassReason = 'within-threshold' | 'hop-window-match' | 'subsurface-bypass';
export type GateLocationSource = 'cache' | 'fresh';

export interface GateResult {
  pass: boolean;
  reason?: GateSkipReason;
  passReason?: GatePassReason;
  distanceM?: number;
  thresholdM?: number;
  locationSource?: GateLocationSource;
  locationAgeMs?: number;
  // #727 — movementGate가 후속 정적 misfire 평가에 사용. expo-location 응답에 있을 때만 노출.
  speedMps?: number;
  accuracyM?: number;
}

export interface SilentPushLocationGateInput {
  stationName: string;
  kind: GateKind;
  phase: GatePhase;
  /**
   * lockless trip(BoardingLock 미활성) 경로 여부. #1209 D3.
   * true면 intermediate kind에 한해 widened 임계값과 hop window 매치 분기가 적용된다.
   */
  isLockless?: boolean;
  /**
   * D1(#1207) hop estimator가 추정한 현재 hop index. 미연결 시 undefined.
   */
  currentHopIndex?: number;
  /**
   * silent push payload가 명시한 hop index. 백엔드 schema에 추가되기 전까지 undefined.
   */
  payloadHopIndex?: number;
  /**
   * #1365 — backend silent push payload의 `occupiedLine`. 발사 시점 waypoint의 line.
   * 환승역(예: 건대입구는 2호선/7호선)에서 같은 hop index에 line이 다른 stop이 존재할 수 있어
   * 디바이스 현재 line(`estimatorLine`)과 cross-validation해 잘못된 line의 알람을 차단한다.
   * 구 backend(미전달)면 undefined → cross-check 자연 skip(graceful).
   */
  occupiedLine?: string;
  /**
   * #1365 — 디바이스 fusion result가 채택한 현재 line. lock 활성 시 lock.boardingLine,
   * lockless면 fusion result(또는 GPS nearest) line. occupiedLine과 양쪽 모두 정의된 경우에만
   * mismatch 시 `line-mismatch` skip. 미연결(둘 중 하나라도 undefined)이면 graceful pass.
   */
  estimatorLine?: string;
  /**
   * 지하(subsurface) 여부. #1307. 호출자가 server payload.subsurface를 우선,
   * 부재 시 디바이스 로컬 stamp(getSubsurfaceState)로 fallback해 해석한 boolean을 넘긴다.
   * true + intermediate kind면 GPS 거리 검증을 우회한다 — 지하에서 WiFi/cell 보정으로
   * stale/spoof된 GPS가 정상 intermediate push를 out-of-range로 오거부하는 회귀를 막는다.
   * transfer/destination은 misfire 방지를 위해 우회하지 않고 기존 GPS 게이트를 유지한다.
   */
  subsurface?: boolean;
}

interface UserPosition {
  lat: number;
  lng: number;
  ageMs: number;
  source: GateLocationSource;
  // #727 — expo-location LocationObject.coords의 speed/accuracy를 위로 전달.
  speedMps?: number;
  accuracyM?: number;
}

/**
 * Promise<T>에 timeout을 거는 헬퍼.
 * silent push 핸들러는 BG에서 짧은 시간만 살아있으므로 GPS 콜드 fetch가
 * 무한정 대기하면 안 된다.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-fetch-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 1순위: OS-level 마지막 알려진 위치 (즉답, 무비용)
 * 2순위: 콜드 GPS fetch (TIMEOUT 3s, 실패 시 null)
 */
function extractMotionFields(
  coords: Location.LocationObject['coords'],
): { speedMps?: number; accuracyM?: number } {
  const out: { speedMps?: number; accuracyM?: number } = {};
  // expo-location speed/accuracy는 측정 불가 시 -1 또는 null. 음수/null은 미적용으로 정리.
  if (isValidGpsSpeedMps(coords.speed)) out.speedMps = coords.speed;
  if (typeof coords.accuracy === 'number' && coords.accuracy >= 0) out.accuracyM = coords.accuracy;
  return out;
}

async function resolveUserPosition(): Promise<UserPosition | null> {
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: LOCATION_CACHE_TTL_MS });
    if (last) {
      const ageMs = Math.max(0, Date.now() - (last.timestamp ?? 0));
      return {
        lat: last.coords.latitude,
        lng: last.coords.longitude,
        ageMs,
        source: 'cache',
        ...extractMotionFields(last.coords),
      };
    }
  } catch (e) {
    logger.warn('getLastKnownPositionAsync 실패 — fresh fetch 시도:', e);
  }
  try {
    const fresh = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      FRESH_FETCH_TIMEOUT_MS,
    );
    return {
      lat: fresh.coords.latitude,
      lng: fresh.coords.longitude,
      ageMs: 0,
      source: 'fresh',
      ...extractMotionFields(fresh.coords),
    };
  } catch (e) {
    logger.warn('getCurrentPositionAsync 실패/타임아웃:', e);
    return null;
  }
}

/**
 * lockless intermediate 경로에서 적용할 임계값을 결정.
 * lock 활성 또는 lockless의 transfer/destination은 기존 좁은 임계값을 그대로 쓴다.
 */
function resolveThresholdM(
  isLockless: boolean,
  kind: GateKind,
  phase: GatePhase,
): number {
  if (isLockless && kind === 'intermediate') {
    return LOCKLESS_INTERMEDIATE_THRESHOLDS_M[phase];
  }
  return THRESHOLDS_M[phase][kind];
}

/**
 * D1 estimator가 제공한 현재 hop index가 payload hop과 ±TOLERANCE 이내인지.
 * 둘 중 하나라도 undefined면 매치 판정 불가 → false.
 */
function isHopWindowMatch(
  currentHopIndex: number | undefined,
  payloadHopIndex: number | undefined,
): boolean {
  if (currentHopIndex == null || payloadHopIndex == null) return false;
  return Math.abs(currentHopIndex - payloadHopIndex) <= LOCKLESS_HOP_WINDOW_TOLERANCE;
}

/**
 * #1307 — 지하 intermediate 푸시는 거리 검증을 우회한다.
 * 지하에서는 WiFi/cell 보정으로 GPS가 stale/spoof되어 거리 게이트가 정상 push를
 * out-of-range로 오거부한다. backend Seoul-API가 위치 SSOT인 intermediate(매역) push만
 * 우회 — transfer/destination은 misfire 방지를 위해 기존 GPS 게이트를 유지한다.
 */
function isSubsurfaceBypass(input: SilentPushLocationGateInput): boolean {
  return input.subsurface === true && input.kind === 'intermediate';
}

// 위치 미획득 fallback. 본 경로의 3-way 분기를 호출자에서 추출해 cognitive complexity 분산.
// 1) lockless intermediate + hop window 매치 → hop 기반 pass (#1273)
// 2) subsurface intermediate → server SSOT 신뢰 pass (#1307)
// 3) 그 외 → no-location skip
function resolveNoPositionFallback(input: SilentPushLocationGateInput): GateResult {
  if (
    input.isLockless === true &&
    input.kind === 'intermediate' &&
    isHopWindowMatch(input.currentHopIndex, input.payloadHopIndex)
  ) {
    return { pass: true, passReason: 'hop-window-match' };
  }
  if (isSubsurfaceBypass(input)) {
    return { pass: true, passReason: 'subsurface-bypass' };
  }
  return { pass: false, reason: 'no-location' };
}

/**
 * silent push 수신 시 "사용자가 실제로 그 역 근처에 있는지" 확인하는 게이트.
 * pass=true면 알림 발사, false면 skip + alarmLog에 skipReason 기록.
 *
 * 정책:
 *   1) stationName이 stations.json에 없으면 skip (unknown-station)
 *   2) 위치 획득 실패 시 skip (no-location) — 보수적
 *   2.5) subsurface(지하) + intermediate면 거리/stale 검증 우회 pass (#1307) —
 *        지하 GPS stale/spoof로 인한 out-of-range 오거부 차단. transfer/destination은 제외.
 *   3) 캐시가 TTL 초과면 skip (stale-location) — 보수적
 *   4) lockless + intermediate + hop index 매치면 거리 검증 우회 pass (#1209 D3)
 *   5) phase/kind별 임계값 이내면 pass, 초과면 skip (out-of-range)
 *      — lockless intermediate는 sticky station 좌표 drift 수용 위해 widened
 */
export async function checkSilentPushLocationGate(
  input: SilentPushLocationGateInput,
): Promise<GateResult> {
  const station = findStationByName(input.stationName);
  if (!station) {
    return { pass: false, reason: 'unknown-station' };
  }

  // #1365 — line cross-validation. backend `occupiedLine`과 device `estimatorLine`이 양쪽 모두
  // 정의되고 mismatch면 skip. 환승역(같은 hop index에 line 다른 stop 존재)에서 잘못된 line의
  // station-passed/destination/transfer 알람 발사 차단. 구 backend 호환 위해 둘 중 하나라도
  // undefined면 cross-check 자연 skip(graceful) — 기존 거리/hop 게이트만 동작.
  if (
    input.occupiedLine != null &&
    input.estimatorLine != null &&
    input.occupiedLine !== input.estimatorLine
  ) {
    return { pass: false, reason: 'line-mismatch' };
  }

  const pos = await resolveUserPosition();
  if (!pos) {
    return resolveNoPositionFallback(input);
  }

  const motionFields = {
    ...(pos.speedMps == null ? {} : { speedMps: pos.speedMps }),
    ...(pos.accuracyM == null ? {} : { accuracyM: pos.accuracyM }),
  };

  // #1307 — 지하 intermediate는 GPS가 stale/spoof되므로 stale/거리 검증을 우회하고 pass.
  // 후속 movement 가드(silentPushTask)가 speed/accuracy/motion으로 정적 misfire를 추가 차단한다.
  if (isSubsurfaceBypass(input)) {
    return {
      pass: true,
      passReason: 'subsurface-bypass',
      locationSource: pos.source,
      locationAgeMs: pos.ageMs,
      ...motionFields,
    };
  }

  if (pos.ageMs > LOCATION_CACHE_TTL_MS) {
    return {
      pass: false,
      reason: 'stale-location',
      locationSource: pos.source,
      locationAgeMs: pos.ageMs,
    };
  }

  const isLockless = input.isLockless === true;

  // #1209 D3 — lockless + intermediate + hop window 매치 시 거리 검증 우회.
  // D1 estimator의 hop이 payload hop과 ±1 이내라면 GPS 좌표가 drift해도 같은 leg로 간주.
  if (
    isLockless &&
    input.kind === 'intermediate' &&
    isHopWindowMatch(input.currentHopIndex, input.payloadHopIndex)
  ) {
    return {
      pass: true,
      passReason: 'hop-window-match',
      locationSource: pos.source,
      locationAgeMs: pos.ageMs,
      ...motionFields,
    };
  }

  // haversine은 km 반환 → m로 변환 후 임계값(m)과 비교.
  const distanceM = Math.round(haversine(pos.lat, pos.lng, station.lat, station.lng) * 1000);
  const thresholdM = resolveThresholdM(isLockless, input.kind, input.phase);
  const pass = distanceM <= thresholdM;

  return {
    pass,
    reason: pass ? undefined : 'out-of-range',
    passReason: pass ? 'within-threshold' : undefined,
    distanceM,
    thresholdM,
    locationSource: pos.source,
    locationAgeMs: pos.ageMs,
    ...motionFields,
  };
}
