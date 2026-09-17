/**
 * #2669 — backend SSoT 경로 역행 가드 단위 검증.
 *
 * 재현 기준(2026-09-16 라이드): backend가 06:41:10 이후 전진을 멈춘 채 같은 SSoT(건대입구)를
 * 재전송했고, 06:44:46에 사용자가 뚝섬에 도착했는데도 표시가 건대입구(idx 7→0)로 되돌아갔다.
 */
import {
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
    expect(
      isBackendSsotRouteRegression(
        inputs({ mirrorLastAdvanceAt: NOW - (BACKEND_SSOT_ADVANCE_STALE_MS - 1_000) }),
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
