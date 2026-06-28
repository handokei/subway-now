/**
 * #1936 (Epic #1927 G4) — fusion cascade tier picker pure function.
 *
 * `useFusedNearestStation.ts` cascade(원래 if/else 11분기)를 단일 pure function으로 추출한다.
 * `environment` 변수를 1순위 분기축으로 받아 underground/surface별 tier 활성·gate 조정을
 * 데이터 주도(`TIER_DEFINITIONS` 테이블)로 적용한다.
 *
 * 추출 목적 (ADR-014 첫 줄: false positive / miss 동급):
 *   - 기존 cascade는 11-tier if/else를 hook 본체에 inline — 환경 분기 단위 단위 테스트 불가.
 *   - `environment` 분기는 caller pre-computed gate(`positionTrainBoardingLockMatch`,
 *     `gpsDerivedFastPath`)에 이미 surface/underground 조건이 인라인 — picker가 환경 변수를
 *     **직접 read**하지 않아 SSOT 우회 회귀 (paradigm Phase 6 정신 위반).
 *   - 추출 후: caller가 environment + 11 signal pre-compute → picker가 데이터 주도로 tier 결정.
 *
 * 환경 분기 cascade reorder (G4 acceptance):
 *   - underground: tier 7 fused는 stricter delta(0.05km) 사용, tier 10 gps-fallback은
 *     stricter stale(≤15s) 사용. 두 strict 변형은 caller가 두 가지 사전 계산해서 전달.
 *   - surface: 기존 정신 보존 — tier 1/2는 caller pre-computed gate가 이미 환경 검증.
 *   - mixed/unknown: 기존 cascade 정신 보존(현 동작 정확 backward-compat).
 *
 * `TIER_DEFINITIONS` 테이블은 11-tier × 4 environment cell을 데이터로 표현 — 신규 tier 추가 시
 * 표 한 줄만 추가하면 cascade 변형 0건으로 확장 가능. 분기 분포 측정/DebugModal 표시도
 * `FusionTierName` literal 단일 source로 통일.
 *
 * #1934 (Epic #1927 G3) option B 통합 — candidate enumeration 단계 env vote reject counter는
 * caller(`useFusedNearestStation`) 책임. 본 picker는 cascade 단계만 담당.
 */

import type { LineNumber, NearestStationResult, Station } from '../../../shared/types/station';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';
import type { FusedStationResult } from './pickFusedStation';
import type { Environment } from './inferEnvironment';

/**
 * cascade tier 이름. 채택 trace + Sentry breadcrumb + DebugModal에서 단일 식별자.
 * underground/surface 분포 측정을 위해 environment 변수와 함께 노출.
 */
export type FusionTierName =
  | 'position-train-lock' // tier 1: lock + lockMatch + underground env + drift OK
  | 'gps-fast-path' // tier 2: lock + surface env + GPS 신선 + 노선 정합
  | 'arvl-arrived-match' // tier 3: lock + ARRIVED + trainCode + drift OK
  | 'backend-ssot' // tier 4: backend SSoT mirror
  | 'wifi' // tier 5: WiFi SSID 매칭
  | 'position-train' // tier 6: trainProgress + distance + arc 게이트
  | 'fused' // tier 7: pickFusedStation + 거리 게이트
  | 'detection-verdict' // tier 8: multi-signal verdict 합의
  | 'route' // tier 9: route progress + 거리 게이트
  | 'gps-fallback'; // tier 10: GPS-only fallback

/**
 * picker 입력 — caller(`useFusedNearestStation`)가 모든 tier별 사전 계산 결과를 묶어 전달.
 *
 * 각 필드는 cascade 한 단의 채택 가능 여부 + 채택 시 산출 station을 표현. picker는 environment에
 * 따른 tier 활성/gate 분기만 담당 — 게이트 자체 결정 로직은 caller에 위임.
 */
export interface FusionSignals {
  // ─── Tier 1: position-train-lock ───
  /**
   * lock + lockMatch + cascadeEnvironment==='underground' 3-of-3 합의 게이트 통과 여부.
   * true일 때 tier 1 채택 — 산출 station은 `positionTrainResult`.
   */
  positionTrainBoardingLockMatch: boolean;
  /** lock GPS drift > LOCK_GPS_DRIFT_THRESHOLD_M(1km) — true 시 tier 1 비활성. */
  positionTrainDriftBlocked: boolean;

  // ─── Tier 2: gps-fast-path ───
  /** lock + cascadeEnvironment==='surface' + GPS 신선 + 노선 정합 4-of-4 합의. */
  gpsDerivedFastPath: boolean;
  /** GPS 좌표 기준 거리순 1순위 candidate (tier 2 산출 station). */
  gpsTopCandidate: NearestStationResult | null;

  // ─── Tier 3: arvl-arrived-match ───
  /** lock + ARRIVED + trainCode 매칭 + 신선 3-of-3 합의 통과 시 채택 station. */
  arvlCdArrivedMatch: NearestStationResult | null;
  /** lock GPS drift > 1km — true 시 tier 3 비활성. */
  arvlCdDriftBlocked: boolean;

  // ─── Tier 4: backend-ssot ───
  /** backend SSoT mirror가 fresh + silent push healthy 합의. */
  backendSsotAccepts: boolean;
  /** backend SSoT mirror가 가리키는 station. backendSsotAccepts=true일 때만 non-null. */
  ssotStation: Station | null;

  // ─── Tier 5: wifi ───
  /** WiFi SSID 매칭 station + 거리 게이트 통과 결과. */
  wifiStationResolved: NearestStationResult | null;

  // ─── Tier 6: position-train ───
  /** trainProgress + TTL + distance + arc + #1926 F-fix consensus 통과 station. */
  positionTrainResult: NearestStationResult | null;
  /** position-train의 trainNo (lock과 매칭 시 'boarding-lock' 승격용). null/undefined = train 미관측. */
  trainProgressTrainNo: string | null | undefined;

  // ─── Tier 7: fused ───
  /** pickFusedStation 결과 + confidence/source. */
  fused: FusedStationResult | null;
  /** 일반 fusion 거리 게이트 (maxDelta=MAX_FUSION_DELTA_KM=0.2km) 통과 여부. */
  fusedPasses: boolean;
  /**
   * underground 분기에서 사용하는 stricter 거리 게이트 (maxDelta=0.05km).
   * #1936 G4 — underground에서 GPS 좌표 의존도 강등.
   */
  fusedPassesStrict: boolean;

  // ─── Tier 8: detection-verdict ───
  /** multi-signal verdict 합의 통과 — fused.confidence='detection-fused'로 승격. */
  detectionVerdictAccepts: boolean;

  // ─── Tier 9: route ───
  /** route progress 추정 station. */
  routeResult: NearestStationResult | null;
  /** route 거리 게이트 + 신선도 게이트 통과 여부. */
  routePasses: boolean;

  // ─── Tier 10: gps-fallback ───
  /**
   * 일반 GPS fallback (stale 게이트 GPS_FALLBACK_STALE_MAX_AGE_MS=300_000ms=5min).
   * stale 시 caller가 null로 전달.
   */
  gpsFallbackResult: NearestStationResult | null;
  /**
   * underground 분기에서 사용하는 strict GPS fallback (stale 게이트 15_000ms=15s).
   * #1936 G4 — underground에서 stale GPS 좌표를 더 빠르게 폐기.
   * stale 시 caller가 null로 전달.
   */
  gpsFallbackResultStrict: NearestStationResult | null;

  // ─── lockMatch 승격(tier 6) 컨텍스트 ───
  /** boardingLock 활성 여부 (lockMatch 가드 prereq). */
  hasBoardingLock: boolean;
  /** lock.trainCode (lockMatch 비교 키). null/undefined = lock 미활성 또는 trainCode 누락. */
  lockedTrainCode: string | null | undefined;
}

/** picker 결과 — tier 채택 trace + station/confidence/source. */
export interface FusionTierResult {
  tier: FusionTierName;
  result: NearestStationResult | null;
  confidence: FusionConfidence;
  source: FusionSource;
}

/**
 * tier 결정 entry. picker는 본 테이블을 environment + signals로 평가해 첫 통과 tier를 채택.
 *
 * 데이터 주도 구조: 신규 tier 추가 시 본 배열에 한 entry 추가만으로 cascade 확장 가능.
 * `selectFused` / `selectGpsFallback`는 environment 기반 strict 변형 채택을 위한 indirection.
 */
interface TierDefinition {
  name: FusionTierName;
  /** 본 tier 채택 가능 여부 + 채택 station 산출. null이면 다음 tier로. */
  evaluate: (env: Environment, s: FusionSignals) => FusionTierResult | null;
}

const TIER_DEFINITIONS: readonly TierDefinition[] = [
  // Tier 1: position-train-lock — 게이트 통과 시 positionTrainResult 사용 (caller가 게이트와
  // positionTrainResult 동치 보장: 게이트 true → positionTrainResult != null).
  {
    name: 'position-train-lock',
    evaluate: (_env, s) =>
      s.positionTrainBoardingLockMatch &&
      !s.positionTrainDriftBlocked &&
      s.positionTrainResult
        ? {
            tier: 'position-train-lock',
            result: s.positionTrainResult,
            confidence: 'boarding-lock',
            source: 'boarding-lock',
          }
        : null,
  },
  // Tier 2: gps-fast-path
  {
    name: 'gps-fast-path',
    evaluate: (_env, s) =>
      s.gpsDerivedFastPath && s.gpsTopCandidate
        ? {
            tier: 'gps-fast-path',
            result: s.gpsTopCandidate,
            confidence: 'gps-only',
            source: 'gps',
          }
        : null,
  },
  // Tier 3: arvl-arrived-match
  {
    name: 'arvl-arrived-match',
    evaluate: (_env, s) =>
      s.arvlCdArrivedMatch && !s.arvlCdDriftBlocked
        ? {
            tier: 'arvl-arrived-match',
            result: s.arvlCdArrivedMatch,
            confidence: 'boarding-lock',
            source: 'boarding-lock',
          }
        : null,
  },
  // Tier 4: backend-ssot
  {
    name: 'backend-ssot',
    evaluate: (_env, s) =>
      s.backendSsotAccepts && s.ssotStation
        ? {
            tier: 'backend-ssot',
            result: { station: s.ssotStation, distanceKm: 0 },
            confidence: 'backend-ssot',
            source: 'backend-ssot',
          }
        : null,
  },
  // Tier 5: wifi
  {
    name: 'wifi',
    evaluate: (_env, s) =>
      s.wifiStationResolved
        ? {
            tier: 'wifi',
            result: s.wifiStationResolved,
            confidence: 'wifi-ssid',
            source: 'wifi-ssid',
          }
        : null,
  },
  // Tier 6: position-train (lockMatch 승격 처리)
  {
    name: 'position-train',
    evaluate: (_env, s) => {
      if (!s.positionTrainResult) return null;
      // lockMatch 시 confidence/source 'boarding-lock' 승격 (#584 PR D2, #1891 RC-1).
      const lockMatch =
        s.hasBoardingLock &&
        s.lockedTrainCode != null &&
        s.trainProgressTrainNo === s.lockedTrainCode;
      return {
        tier: 'position-train',
        result: s.positionTrainResult,
        confidence: lockMatch ? 'boarding-lock' : 'position-train',
        source: lockMatch ? 'boarding-lock' : 'position-train',
      };
    },
  },
  // Tier 7: fused — underground는 fusedPassesStrict, 그 외는 fusedPasses
  {
    name: 'fused',
    evaluate: (env, s) => {
      if (!s.fused) return null;
      const passes = env === 'underground' ? s.fusedPassesStrict : s.fusedPasses;
      if (!passes) return null;
      return {
        tier: 'fused',
        result: s.fused.result,
        confidence: s.fused.confidence,
        source: s.fused.source,
      };
    },
  },
  // Tier 8: detection-verdict
  {
    name: 'detection-verdict',
    evaluate: (_env, s) => {
      if (!s.detectionVerdictAccepts || !s.fused) return null;
      return {
        tier: 'detection-verdict',
        result: s.fused.result,
        confidence: 'detection-fused',
        source: s.fused.source,
      };
    },
  },
  // Tier 9: route
  {
    name: 'route',
    evaluate: (_env, s) =>
      s.routeResult && s.routePasses
        ? {
            tier: 'route',
            result: s.routeResult,
            confidence: 'route-progress',
            source: 'route-progress',
          }
        : null,
  },
  // Tier 10: gps-fallback — underground는 stricter stale (15s), 그 외는 일반 (5min)
  {
    name: 'gps-fallback',
    evaluate: (env, s) => {
      const fallback =
        env === 'underground' ? s.gpsFallbackResultStrict : s.gpsFallbackResult;
      return {
        tier: 'gps-fallback',
        result: fallback,
        confidence: 'gps-only',
        source: 'gps',
      };
    },
  },
] as const;

/**
 * cascade tier picker — environment + 사전 계산된 신호로 채택 tier 결정.
 *
 * 순서 규칙:
 *   1. `TIER_DEFINITIONS` 순서대로 평가. 첫 non-null 반환 entry가 채택.
 *   2. underground 분기는 tier 7/10 strict 변형 사용 (`fusedPassesStrict`, `gpsFallbackResultStrict`).
 *   3. tier 1/2/3는 caller pre-computed gate가 이미 환경 확인 (positionTrainBoardingLockMatch가
 *      `cascadeEnvironment==='underground'` 검증, gpsDerivedFastPath가 `cascadeEnvironment==='surface'`
 *      검증) — picker 표는 환경 분기 별도 X.
 *
 * 마지막 tier(`gps-fallback`)는 항상 평가되며 `result`가 null이어도 tier만 채택 (caller가 fallback
 * 처리). `pickFusionTier`는 절대 null 반환하지 않는다 (gps-fallback이 sink).
 *
 * @param environment cascadeEnvironment SSOT (`inferEnvironment` 결과)
 * @param signals caller pre-computed tier별 신호 묶음
 */
export function pickFusionTier(
  environment: Environment,
  signals: FusionSignals,
): FusionTierResult {
  for (const def of TIER_DEFINITIONS) {
    const picked = def.evaluate(environment, signals);
    if (picked != null) return picked;
  }
  // TypeScript exhaustiveness — TIER_DEFINITIONS의 마지막 entry(gps-fallback)는 항상 결과를 반환.
  // 도달 불가 경로 (방어적 fallback).
  /* istanbul ignore next */
  return {
    tier: 'gps-fallback',
    result: null,
    confidence: 'gps-only',
    source: 'gps',
  };
}

/**
 * 후보 station이 environment SSOT와 일치하는지 검사 (#1934 G3 option B 통합).
 *
 * `environment === 'surface'` → station.environment !== 'underground' 통과 (mixed/unknown 허용).
 * `environment === 'underground'` → station.environment !== 'surface' 통과 (mixed/unknown 허용).
 * `environment === 'unknown'` → 항상 통과 (분간 불가).
 *
 * filter는 적용하지 않고 reject counter만 누적 (#1950이 consensus 게이트로 처리). DebugModal
 * `reject:candidate-env` 분포로 cascade 회귀 진단 가시화.
 *
 * 환경 매핑:
 *   - station.environment === undefined → mixed 취급 (#1930 schema audit 후 모두 채워질 예정).
 *
 * @returns 환경 불일치(reject)면 true, 일치/판정 불가면 false.
 */
export function isCandidateEnvMismatch(
  environment: Environment,
  candidate: NearestStationResult,
): boolean {
  if (environment === 'unknown') return false;
  // stations.json BLDN_NM/environment 누락 시 undefined — 보수적으로 mismatch 아님 처리.
  const stationEnv = candidate.station.environment;
  if (stationEnv == null || stationEnv === 'mixed' || stationEnv === 'unknown') return false;
  // environment === 'surface'이고 stationEnv === 'underground' → mismatch.
  // environment === 'underground'이고 stationEnv === 'surface' → mismatch.
  return stationEnv !== environment;
}

/**
 * `LineNumber` re-export — caller(useFusedNearestStation)에서 동일 type을 picker와 함께 import할 때
 * 단일 모듈로 묶기 위함. (사용은 옵셔널 — 직접 src/shared/types/station에서 가져와도 OK.)
 */
export type { LineNumber };
