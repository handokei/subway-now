import { estimateEtaSeconds, distanceMetersBetween, estimateTransitEtaSeconds } from '../stationEta';

describe('estimateEtaSeconds', () => {
  it('returns null when speed is null', () => {
    expect(estimateEtaSeconds(100, null)).toBeNull();
  });

  it('returns null when speed is below minimum (< 0.5 m/s)', () => {
    expect(estimateEtaSeconds(100, 0)).toBeNull();
    expect(estimateEtaSeconds(100, 0.4)).toBeNull();
    expect(estimateEtaSeconds(100, -1)).toBeNull();
  });

  it('computes eta when speed >= 0.5 m/s (역 진입 감속 구간 포함)', () => {
    expect(estimateEtaSeconds(100, 10)).toBe(10);
    expect(estimateEtaSeconds(50, 5)).toBe(10);
    expect(estimateEtaSeconds(0, 5)).toBe(0);
    expect(estimateEtaSeconds(5, 0.5)).toBe(10);
  });

  it('matches typical subway speed', () => {
    // 200m at 20 m/s (72 km/h) → 10s
    expect(estimateEtaSeconds(200, 20)).toBe(10);
  });
});

describe('estimateTransitEtaSeconds', () => {
  // #2279 RED: 성수→뚝섬 1정거장, 직선거리 1000m ÷ 순간속도 2m/s = 500s(≈9분) — 실소요(hop 시간
  // 실측 테이블 기준 120s≈2분)와 정거장수 무관하게 산출되던 버그. hop 시간 상한으로 clamp되어야 한다.
  it('clamps distance/speed overestimate to the hop-time based ceiling (성수→뚝섬 evidence)', () => {
    const distanceMeters = 1000; // haversine 직선거리(감속 구간 저속 샘플)
    const speedMps = 2; // 역 진입 감속 구간 순간 속도
    const hopBasedSeconds = 120; // getRouteRemainingSeconds(route) 실측 hop 시간(1정거장)
    expect(estimateEtaSeconds(distanceMeters, speedMps)).toBe(500); // 버그였던 산식(회귀 방지용 대조)
    expect(estimateTransitEtaSeconds(distanceMeters, speedMps, hopBasedSeconds)).toBe(120);
  });

  it('uses the smaller distance/speed estimate when it undercuts the hop ceiling (imminent 근접 유지)', () => {
    // 역 진입 직전 근접 감속 — distance/speed(20s)가 hop 기반(120s)보다 짧으면 그대로 사용해
    // imminent phase 반응성을 보존한다(9-2 대비 회귀 없음).
    expect(estimateTransitEtaSeconds(20, 1, 120)).toBe(20);
  });

  it('falls back to hop-time only when speed is null (division 자체를 폐기)', () => {
    expect(estimateTransitEtaSeconds(1000, null, 120)).toBe(120);
  });

  it('falls back to hop-time only when speed is below the minimum valid threshold', () => {
    expect(estimateTransitEtaSeconds(1000, 0.4, 120)).toBe(120);
  });

  // #2288 리뷰 P3-1 — 경계 케이스. evaluateAlarmPhase의 imminent 게이트(IMMINENT_ETA_SECONDS=10s,
  // src/features/alarm/utils/alarmPhases.ts)보다 hopBasedSeconds가 작은 경우, 이 함수는 특별
  // 취급 없이 그대로 통과시킨다(min-clamp 로직에 10s 문턱값 자체가 없음). stationTravelTimes.json
  // 실측 최솟값은 현재 60s(stationEta.ts 주석 참조)라 이 경로는 production에서 발생하지 않지만,
  // 향후 데이터에 <10s 이상치가 유입되면 imminent 게이트가 매 hop 조기 발화할 수 있다 — 그 가정
  // 붕괴를 이 테스트가 드러낸다.
  it('passes hopBasedSeconds through unmodified even below the imminent-gate threshold (10s)', () => {
    // speed 없음 → hop 기반 값(5s, 10s 미만) 그대로 통과.
    expect(estimateTransitEtaSeconds(1000, null, 5)).toBe(5);
    // distance/speed(500s)가 hop 기반(5s)보다 크면 여전히 5s로 clamp — 10s 문턱과 무관.
    expect(estimateTransitEtaSeconds(1000, 2, 5)).toBe(5);
  });
});

describe('distanceMetersBetween', () => {
  it('returns 0 for identical coords', () => {
    expect(distanceMetersBetween(37.5, 127.0, 37.5, 127.0)).toBe(0);
  });

  it('returns positive distance for different coords', () => {
    // 강남(37.4980, 127.0278) <-> 역삼(37.5006, 127.0364) — 약 800m
    const d = distanceMetersBetween(37.4980, 127.0278, 37.5006, 127.0364);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(1200);
  });
});
