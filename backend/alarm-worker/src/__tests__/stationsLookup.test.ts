/**
 * #1707 — Backend stationsLookup adapter 단위 테스트.
 *
 * 검증 범위:
 *   1. 알려진 (name, line) → 좌표 반환 (lat/lng 형태 검증).
 *   2. 미존재 (name, line) → null.
 *   3. canonical fallback (alias name) — shared findStationByNameAndLine 동작 위임 검증.
 */
import { describe, expect, it } from 'vitest';
import { deriveWaypointEnvironment, findStationCoordsByNameAndLine } from '../stationsLookup';

describe('findStationCoordsByNameAndLine (#1707)', () => {
  it('returns coords for known (stationName, line) pair', () => {
    const coords = findStationCoordsByNameAndLine('합정', '2');
    expect(coords).not.toBeNull();
    expect(typeof coords?.lat).toBe('number');
    expect(typeof coords?.lng).toBe('number');
    // 합정 line 2 (stations.json: 37.549457, 126.913808). 정밀 비교는 stations.json drift에
    // 약함 — type/finite 검증으로 충분 (canonicalStationName 룰 정합).
    expect(Number.isFinite(coords?.lat)).toBe(true);
    expect(Number.isFinite(coords?.lng)).toBe(true);
  });

  it('returns null for unknown station name', () => {
    const coords = findStationCoordsByNameAndLine('없는역이름', '2');
    expect(coords).toBeNull();
  });

  it('returns null for known name but wrong line (no overlap)', () => {
    // 합정은 line 2 / 6에 있음. 1호선 합정은 없음.
    const coords = findStationCoordsByNameAndLine('합정', '1');
    expect(coords).toBeNull();
  });

  it('returns only {lat, lng} shape (좁힌 StationCoord 형태)', () => {
    const coords = findStationCoordsByNameAndLine('홍대입구', '2');
    expect(coords).not.toBeNull();
    if (coords !== null) {
      expect(Object.keys(coords).sort()).toEqual(['lat', 'lng']);
    }
  });
});

/**
 * #2623 — waypoint(다음 정차역) → stations.json environment 파생.
 *
 * 발사/advance 판정의 environment 입력을 device 기압계(`trip.subsurface`)에서 역 데이터로
 * 교체하는 핵심 유닛. 원설계(E1 #1444, consensusGate.StationEnvironment docstring)가
 * stations.json 필드를 명시했으나 wire가 device subsurface로 잘못 연결됐던 회귀(#2623)의 fix.
 */
describe('deriveWaypointEnvironment (#2623)', () => {
  it('underground 역 → "underground" (군자, line 7 — canonical fallback)', () => {
    expect(deriveWaypointEnvironment({ stationName: '군자', line: '7' })).toBe('underground');
  });

  it('surface 역 → "surface" (소요산, line 1)', () => {
    expect(deriveWaypointEnvironment({ stationName: '소요산', line: '1' })).toBe('surface');
  });

  it('mixed 역 → "hybrid" (가좌, gyeongui — stations.json "mixed"를 evidence 어휘 "hybrid"로 매핑)', () => {
    expect(deriveWaypointEnvironment({ stationName: '가좌', line: 'gyeongui' })).toBe('hybrid');
  });

  it('역 lookup 실패 → "unknown" fallback (기존 보수 정책 유지)', () => {
    expect(deriveWaypointEnvironment({ stationName: '없는역이름', line: '2' })).toBe('unknown');
  });

  it('알려진 이름이지만 노선이 다름(overlap 없음) → "unknown" fallback', () => {
    // 합정은 line 2 / 6에만 존재 — line 1에는 없음.
    expect(deriveWaypointEnvironment({ stationName: '합정', line: '1' })).toBe('unknown');
  });
});
