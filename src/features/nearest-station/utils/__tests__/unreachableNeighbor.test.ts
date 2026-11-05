import { findUnreachableNeighborIds, type UnreachableNeighborInput } from '../unreachableNeighbor';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { haversine } from '../../../../shared/utils/haversine';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import type { NearestStationResult, Station } from '../../../../shared/types/station';

const ttukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2') as Station; // 2-010
const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2') as Station; // 2-011 (hop 60s)
const hanyang = findStationByNameAndLine(canonicalStationName('한양대', '2'), '2') as Station; // 2-009 (hop 90s)
const gunja = findStationByNameAndLine(canonicalStationName('군자', '7'), '7') as Station;

function at(station: Station, user: { lat: number; lng: number }): NearestStationResult {
  return { station, distanceKm: haversine(user.lat, user.lng, station.lat, station.lng) };
}

/** 뚝섬 바로 옆(앵커 ~20m)에서 찍힌 정지 fix. 성수는 ~0.8km라 신선 게이트가 거부하는 위치. */
const USER = { lat: ttukseom.lat + 0.0001, lng: ttukseom.lng + 0.0001 };

function input(overrides: Partial<UnreachableNeighborInput> = {}): UnreachableNeighborInput {
  return {
    candidates: [at(ttukseom, USER), at(seongsu, USER)],
    fixAgeMs: 16_000,
    accuracyMeters: 19,
    speedMps: 0,
    userLocation: USER,
    stationaryHold: false,
    lockActive: false,
    ...overrides,
  };
}

describe('findUnreachableNeighborIds (#3191 PR-D)', () => {
  it('정지 fix 16s < hop 60s, 신선 게이트가 거부할 위치 -> 성수 제외', () => {
    expect(findUnreachableNeighborIds(input())).toEqual([seongsu.id]);
  });

  it('후보가 둘 이상 인접이면 모두 제외 (뚝섬 양쪽 이웃)', () => {
    const candidates = [at(ttukseom, USER), at(seongsu, USER), at(hanyang, USER)];
    expect(findUnreachableNeighborIds(input({ candidates }))).toEqual([seongsu.id, hanyang.id]);
  });

  it.each([
    ['lock 있음', { lockActive: true }],
    ['hold 활성', { stationaryHold: true }],
    ['좌표 없음', { userLocation: null }],
    ['fix 나이 판단 불가', { fixAgeMs: null }],
    ['fix 나이 14.999s (신선: 15s 미만)', { fixAgeMs: 14_999 }],
    ['정확도 모름', { accuracyMeters: null }],
    ['정확도 31m', { accuracyMeters: 31 }],
    ['속도 0.5 m/s', { speedMps: 0.5 }],
    ['후보 없음', { candidates: [] }],
    ['앵커뿐', { candidates: [at(ttukseom, USER)] }],
    ['fix 나이 == hop(60s)', { fixAgeMs: 60_000 }],
  ] as const)('비활성: %s -> 빈 목록', (_label, overrides) => {
    expect(findUnreachableNeighborIds(input(overrides))).toEqual([]);
  });

  it.each([
    ['정확도 30m', { accuracyMeters: 30 }],
    ['속도 null', { speedMps: null }],
    ['속도 0.49 m/s', { speedMps: 0.49 }],
    ['fix 나이 15s (stale 하한)', { fixAgeMs: 15_000 }],
    ['fix 나이 59.999s', { fixAgeMs: 59_999 }],
  ] as const)('경계 활성: %s -> 성수 제외', (_label, overrides) => {
    expect(findUnreachableNeighborIds(input(overrides))).toEqual([seongsu.id]);
  });

  it('신선 fix였다면 거리 게이트를 통과했을 위치면 제외하지 않는다 (앵커 0.35km / 성수 0.46km)', () => {
    const t = 0.43;
    const user = {
      lat: ttukseom.lat + t * (seongsu.lat - ttukseom.lat),
      lng: ttukseom.lng + t * (seongsu.lng - ttukseom.lng),
    };
    const candidates = [at(ttukseom, user), at(seongsu, user)];
    expect(findUnreachableNeighborIds(input({ candidates, userLocation: user }))).toEqual([]);
  });

  it('인접 hop 키가 없는 후보(다른 노선·비인접)는 제외하지 않는다', () => {
    const candidates = [at(ttukseom, USER), at(gunja, USER)];
    expect(findUnreachableNeighborIds(input({ candidates }))).toEqual([]);
  });

  it('앵커의 같은 노선 대응 역이 없는 후보(노선 불일치)는 제외하지 않는다', () => {
    const lineSixOnly = { ...seongsu, line: '6' as const };
    const candidates = [at(ttukseom, USER), at(lineSixOnly, USER)];
    expect(findUnreachableNeighborIds(input({ candidates }))).toEqual([]);
  });
});
