/**
 * #1930 G1 — stations.json `environment` 필드 schema 정합 박제.
 *
 * Epic #1927 (fusion environment SSOT 다층 paradigm) G1 sub-issue.
 *
 * scripts/validate-stations.js의 런타임 CI assertion(enum + 누락)과 별도로,
 * type-level + 분포 정체 + mixed 엔트리 identity를 unit 레이어에서 박제한다.
 * 데이터 갱신 시 본 테스트가 drift를 즉시 가시화하여 후속 G2~G4 cascade가
 * environment 변수를 기반으로 의사결정할 때 hidden regression을 차단.
 *
 * 박제 대상:
 *   1. entry count (533 = 528 운영 단위 역 + 환승 line variant 5)
 *   2. 모든 entry에 environment 필드 존재 (typing이 optional이지만 runtime 100%)
 *   3. environment ∈ STATION_ENVIRONMENTS enum
 *   4. mixed=1 엔트리 정체 박제 (`gyeongui-021` 가좌 — 경의중앙선 split platform)
 *   5. unknown=0 (검수 완료)
 *   6. 지하 우세 sanity (underground 비율 > 60%, 서울 지하철 일반 분포)
 */

import stationsData from '../stations.json';
import { STATION_ENVIRONMENTS, type Station, type StationEnvironment } from '../../shared/types/station';

const stations = stationsData as Station[];

describe('stations.json environment schema (#1930 G1)', () => {
  it('533 entries — 528 운영 단위 역 + 환승 line variant 5', () => {
    expect(stations.length).toBe(533);
  });

  it('모든 entry에 environment 필드가 채워져 있다', () => {
    const missing = stations.filter((s) => s.environment === undefined || s.environment === null);
    expect(missing).toEqual([]);
  });

  it('모든 environment 값이 enum 안에 있다', () => {
    const allowed = new Set<StationEnvironment>(STATION_ENVIRONMENTS);
    const offending = stations.filter(
      (s) => s.environment !== undefined && !allowed.has(s.environment),
    );
    expect(offending).toEqual([]);
  });

  it('environment 분포가 박제된 값과 일치한다 (drift detector)', () => {
    const counts: Record<StationEnvironment, number> = {
      surface: 0,
      underground: 0,
      mixed: 0,
      unknown: 0,
    };
    for (const s of stations) {
      if (s.environment !== undefined) counts[s.environment] += 1;
    }
    expect(counts).toEqual({
      surface: 157,
      underground: 375,
      mixed: 1,
      unknown: 0,
    });
  });

  it('mixed=1 엔트리는 가좌 경의중앙선 (KRRIC split platform)', () => {
    const mixedEntries = stations.filter((s) => s.environment === 'mixed');
    expect(mixedEntries).toHaveLength(1);
    const [entry] = mixedEntries;
    expect(entry).toMatchObject({
      id: 'gyeongui-021',
      name: '가좌',
      line: 'gyeongui',
    });
  });

  it('unknown=0 — 사용자 검수 placeholder 잔여 없음', () => {
    const unknown = stations.filter((s) => s.environment === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('지하 우세 sanity — underground 비율 > 60%', () => {
    const undergroundCount = stations.filter((s) => s.environment === 'underground').length;
    const ratio = undergroundCount / stations.length;
    expect(ratio).toBeGreaterThan(0.6);
  });

  it('id가 unique — validate-stations.js id 중복 룰 데이터 박제', () => {
    const ids = stations.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
