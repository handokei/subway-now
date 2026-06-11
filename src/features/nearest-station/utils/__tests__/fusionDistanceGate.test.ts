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

  it('accuracy null이면 통과', () => {
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: null,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
  });

  it('accuracy > MAX_ACCURACY_M(지하) 통과', () => {
    expect(
      passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters: MAX_ACCURACY_M + 1,
        gpsNearest,
        maxAbsoluteKm: 0.6,
        maxDeltaKm: 0.2,
      }),
    ).toBe(true);
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
    it('lockActive=false 이면 accuracy>MAX_ACCURACY_M 지하 bypass 유지(기존 동작)', () => {
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
      ).toBe(true);
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

