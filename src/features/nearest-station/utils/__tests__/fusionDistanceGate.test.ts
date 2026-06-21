import { isWithinArcWindow, passesFusionDistanceGate } from '../fusionDistanceGate';
import { MAX_ACCURACY_M } from '../../../../shared/constants/location';
import type { NearestStationResult, Station } from '../../../../shared/types/station';

function makeStation(id: string, lat: number, lng: number): Station {
  return { id, name: id, line: '7', lineColor: '#000', lat, lng };
}

function makeResult(id: string, lat: number, lng: number, distanceKm: number): NearestStationResult {
  return { station: makeStation(id, lat, lng), distanceKm };
}

describe('passesFusionDistanceGate', () => {
  const userLocation = { lat: 37.5, lng: 127.0 };
  const candidate = makeResult('A', 37.5, 127.0, 0.5);
  const gpsNearest = makeResult('B', 37.5, 127.0, 0.1);

  it('userLocation 없으면 통과(검사 불가)', () => {
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation: null,
        accuracyMeters: 10,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
  });

  // R13-a (#1612): accuracy null + lock 비활성 strict reject (지하 dead zone 누수 차단).
  // lock 활성 trip은 면제 (사용자 명시 의향 trip 동급 보장).
  it('R13-a (#1612): accuracy null + lock 비활성 → reject (strict)', () => {
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: null,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(false);
  });

  // R13-a (#1612): bad accuracy + lock 비활성 strict reject (지하 dead zone 누수 차단).
  // lock 활성 trip은 보호 (#1016 hole b 별도 분기).
  it('R13-a (#1612): accuracy > MAX_ACCURACY_M(지하) + lock 비활성 → reject (strict)', () => {
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: MAX_ACCURACY_M + 1,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(false);
  });

  it('절대 거리 초과 → 실패', () => {
    expect(
      passesFusionDistanceGate({
        candidate: makeResult('A', 0, 0, 0.7),
        userLocation,
        accuracyMeters: 10,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(false);
  });

  it('상대 margin 초과 → 실패', () => {
    // candidate(A) 거리 0.5, gpsNearest(B) 거리 0.1, 0.5 > 0.1+0.2=0.3 → 실패
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: 10,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(false);
  });

  it('gpsNearest 없으면 상대 검사 스킵', () => {
    expect(
      passesFusionDistanceGate({
        candidate: makeResult('A', 0, 0, 0.5),
        userLocation,
        accuracyMeters: 10,
        gpsNearest: undefined,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
  });

  it('gpsNearest와 같은 station이면 상대 검사 스킵', () => {
    expect(
      passesFusionDistanceGate({
        candidate: makeResult('SAME', 0, 0, 0.5),
        userLocation,
        accuracyMeters: 10,
        gpsNearest: makeResult('SAME', 0, 0, 0.1),
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
  });

  it('모두 통과', () => {
    expect(
      passesFusionDistanceGate({
        candidate: makeResult('A', 0, 0, 0.2),
        userLocation,
        accuracyMeters: 10,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
  });

  describe('#1016 hole (b) — lockActive 엄격 모드', () => {
    // R13-a (#1612) — 기존 "지하 bypass 유지" 동작 제거. lock 비활성 시 strict reject로 회귀 차단.
    it('R13-a (#1612): lockActive=false + accuracy>MAX_ACCURACY_M → strict reject (지하 dead zone 누수 차단)', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.7),
          userLocation,
          accuracyMeters: MAX_ACCURACY_M + 1,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          lockActive: false,
        }),
      ).toBe(false);
    });

    it('lockActive=true 이면 accuracy>MAX_ACCURACY_M 이어도 bypass 거부 — 절대 거리 초과 시 실패', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.7),
          userLocation,
          accuracyMeters: MAX_ACCURACY_M + 1,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          lockActive: true,
        }),
      ).toBe(false);
    });

    it('lockActive=true 이어도 accuracyMeters=null 이면 통과(측정 불가)', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.2),
          userLocation,
          accuracyMeters: null,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          lockActive: true,
        }),
      ).toBe(true);
    });

    it('lockActive=true + accuracy 양호 + 거리 정상 → 통과', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.2),
          userLocation,
          accuracyMeters: 50,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          lockActive: true,
        }),
      ).toBe(true);
    });
  });

  // R13-a (#1612) — 신규 strict 가드 동작 종합 검증.
  describe('R13-a (#1612) — strict bad-accuracy guard', () => {
    it('lockActive 미명시(undefined) + accuracy null → reject (default 보수)', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.2),
          userLocation,
          accuracyMeters: null,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          // lockActive 미전달 — falsy로 strict 적용
        }),
      ).toBe(false);
    });

    it('lockActive 미명시(undefined) + accuracy>MAX_ACCURACY_M → reject', () => {
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.2),
          userLocation,
          accuracyMeters: MAX_ACCURACY_M + 1,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
        }),
      ).toBe(false);
    });

    it('userLocation null + accuracy null → 통과 (userLocation 가드가 우선)', () => {
      // 거리 검사 자체 불가하므로 모든 caller에 동일 영향 — 기존 동작 보존.
      expect(
        passesFusionDistanceGate({
          candidate,
          userLocation: null,
          accuracyMeters: null,
          gpsNearest,
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
        }),
      ).toBe(true);
    });

    it('lockActive=false + accuracy 양호 (≤ MAX_ACCURACY_M) → 기존 distance 검사로 진행', () => {
      // strict 가드 통과 후 distance 검사 — 정상 trip은 영향 0.
      expect(
        passesFusionDistanceGate({
          candidate: makeResult('A', 0, 0, 0.2),
          userLocation,
          accuracyMeters: 100,
          gpsNearest: makeResult('A', 0, 0, 0.15),
          maxAbsoluteKm: 0.6,
          maxDeltaKm: 0.2,
          lockActive: false,
        }),
      ).toBe(true);
    });
  });
});

describe('isWithinArcWindow (#1016 hole c)', () => {
  const arc: Station[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map((id) =>
    makeStation(id, 0, 0),
  );

  it('arc 비어있으면 true(free-trip)', () => {
    expect(isWithinArcWindow([], 'S5', 'S0')).toBe(true);
  });

  it('탑승역이 arc에 없으면 true(데이터 불일치)', () => {
    expect(isWithinArcWindow(arc, 'S2', 'UNKNOWN')).toBe(true);
  });

  it('후보가 arc에 없으면 false', () => {
    expect(isWithinArcWindow(arc, 'UNKNOWN', 'S0')).toBe(false);
  });

  it('탑승역 인덱스 + WINDOW 이내 → true', () => {
    // S0(0) + WINDOW(3) = S3까지 허용
    expect(isWithinArcWindow(arc, 'S3', 'S0')).toBe(true);
  });

  it('탑승역 인덱스 + WINDOW 초과 → false', () => {
    // S0(0) + WINDOW(3) = S3까지, S4는 초과
    expect(isWithinArcWindow(arc, 'S4', 'S0')).toBe(false);
  });

  it('후보가 탑승역 자신이면 true', () => {
    expect(isWithinArcWindow(arc, 'S2', 'S2')).toBe(true);
  });
});

