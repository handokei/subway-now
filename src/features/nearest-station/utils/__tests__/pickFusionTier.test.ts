/**
 * #1936 (Epic #1927 G4) — pickFusionTier 단위 테스트.
 *
 * Acceptance:
 *   - 11-tier × 4 environment(surface/underground/mixed/unknown) = 44 cell matrix
 *   - environment='underground' 분기: tier 7 fused는 fusedPassesStrict 사용, tier 10은
 *     gpsFallbackResultStrict 사용.
 *   - 본 trip evidence(15:49:35) tier 6 진입 차단 시뮬 — tier 6 → tier 7 → tier 10 흐름.
 *   - isCandidateEnvMismatch helper — env vote reject counter (#1934 G3 option B 통합).
 */

import {
  isCandidateEnvMismatch,
  pickFusionTier,
  type FusionSignals,
} from '../pickFusionTier';
import type { NearestStationResult, Station, StationEnvironment } from '../../../../shared/types/station';
import type { FusedStationResult } from '../pickFusedStation';
import type { Environment } from '../inferEnvironment';

function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: '2-220',
    name: '강남',
    line: '2',
    lineColor: '#00A84D',
    lat: 37.498,
    lng: 127.027,
    ...overrides,
  };
}

function makeResult(stationOverrides: Partial<Station> = {}, distanceKm = 0.05): NearestStationResult {
  return { station: makeStation(stationOverrides), distanceKm };
}

function makeFused(
  stationOverrides: Partial<Station> = {},
  distanceKm = 0.05,
): FusedStationResult {
  return {
    result: makeResult(stationOverrides, distanceKm),
    confidence: 'arrival-confirmed',
    source: 'arrival',
    // #2204 — temporal consensus 추적 필드. 이 테스트는 tier 선택 로직만 검증하므로 무관(null).
    highPriorityStationId: null,
  };
}

/**
 * 기본 signals — 모든 tier 게이트 false. 각 테스트가 필요한 tier만 활성.
 */
function makeSignals(overrides: Partial<FusionSignals> = {}): FusionSignals {
  return {
    positionTrainBoardingLockMatch: false,
    positionTrainDriftBlocked: false,
    gpsDerivedFastPath: false,
    gpsTopCandidate: null,
    arvlCdArrivedMatch: null,
    arvlCdDriftBlocked: false,
    backendSsotAccepts: false,
    ssotStation: null,
    wifiStationResolved: null,
    positionTrainResult: null,
    trainProgressTrainNo: null,
    fused: null,
    fusedPasses: false,
    fusedPassesStrict: false,
    detectionVerdictAccepts: false,
    routeResult: null,
    routePasses: false,
    gpsFallbackResult: null,
    gpsFallbackResultStrict: null,
    hasBoardingLock: false,
    lockedTrainCode: null,
    ...overrides,
  };
}

describe('pickFusionTier — cascade tier 결정', () => {
  describe('Tier 1: position-train-lock', () => {
    it('positionTrainBoardingLockMatch + !drift + positionTrainResult → tier 1 채택', () => {
      const ptResult = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainBoardingLockMatch: true,
          positionTrainDriftBlocked: false,
          positionTrainResult: ptResult,
        }),
      );
      expect(r.tier).toBe('position-train-lock');
      expect(r.result).toBe(ptResult);
      expect(r.confidence).toBe('boarding-lock');
      expect(r.source).toBe('boarding-lock');
    });

    it('positionTrainDriftBlocked=true → tier 1 미진입 (fallback)', () => {
      const ptResult = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainBoardingLockMatch: true,
          positionTrainDriftBlocked: true,
          positionTrainResult: ptResult,
        }),
      );
      expect(r.tier).not.toBe('position-train-lock');
    });

    it('positionTrainResult=null → tier 1 미진입 (caller 게이트 동치성 위반 방어)', () => {
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainBoardingLockMatch: true,
          positionTrainResult: null,
        }),
      );
      expect(r.tier).not.toBe('position-train-lock');
    });
  });

  describe('Tier 2: gps-fast-path', () => {
    it('gpsDerivedFastPath + gpsTopCandidate → tier 2 채택', () => {
      const top = makeResult();
      const r = pickFusionTier(
        'surface',
        makeSignals({ gpsDerivedFastPath: true, gpsTopCandidate: top }),
      );
      expect(r.tier).toBe('gps-fast-path');
      expect(r.result).toBe(top);
      expect(r.confidence).toBe('gps-only');
      expect(r.source).toBe('gps');
    });

    it('gpsDerivedFastPath=true + gpsTopCandidate=null → tier 2 미진입', () => {
      const r = pickFusionTier(
        'surface',
        makeSignals({ gpsDerivedFastPath: true, gpsTopCandidate: null }),
      );
      expect(r.tier).not.toBe('gps-fast-path');
    });
  });

  describe('Tier 3: arvl-arrived-match', () => {
    it('arvlCdArrivedMatch + !drift → tier 3 채택', () => {
      const arvl = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ arvlCdArrivedMatch: arvl, arvlCdDriftBlocked: false }),
      );
      expect(r.tier).toBe('arvl-arrived-match');
      expect(r.result).toBe(arvl);
      expect(r.confidence).toBe('boarding-lock');
      expect(r.source).toBe('boarding-lock');
    });

    it('arvlCdDriftBlocked=true → tier 3 미진입', () => {
      const arvl = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ arvlCdArrivedMatch: arvl, arvlCdDriftBlocked: true }),
      );
      expect(r.tier).not.toBe('arvl-arrived-match');
    });
  });

  describe('Tier 4: backend-ssot', () => {
    it('backendSsotAccepts + ssotStation → tier 4 채택', () => {
      const ssot = makeStation();
      const r = pickFusionTier(
        'underground',
        makeSignals({ backendSsotAccepts: true, ssotStation: ssot }),
      );
      expect(r.tier).toBe('backend-ssot');
      expect(r.result?.station).toBe(ssot);
      expect(r.result?.distanceKm).toBe(0);
      expect(r.confidence).toBe('backend-ssot');
      expect(r.source).toBe('backend-ssot');
    });

    it('backendSsotAccepts=true + ssotStation=null → tier 4 미진입 (caller 게이트 동치성 방어)', () => {
      const r = pickFusionTier(
        'underground',
        makeSignals({ backendSsotAccepts: true, ssotStation: null }),
      );
      expect(r.tier).not.toBe('backend-ssot');
    });
  });

  describe('Tier 5: wifi', () => {
    it('wifiStationResolved → tier 5 채택', () => {
      const wifi = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ wifiStationResolved: wifi }),
      );
      expect(r.tier).toBe('wifi');
      expect(r.result).toBe(wifi);
      expect(r.confidence).toBe('wifi-ssid');
      expect(r.source).toBe('wifi-ssid');
    });
  });

  describe('Tier 6: position-train', () => {
    it('positionTrainResult + lockMatch → tier 6 채택, source/confidence boarding-lock 승격', () => {
      const pt = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainResult: pt,
          hasBoardingLock: true,
          lockedTrainCode: 'T1234',
          trainProgressTrainNo: 'T1234',
        }),
      );
      expect(r.tier).toBe('position-train');
      expect(r.result).toBe(pt);
      expect(r.confidence).toBe('boarding-lock');
      expect(r.source).toBe('boarding-lock');
    });

    it('positionTrainResult + lockless(hasBoardingLock=false) → tier 6 채택, position-train 유지', () => {
      const pt = makeResult();
      const r = pickFusionTier(
        'surface',
        makeSignals({
          positionTrainResult: pt,
          hasBoardingLock: false,
          lockedTrainCode: null,
          trainProgressTrainNo: 'T9999',
        }),
      );
      expect(r.tier).toBe('position-train');
      expect(r.confidence).toBe('position-train');
      expect(r.source).toBe('position-train');
    });

    it('positionTrainResult + lock 활성 + trainCode 불일치 → position-train 유지 (#1891 RC-1)', () => {
      const pt = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainResult: pt,
          hasBoardingLock: true,
          lockedTrainCode: 'T1234',
          trainProgressTrainNo: 'T5555',
        }),
      );
      expect(r.tier).toBe('position-train');
      expect(r.confidence).toBe('position-train');
    });
  });

  describe('Tier 7: fused — environment 분기 (underground 시 strict)', () => {
    it('environment=surface + fusedPasses=true → tier 7 채택', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'surface',
        makeSignals({ fused, fusedPasses: true, fusedPassesStrict: false }),
      );
      expect(r.tier).toBe('fused');
      expect(r.result).toBe(fused.result);
      expect(r.confidence).toBe(fused.confidence);
      expect(r.source).toBe(fused.source);
    });

    it('#1936 G4 — environment=underground + fusedPasses=true + fusedPassesStrict=false → tier 7 미진입', () => {
      // underground 분기 strict gate(0.05km)가 일반 gate(0.2km)보다 엄격 — fusedPassesStrict=false이면
      // tier 7 미진입. cascade가 더 약한 신호 tier(detection-verdict / route / gps-fallback)로 흐름.
      const fused = makeFused();
      const r = pickFusionTier(
        'underground',
        makeSignals({ fused, fusedPasses: true, fusedPassesStrict: false }),
      );
      expect(r.tier).not.toBe('fused');
    });

    it('#1936 G4 — environment=underground + fusedPassesStrict=true → tier 7 채택', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'underground',
        makeSignals({ fused, fusedPasses: true, fusedPassesStrict: true }),
      );
      expect(r.tier).toBe('fused');
    });

    it('environment=mixed/unknown은 fusedPasses 사용 (strict 미적용)', () => {
      const fused = makeFused();
      // mixed/unknown은 issue body: "현 정신 보존 — cascade 분기 비활성"
      const rMixed = pickFusionTier(
        'unknown',
        makeSignals({ fused, fusedPasses: true, fusedPassesStrict: false }),
      );
      expect(rMixed.tier).toBe('fused');
    });
  });

  describe('Tier 8: detection-verdict', () => {
    it('detectionVerdictAccepts + fused → tier 8 채택, confidence detection-fused 승격', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          fused,
          fusedPasses: false,
          fusedPassesStrict: false,
          detectionVerdictAccepts: true,
        }),
      );
      expect(r.tier).toBe('detection-verdict');
      expect(r.result).toBe(fused.result);
      expect(r.confidence).toBe('detection-fused');
      expect(r.source).toBe(fused.source);
    });

    it('detectionVerdictAccepts=true + fused=null → tier 8 미진입 (caller 게이트 동치성 방어)', () => {
      const r = pickFusionTier(
        'underground',
        makeSignals({ fused: null, detectionVerdictAccepts: true }),
      );
      expect(r.tier).not.toBe('detection-verdict');
    });
  });

  describe('Tier 9: route', () => {
    it('routeResult + routePasses → tier 9 채택', () => {
      const route = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ routeResult: route, routePasses: true }),
      );
      expect(r.tier).toBe('route');
      expect(r.result).toBe(route);
      expect(r.confidence).toBe('route-progress');
      expect(r.source).toBe('route-progress');
    });

    it('routeResult + routePasses=false → tier 9 미진입', () => {
      const route = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ routeResult: route, routePasses: false }),
      );
      expect(r.tier).not.toBe('route');
    });
  });

  describe('Tier 10: gps-fallback — environment 분기 (underground 시 strict)', () => {
    it('environment=surface + gpsFallbackResult 존재 → tier 10 일반 사용', () => {
      const fb = makeResult();
      const r = pickFusionTier(
        'surface',
        makeSignals({ gpsFallbackResult: fb, gpsFallbackResultStrict: null }),
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBe(fb);
      expect(r.confidence).toBe('gps-only');
      expect(r.source).toBe('gps');
    });

    it('#1936 G4 — environment=underground + gpsFallbackResultStrict=null → result=null (stale GPS 거부)', () => {
      // 일반 gpsFallbackResult는 있어도 underground 분기에서 strict null이면 채택 거부.
      const fb = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ gpsFallbackResult: fb, gpsFallbackResultStrict: null }),
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBeNull();
    });

    it('#1936 G4 — environment=underground + gpsFallbackResultStrict 존재 → strict 채택', () => {
      const fb = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ gpsFallbackResult: null, gpsFallbackResultStrict: fb }),
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBe(fb);
    });

    it('environment=mixed/unknown은 gpsFallbackResult 사용 (strict 미적용)', () => {
      const fb = makeResult();
      const r = pickFusionTier(
        'unknown',
        makeSignals({ gpsFallbackResult: fb, gpsFallbackResultStrict: null }),
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBe(fb);
    });

    it('모든 tier null + gpsFallbackResult null → tier 10 채택 + result=null (cascade sink 보장)', () => {
      const r = pickFusionTier('unknown', makeSignals());
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBeNull();
      expect(r.confidence).toBe('gps-only');
      expect(r.source).toBe('gps');
    });
  });

  describe('cascade 우선순위 — tier 1 > tier 2 > ... > tier 10', () => {
    it('tier 1과 tier 6 둘 다 활성 시 tier 1 채택', () => {
      const tier1Result = makeResult({ name: 'tier1' });
      const tier6Result = makeResult({ name: 'tier6' });
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainBoardingLockMatch: true,
          positionTrainResult: tier1Result,
          // tier 6 fallthrough가능 신호도 있지만 tier 1이 먼저 통과
          hasBoardingLock: true,
          lockedTrainCode: 'T1',
          trainProgressTrainNo: 'T1',
        }),
      );
      expect(r.tier).toBe('position-train-lock');
      expect(r.result).toBe(tier1Result);
    });

    it('tier 4와 tier 5 둘 다 활성 시 tier 4 (backend-ssot) 채택', () => {
      const ssot = makeStation({ name: 'ssot' });
      const wifi = makeResult({ name: 'wifi' });
      const r = pickFusionTier(
        'underground',
        makeSignals({
          backendSsotAccepts: true,
          ssotStation: ssot,
          wifiStationResolved: wifi,
        }),
      );
      expect(r.tier).toBe('backend-ssot');
    });
  });

  describe('본 trip evidence 15:49:35 시뮬 — tier 6 차단 시 tier 7→10 흐름 (G4 acceptance #5)', () => {
    // 시나리오: barometer null + cellular surface 미확정 + accel walking → environment 'underground'
    // 추정 (보수적). tier 6 lockless positionTrain 게이트는 caller(useFusedNearestStation)가
    // 4-signal consensus로 reject → positionTrainResult=null로 전달.
    // tier 7 fused는 strict 거리 게이트(0.05km) 미통과 → fusedPassesStrict=false.
    // tier 10 gpsFallback strict(15s) 통과 → 삼성역 GPS 좌표 채택.
    it('underground + positionTrainResult=null + fusedPassesStrict=false + gpsFallbackResultStrict 통과 → tier 10 채택', () => {
      const fused = makeFused({ name: '강남' }, 0.066); // 잘못된 후보(strict 거부)
      const fallback = makeResult({ name: '삼성' }, 0.066);
      const r = pickFusionTier(
        'underground',
        makeSignals({
          positionTrainResult: null, // F-fix consensus reject
          fused,
          fusedPasses: true,
          fusedPassesStrict: false, // 0.05km strict 미통과
          gpsFallbackResult: fallback,
          gpsFallbackResultStrict: fallback, // ≤15s 신선
        }),
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result?.station.name).toBe('삼성');
    });

    it('환경 분기 미적용 시뮬(surface) — 같은 신호로 tier 7 채택 (regression evidence)', () => {
      // 같은 시그널을 surface로 평가하면 tier 7이 채택돼 잘못된 station(강남)이 결정된다.
      // G4 환경 분기가 실제로 작동하는지 evidence.
      const fused = makeFused({ name: '강남' }, 0.066);
      const fallback = makeResult({ name: '삼성' }, 0.066);
      const r = pickFusionTier(
        'surface',
        makeSignals({
          positionTrainResult: null,
          fused,
          fusedPasses: true,
          fusedPassesStrict: false,
          gpsFallbackResult: fallback,
          gpsFallbackResultStrict: fallback,
        }),
      );
      expect(r.tier).toBe('fused');
      expect(r.result?.station.name).toBe('강남');
    });
  });

  describe('11-tier × 4 environment matrix smoke', () => {
    const environments: Environment[] = ['surface', 'underground', 'unknown'];
    // Note: stations.json `mixed`는 stationEnvironment에는 존재하지만 inferEnvironment Environment
    // type은 surface/underground/unknown만 가진다. 본 picker는 inferEnvironment 산출을 받으므로
    // 'unknown'으로 mixed 의미를 흡수 (테스트도 3 environment 표).

    it.each(environments)('environment=%s + all-null signals → tier 10 채택 (sink)', (env) => {
      const r = pickFusionTier(env, makeSignals());
      expect(r.tier).toBe('gps-fallback');
    });

    it.each(environments)('environment=%s + tier 4 activated → tier 4 채택', (env) => {
      const ssot = makeStation();
      const r = pickFusionTier(
        env,
        makeSignals({ backendSsotAccepts: true, ssotStation: ssot }),
      );
      expect(r.tier).toBe('backend-ssot');
    });
  });
});

describe('pickFusionTier — #2004 (Phase 4-1, ADR-022 A6) simpleArch flag dormant', () => {
  describe('flag OFF (기본) — 기존 10-tier cascade 그대로', () => {
    it('backendSsotAccepts=true → tier 4 채택 (flag OFF backward-compat)', () => {
      const ssot = makeStation();
      const r = pickFusionTier(
        'underground',
        makeSignals({ backendSsotAccepts: true, ssotStation: ssot }),
        false,
      );
      expect(r.tier).toBe('backend-ssot');
    });

    it('wifiStationResolved 활성 → tier 5 채택 (flag OFF)', () => {
      const wifi = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ wifiStationResolved: wifi }),
        false,
      );
      expect(r.tier).toBe('wifi');
    });

    it('positionTrainResult 활성 → tier 6 채택 (flag OFF)', () => {
      const pt = makeResult();
      const r = pickFusionTier(
        'surface',
        makeSignals({ positionTrainResult: pt }),
        false,
      );
      expect(r.tier).toBe('position-train');
    });

    it('flag param 미전달(default false) → 기존 cascade 그대로', () => {
      const wifi = makeResult();
      const r = pickFusionTier(
        'underground',
        makeSignals({ wifiStationResolved: wifi }),
        // no third arg → default false
      );
      expect(r.tier).toBe('wifi');
    });
  });

  describe('flag ON — arrival(fused) + gps-fallback 2-tier 만 활성', () => {
    it('flag ON + fused 활성 → tier 7 채택', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'surface',
        makeSignals({ fused, fusedPasses: true, fusedPassesStrict: true }),
        true,
      );
      expect(r.tier).toBe('fused');
      expect(r.confidence).toBe('arrival-confirmed');
    });

    it('flag ON + backendSsotAccepts=true(skip 대상) + fused 활성 → tier 7 채택 (backend-ssot skip)', () => {
      const ssot = makeStation({ name: 'backend-ssot-station' });
      const fused = makeFused({ name: 'fused-station' });
      const r = pickFusionTier(
        'surface',
        makeSignals({
          backendSsotAccepts: true,
          ssotStation: ssot,
          fused,
          fusedPasses: true,
          fusedPassesStrict: true,
        }),
        true,
      );
      expect(r.tier).toBe('fused');
      expect(r.result?.station.name).toBe('fused-station');
    });

    it('flag ON + wifi/positionTrain/route 활성(skip 대상) + gps-fallback → tier 10 채택', () => {
      const wifi = makeResult({ name: 'wifi-station' });
      const pt = makeResult({ name: 'pt-station' });
      const route = makeResult({ name: 'route-station' });
      const fallback = makeResult({ name: 'gps-station' });
      const r = pickFusionTier(
        'surface',
        makeSignals({
          wifiStationResolved: wifi,
          positionTrainResult: pt,
          routeResult: route,
          routePasses: true,
          gpsFallbackResult: fallback,
        }),
        true,
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result?.station.name).toBe('gps-station');
      expect(r.confidence).toBe('gps-only');
    });

    it('flag ON + 모든 skip tier 활성(position-train-lock/gps-fast-path/arvl-arrived/backend-ssot/wifi/position-train/detection-verdict/route) + fused=null + fallback → tier 10 gps-fallback 채택', () => {
      const ptResult = makeResult({ name: 'pt-lock' });
      const gpsTop = makeResult({ name: 'gps-fast' });
      const arvl = makeResult({ name: 'arvl' });
      const ssot = makeStation({ name: 'backend' });
      const wifi = makeResult({ name: 'wifi' });
      const pt = makeResult({ name: 'pt' });
      const route = makeResult({ name: 'route' });
      const fallback = makeResult({ name: 'gps-fallback' });
      const r = pickFusionTier(
        'surface',
        makeSignals({
          positionTrainBoardingLockMatch: true,
          positionTrainResult: ptResult,
          gpsDerivedFastPath: true,
          gpsTopCandidate: gpsTop,
          arvlCdArrivedMatch: arvl,
          backendSsotAccepts: true,
          ssotStation: ssot,
          wifiStationResolved: wifi,
          hasBoardingLock: true,
          lockedTrainCode: 'T1',
          trainProgressTrainNo: 'T1',
          routeResult: route,
          routePasses: true,
          gpsFallbackResult: fallback,
          // fused null → tier 7 미진입 → sink 로 gps-fallback 채택
        }),
        true,
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result?.station.name).toBe('gps-fallback');
    });

    it('flag ON + detection-verdict 활성(skip 대상) → tier 8 미진입', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          fused,
          fusedPasses: false,
          fusedPassesStrict: false, // tier 7 게이트 미통과
          detectionVerdictAccepts: true, // tier 8 활성이나 flag ON 시 skip
        }),
        true,
      );
      expect(r.tier).not.toBe('detection-verdict');
      expect(r.tier).toBe('gps-fallback');
    });

    it('flag ON + arvlCdArrivedMatch(tier 3, skip) 활성 + fused → tier 7 fused 채택', () => {
      const arvl = makeResult({ name: 'arvl-lock' });
      const fused = makeFused({ name: 'fused-station' });
      const r = pickFusionTier(
        'underground',
        makeSignals({
          arvlCdArrivedMatch: arvl,
          arvlCdDriftBlocked: false,
          fused,
          fusedPasses: true,
          fusedPassesStrict: true,
        }),
        true,
      );
      expect(r.tier).toBe('fused');
      expect(r.result?.station.name).toBe('fused-station');
    });

    it('flag ON + 모든 tier null → tier 10 gps-fallback sink (result=null)', () => {
      const r = pickFusionTier('unknown', makeSignals(), true);
      expect(r.tier).toBe('gps-fallback');
      expect(r.result).toBeNull();
    });

    it('flag ON + fusedPasses=false + detectionVerdictAccepts=true(skip) + route+routePasses(skip) → gps-fallback', () => {
      const fused = makeFused();
      const route = makeResult();
      const r = pickFusionTier(
        'surface',
        makeSignals({
          fused,
          fusedPasses: false,
          fusedPassesStrict: false,
          detectionVerdictAccepts: true,
          routeResult: route,
          routePasses: true,
        }),
        true,
      );
      expect(r.tier).toBe('gps-fallback');
    });

    it('flag ON + underground fused strict gate 통과 → tier 7 채택 (env 분기 유지)', () => {
      const fused = makeFused();
      const r = pickFusionTier(
        'underground',
        makeSignals({
          fused,
          fusedPasses: true,
          fusedPassesStrict: true,
        }),
        true,
      );
      expect(r.tier).toBe('fused');
    });

    it('flag ON + underground gps-fallback strict → strict 변형 그대로 사용 (env 분기 유지)', () => {
      const fb = makeResult({ name: 'strict-fb' });
      const r = pickFusionTier(
        'underground',
        makeSignals({
          gpsFallbackResult: null,
          gpsFallbackResultStrict: fb,
        }),
        true,
      );
      expect(r.tier).toBe('gps-fallback');
      expect(r.result?.station.name).toBe('strict-fb');
    });
  });
});

describe('isCandidateEnvMismatch — #1934 G3 option B 통합', () => {
  function candidateWithEnv(env?: StationEnvironment): NearestStationResult {
    return { station: makeStation({ environment: env }), distanceKm: 0.05 };
  }

  it('environment=surface + candidate.station.environment=underground → mismatch (reject)', () => {
    expect(isCandidateEnvMismatch('surface', candidateWithEnv('underground'))).toBe(true);
  });

  it('environment=underground + candidate.station.environment=surface → mismatch (reject)', () => {
    expect(isCandidateEnvMismatch('underground', candidateWithEnv('surface'))).toBe(true);
  });

  it('environment=surface + candidate.environment=surface → 일치 (no reject)', () => {
    expect(isCandidateEnvMismatch('surface', candidateWithEnv('surface'))).toBe(false);
  });

  it('environment=underground + candidate.environment=underground → 일치 (no reject)', () => {
    expect(isCandidateEnvMismatch('underground', candidateWithEnv('underground'))).toBe(false);
  });

  it('environment=unknown → 항상 통과 (분간 불가)', () => {
    expect(isCandidateEnvMismatch('unknown', candidateWithEnv('surface'))).toBe(false);
    expect(isCandidateEnvMismatch('unknown', candidateWithEnv('underground'))).toBe(false);
  });

  it('candidate.station.environment=undefined → 통과 (schema 누락 entry 보수 처리)', () => {
    expect(isCandidateEnvMismatch('surface', candidateWithEnv(undefined))).toBe(false);
    expect(isCandidateEnvMismatch('underground', candidateWithEnv(undefined))).toBe(false);
  });

  it('candidate.station.environment=mixed → 통과 (분간 불가)', () => {
    expect(isCandidateEnvMismatch('surface', candidateWithEnv('mixed'))).toBe(false);
    expect(isCandidateEnvMismatch('underground', candidateWithEnv('mixed'))).toBe(false);
  });

  it('candidate.station.environment=unknown → 통과 (분간 불가)', () => {
    expect(isCandidateEnvMismatch('surface', candidateWithEnv('unknown'))).toBe(false);
    expect(isCandidateEnvMismatch('underground', candidateWithEnv('unknown'))).toBe(false);
  });
});
