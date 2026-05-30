import { resolveNextAdjacentStationName } from '../nextAdjacentStation';
import { getStationsOnLine } from '../stationRoute';

describe('resolveNextAdjacentStationName', () => {
  it('7호선 단조 — 용마산에서 부평구청(downstream 종점) 방향 → 한 칸 다음 인접역', () => {
    const stations = getStationsOnLine('7');
    const yongmasanIdx = stations.findIndex((s) => s.name === '용마산');
    expect(yongmasanIdx).toBeGreaterThan(-1);
    const next = resolveNextAdjacentStationName('7', '용마산', '부평구청');
    expect(next).toBe(stations[yongmasanIdx + 1].name);
  });

  it('7호선 — 용마산에서 장암(upstream 종점) 방향 → 반대편 인접역', () => {
    const stations = getStationsOnLine('7');
    const yongmasanIdx = stations.findIndex((s) => s.name === '용마산');
    const next = resolveNextAdjacentStationName('7', '용마산', '장암');
    expect(next).toBe(stations[yongmasanIdx - 1].name);
  });

  it('비단조 노선(2호선 순환)은 null', () => {
    expect(resolveNextAdjacentStationName('2', '강남', '잠실')).toBeNull();
  });

  it('towardStation이 stations에 없으면 (확장 미반영 종점 등) null', () => {
    // 7호선 stations.json에 석남(인천 연장) 미반영 — resolveTravelDirection이 null 반환
    expect(resolveNextAdjacentStationName('7', '용마산', '석남')).toBeNull();
  });

  it('현재역이 stations 리스트에 없으면 null', () => {
    expect(resolveNextAdjacentStationName('7', '__missing__', '부평구청')).toBeNull();
  });

  it('현재역과 toward가 동일하면 null (방향 결정 불가)', () => {
    expect(resolveNextAdjacentStationName('7', '용마산', '용마산')).toBeNull();
  });

  it('현재역이 노선 종점이고 그 너머 방향은 인접역이 없어 null', () => {
    const stations = getStationsOnLine('7');
    const first = stations[0].name; // 장암
    const last = stations[stations.length - 1].name; // 부평구청
    // 장암에서 부평구청 방향 → first의 다음(인덱스 +1)이 정상 인접역
    expect(resolveNextAdjacentStationName('7', first, last)).toBe(stations[1].name);
    // 부평구청에서 장암 방향 → last의 이전(인덱스 -1)
    expect(resolveNextAdjacentStationName('7', last, first)).toBe(stations[stations.length - 2].name);
  });
});
