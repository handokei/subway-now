import { passesFusionDistanceGate } from '../fusionDistanceGate';
import { MAX_ACCURACY_M } from '../../constants/location';
import type { NearestStationResult, Station } from '../../types/station';

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
});

