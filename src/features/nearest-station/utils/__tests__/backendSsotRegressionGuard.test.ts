/**
 * #2669 — backend SSoT 경로 역행 가드 단위 검증.
 *
 * 재현 기준(2026-09-16 라이드): backend가 06:41:10 이후 전진을 멈춘 채 같은 SSoT(건대입구)를
 * 재전송했고, 06:44:46에 사용자가 뚝섬에 도착했는데도 표시가 건대입구(idx 7→0)로 되돌아갔다.
 */
import {
  BACKEND_SSOT_ADVANCE_STALE_GPS_MS,
  BACKEND_SSOT_ADVANCE_STALE_MS,
  isBackendSsotRouteRegression,
} from '../backendSsotRegressionGuard';

const NOW = 1_700_000_000_000;

function inputs(overrides: Partial<Parameters<typeof isBackendSsotRouteRegression>[0]> = {}) {
  return {
    // backend는 4분 전에 마지막으로 전진했다(= 추적 멈춤).
    mirrorLastAdvanceAt: NOW - 4 * 60_000,
    mirrorArcIndex: 0,
    gpsArcIndex: 7,
    gpsQualityDegraded: false,
    now: NOW,
    ...overrides,
  };
}

describe('isBackendSsotRouteRegression (#2669)', () => {
  it('backend 정체 + GPS 신뢰 + GPS가 경로상 앞 → 거부', () => {
    expect(isBackendSsotRouteRegression(inputs())).toBe(true);
  });

  it('backend가 최근에 전진했으면 거부하지 않는다 (정상 추적 중)', () => {
    // #2841 — 이 케이스는 gpsAhead 경로(gpsQualityDegraded=false, gpsArcIndex>mirrorArcIndex)를
    // 태운다. GPS 경로의 stale 임계가 60s(BACKEND_SSOT_ADVANCE_STALE_GPS_MS)로 완화됐으므로,
    // "최근 전진"의 경계값도 그 임계 기준으로 재정의한다(기존 180s 경계값은 gpsAhead에는 더 이상
    // 유효하지 않다 — 이 테스트가 바로 그 변경 대상 상수를 검증하므로 boundary 조정이 불가피).
    expect(
      isBackendSsotRouteRegression(
        inputs({ mirrorLastAdvanceAt: NOW - (BACKEND_SSOT_ADVANCE_STALE_GPS_MS - 1_000) }),
      ),
    ).toBe(false);
  });

  it('GPS 품질 저하(지하·정지)면 거부하지 않는다 — backend 권위 유지', () => {
    expect(isBackendSsotRouteRegression(inputs({ gpsQualityDegraded: true }))).toBe(false);
  });

  it('GPS가 경로상 뒤/같은 위치면 거부하지 않는다 (역주행·동일역은 정상)', () => {
    expect(isBackendSsotRouteRegression(inputs({ gpsArcIndex: 0 }))).toBe(false);
    expect(isBackendSsotRouteRegression(inputs({ gpsArcIndex: -1 }))).toBe(false);
  });

  it('mirror가 경로 밖이면 판정하지 않는다', () => {
    expect(isBackendSsotRouteRegression(inputs({ mirrorArcIndex: -1 }))).toBe(false);
  });

  it('lazy-seed(lastAdvanceAt=0) trip은 거부하지 않는다 — 부트스트랩 차단 방지', () => {
    expect(isBackendSsotRouteRegression(inputs({ mirrorLastAdvanceAt: 0 }))).toBe(false);
  });
});

/**
 * #2686 — 지하 표시 되감김 재현: GPS가 저하된 상태(gpsQualityDegraded=true)에서도 device의
 * source-무관 채택 추정치(reanchored-hop 포함)가 mirror보다 앞서면 거부해야 한다.
 *
 * 재현 기준(2026-09-17 저녁 라이드): backend가 성수(idx=1)에 얼어붙은 채 19:57:00에 재전송했고,
 * 그 사이 device는 reanchored-hop으로 성수(1) → 건대입구(2) → 건대입구·7호선(3)까지 실제 전진했다.
 * GPS는 지하라 저하 상태였다 — #2669(GPS 전용 가드)는 이 경우 무방비였다.
 */
describe('isBackendSsotRouteRegression — #2686 source-무관 device 추정치 확장', () => {
  function undergroundInputs(
    overrides: Partial<Parameters<typeof isBackendSsotRouteRegression>[0]> = {},
  ) {
    return {
      // backend는 4분 전(성수)에 멈췄다.
      mirrorLastAdvanceAt: NOW - 4 * 60_000,
      mirrorArcIndex: 1, // 성수
      gpsArcIndex: -1, // 지하 — GPS 좌표 자체가 무의미
      gpsQualityDegraded: true, // 지하 — GPS 품질 게이트 저하
      deviceEstimateArcIndex: 3, // reanchored-hop이 실제로 도달한 건대입구(7호선) idx
      now: NOW,
      ...overrides,
    };
  }

  it('GPS 저하 + reanchored-hop이 경로상 mirror보다 앞 → 거부(#2669 GPS 전용 가드로는 통과했던 케이스)', () => {
    expect(isBackendSsotRouteRegression(undergroundInputs())).toBe(true);
  });

  it('deviceEstimateArcIndex가 mirror와 같거나 뒤면 채택(=거부 안 함) — mirror가 앞설 때는 항상 채택', () => {
    expect(
      isBackendSsotRouteRegression(undergroundInputs({ deviceEstimateArcIndex: 1 })),
    ).toBe(false);
    expect(
      isBackendSsotRouteRegression(undergroundInputs({ deviceEstimateArcIndex: 0 })),
    ).toBe(false);
  });

  it('deviceEstimateArcIndex 미지정(-1)이면 이 경로는 판정하지 않는다 — 기존 GPS 전용 호출부 회귀 없음', () => {
    expect(
      isBackendSsotRouteRegression(undergroundInputs({ deviceEstimateArcIndex: -1 })),
    ).toBe(false);
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 4 * 60_000,
        mirrorArcIndex: 1,
        gpsArcIndex: -1,
        gpsQualityDegraded: true,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('backend가 최근에 전진했으면(정체 아님) deviceEstimateArcIndex가 앞서도 거부하지 않는다', () => {
    expect(
      isBackendSsotRouteRegression(
        undergroundInputs({ mirrorLastAdvanceAt: NOW - (BACKEND_SSOT_ADVANCE_STALE_MS - 1_000) }),
      ),
    ).toBe(false);
  });

  it('lazy-seed(lastAdvanceAt=0)은 deviceEstimateArcIndex가 앞서도 거부하지 않는다 — 부트스트랩 보호', () => {
    expect(
      isBackendSsotRouteRegression(undergroundInputs({ mirrorLastAdvanceAt: 0 })),
    ).toBe(false);
  });

  it('mirror가 경로 밖(-1)이면 deviceEstimateArcIndex와 무관하게 판정하지 않는다', () => {
    expect(
      isBackendSsotRouteRegression(undergroundInputs({ mirrorArcIndex: -1 })),
    ).toBe(false);
  });

  it('GPS가 신뢰 가능하고 앞서 있어도(기존 경로) 여전히 거부 — OR 결합, GPS 경로 회귀 없음', () => {
    expect(
      isBackendSsotRouteRegression(
        undergroundInputs({ gpsQualityDegraded: false, gpsArcIndex: 5, deviceEstimateArcIndex: -1 }),
      ),
    ).toBe(true);
  });
});

/**
 * #2841 — 트립 꼬리(마지막 1-hop) 미보호 fix.
 *
 * 재현 기준(2026-09-30 트립 e25e1158, 지상·FG, Estimator State 실측):
 * ```
 * 06:51:49 | backend-ssot-override | 성수(2) idx=6
 * 06:54:33 | lockless-route-hop    | 뚝섬(2) idx=7  ← 사용자 실제 뚝섬 도착(GPS acc 23m)
 * 06:54:35 | backend-ssot-override | 성수(2) idx=6  ← 표시가 도로 성수로 되감김
 * ```
 * 경과 164s(<180s)라 기존 공통 stale 게이트가 비활성 → 거부되지 않았다. 역간 이동이 보통
 * 2~3분이라 트립의 마지막 한 정거장은 항상 180s 미만 — 구조적 사각지대.
 */
describe('isBackendSsotRouteRegression — #2841 트립 꼬리(GPS 경로 완화 임계) 확장', () => {
  it('9/30 성수 실측값 그대로: 경과 164s + GPS(뚝섬, idx7)가 mirror(성수, idx6)보다 앞 → 거부', () => {
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 164_000,
        mirrorArcIndex: 6,
        gpsArcIndex: 7,
        gpsQualityDegraded: false,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('① 지하(GPS 저하) + 164s + deviceEstimateArcIndex가 앞서도 거부하지 않는다 — deviceAhead는 180s 그대로(지하 불변)', () => {
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 164_000,
        mirrorArcIndex: 6,
        gpsArcIndex: -1,
        gpsQualityDegraded: true,
        deviceEstimateArcIndex: 7,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('② 경과 30s + GPS가 앞서 있어도 거부하지 않는다 — 같은 틱 jitter 보호(60s 미만)', () => {
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 30_000,
        mirrorArcIndex: 6,
        gpsArcIndex: 7,
        gpsQualityDegraded: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('③ GPS가 mirror보다 뒤(역주행)면 경과와 무관하게 거부하지 않는다', () => {
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 164_000,
        mirrorArcIndex: 6,
        gpsArcIndex: 5,
        gpsQualityDegraded: false,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('④ 경과 200s + deviceAhead(지하) → 거부 — 기존 180s 경로 무회귀', () => {
    expect(
      isBackendSsotRouteRegression({
        mirrorLastAdvanceAt: NOW - 200_000,
        mirrorArcIndex: 6,
        gpsArcIndex: -1,
        gpsQualityDegraded: true,
        deviceEstimateArcIndex: 7,
        now: NOW,
      }),
    ).toBe(true);
  });
});
