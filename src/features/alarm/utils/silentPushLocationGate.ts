import * as Location from 'expo-location';
import { haversine } from '../../../utils/haversine';
import { findStationByName } from '../../../utils/stationLookup';
import { createLogger } from '../../../utils/logger';
import { isValidGpsSpeedMps } from '../../../shared/constants/location';

const logger = createLogger('SilentPushLocationGate');

// 위치 캐시 신뢰 TTL — 초과 시 stale로 간주하고 보수적 skip.
// silent push imminent 알림은 도착 직전이라 60초 이상 stale 캐시로 발사하면
// 사용자가 이미 통과/이전 역에 있을 위험.
export const LOCATION_CACHE_TTL_MS = 60_000;

// 콜드 GPS fetch 타임아웃 — BG 깨움 시 OS가 즉답 못 하면 보수적 skip.
export const FRESH_FETCH_TIMEOUT_MS = 3_000;

/**
 * phase × kind별 발사 허용 거리(m).
 * - early: 한 정거장 전 알림 → 다음 역이라도 게이트 통과해야 하므로 넓게
 * - imminent: 도착 직전 → 좁게
 * - intermediate: 이미 그 역 근처 통과 시점 → 가장 좁게
 *
 * 초안 값. 운영 alarmLog 데이터로 후속 조정(#478 follow-up).
 */
const THRESHOLDS_M = {
  early: { transfer: 800, destination: 800, intermediate: 600 },
  imminent: { transfer: 400, destination: 400, intermediate: 300 },
} as const;

export type GateKind = 'transfer' | 'destination' | 'intermediate';
export type GatePhase = 'early' | 'imminent';

export type GateSkipReason = 'unknown-station' | 'no-location' | 'stale-location' | 'out-of-range';
export type GateLocationSource = 'cache' | 'fresh';

export interface GateResult {
  pass: boolean;
  reason?: GateSkipReason;
  distanceM?: number;
  thresholdM?: number;
  locationSource?: GateLocationSource;
  locationAgeMs?: number;
  // #727 — movementGate가 후속 정적 misfire 평가에 사용. expo-location 응답에 있을 때만 노출.
  speedMps?: number;
  accuracyM?: number;
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
 * silent push 수신 시 "사용자가 실제로 그 역 근처에 있는지" 확인하는 게이트.
 * pass=true면 알림 발사, false면 skip + alarmLog에 skipReason 기록.
 *
 * 정책:
 *   1) stationName이 stations.json에 없으면 skip (unknown-station)
 *   2) 위치 획득 실패 시 skip (no-location) — 보수적
 *   3) 캐시가 TTL 초과면 skip (stale-location) — 보수적
 *   4) phase/kind별 임계값 이내면 pass, 초과면 skip (out-of-range)
 */
export async function checkSilentPushLocationGate(input: {
  stationName: string;
  kind: GateKind;
  phase: GatePhase;
}): Promise<GateResult> {
  const station = findStationByName(input.stationName);
  if (!station) {
    return { pass: false, reason: 'unknown-station' };
  }

  const pos = await resolveUserPosition();
  if (!pos) {
    return { pass: false, reason: 'no-location' };
  }

  if (pos.ageMs > LOCATION_CACHE_TTL_MS) {
    return {
      pass: false,
      reason: 'stale-location',
      locationSource: pos.source,
      locationAgeMs: pos.ageMs,
    };
  }

  // haversine은 km 반환 → m로 변환 후 임계값(m)과 비교.
  const distanceM = Math.round(haversine(pos.lat, pos.lng, station.lat, station.lng) * 1000);
  const thresholdM = THRESHOLDS_M[input.phase][input.kind];
  const pass = distanceM <= thresholdM;

  return {
    pass,
    reason: pass ? undefined : 'out-of-range',
    distanceM,
    thresholdM,
    locationSource: pos.source,
    locationAgeMs: pos.ageMs,
    ...(pos.speedMps == null ? {} : { speedMps: pos.speedMps }),
    ...(pos.accuracyM == null ? {} : { accuracyM: pos.accuracyM }),
  };
}
