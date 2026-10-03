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

// ADR-039 2단계(#2728) — trainMatchArc: trainCode 일치 실측 신호는 GPS 거리로 거부되지 않는다.
describe('passesFusionDistanceGate — trainMatchArc (ADR-039 2단계, #2728)', () => {
  const userLocation = { lat: 37.5, lng: 127.0 };
  const arc: Station[] = ['건대입구', '중곡', '용마산', '사가정', 'S4', 'S5'].map((id) =>
    makeStation(id, 0, 0),
  );

  it('실측(2026-09-18) 재현: trainCode 일치 + GPS 3030m 초과여도 arc 정합성 통과 시 채택된다 (GREEN)', () => {
    // 건대입구(고착 GPS) ↔ 중곡 실거리 3030m 조건 그대로 — 절대/상대 거리 모두 threshold 초과.
    const candidate = makeResult('중곡', 0, 0, 3.03);
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: 74,
        gpsNearest: makeResult('건대입구', 0, 0, 0),
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
        lockActive: true,
        trainMatchArc: { arcStations: arc, boardingStationId: '건대입구' },
      }),
    ).toBe(true);
  });

  it('RED 재현 — trainMatchArc 없이 같은 입력이면 절대 거리 초과로 거부된다(수정 전 동작)', () => {
    const candidate = makeResult('중곡', 0, 0, 3.03);
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: 74,
        gpsNearest: makeResult('건대입구', 0, 0, 0),
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
        lockActive: true,
        // trainMatchArc 미전달 — 기존(2단계 이전) 동작 그대로 reject.
      }),
    ).toBe(false);
  });

  it('trainMatchArc 있어도 arc window 초과 후보면 거부된다 (#444 목적 승계)', () => {
    // S4(idx 4)는 건대입구(idx 0) 기준 LOCK_NEXT_HOP_WINDOW(3) 밖 — arc 정합성 자체가 실패해야 한다.
    const candidate = makeResult('S4', 0, 0, 0.05);
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: 10,
        gpsNearest: undefined,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
        lockActive: true,
        trainMatchArc: { arcStations: arc, boardingStationId: '건대입구' },
      }),
    ).toBe(false);
  });

  it('trainCode 불일치 후보(trainMatchArc 미전달)는 기존 거리 검사가 그대로 적용된다 (#444 회귀 보존)', () => {
    // #1817 시나리오 취지 — mismatch 후보는 arc가 아무리 유효해도 여기선 거리 게이트로 걸러진다.
    const candidate = makeResult('중곡', 0, 0, 3.03);
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: 10,
        gpsNearest: makeResult('건대입구', 0, 0, 0),
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
        lockActive: true,
      }),
    ).toBe(false);
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

