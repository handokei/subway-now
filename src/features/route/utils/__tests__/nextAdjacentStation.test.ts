import { resolveNextAdjacentStationName } from '../nextAdjacentStation';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';

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

  describe('#2446 — 비단조 순환 노선(2호선)은 inferLoopDirection fallback으로 인접역 산출', () => {
    // 뚝섬 실탑승 회귀(2026-08-31): resolveTravelDirection이 2호선(MONOTONIC_LINES 밖)에서
    // null을 반환 → 이 함수도 null → 호출자(buildDirectionMeta)가 raw trainLineNm("성수행")을
    // 그대로 노출해 반대 방향 라벨이 표시됐다. inferLoopDirection + nextLoopAdjacentStationName
    // fallback으로 route 방향 기준 실제 다음 인접역을 산출한다.
    it('뚝섬 → 신당(환승) 방향 → 한양대(1-hop 인접역, 내선)', () => {
      // 뚝섬(2-010) → 신당(2-006) 진행 방향은 id 감소(내선/한양대 방면). resolveTripDirection과
      // 동일하게 'up'을 산출해야 한다(회귀 방지 — tripDirection.test.ts에 동일 케이스 병행).
      expect(resolveNextAdjacentStationName('2', '뚝섬', '신당')).toBe('한양대');
    });

    it('강남 → 잠실 방향 → 역삼(1-hop, id 감소 방향)', () => {
      expect(resolveNextAdjacentStationName('2', '강남', '잠실')).toBe('역삼');
    });

    it('순환선 wrap 경계(신촌 → 시청) → 이대(wrap-aware 1-hop)', () => {
      expect(resolveNextAdjacentStationName('2', '신촌', '시청')).toBe('이대');
    });

    it('지선(까치산)은 main range 밖 — resolveTravelDirection도 loop fallback도 null', () => {
      expect(resolveNextAdjacentStationName('2', '까치산', '시청')).toBeNull();
    });

    it('toward가 2호선에 존재하지 않는 역명이면 inferLoopDirection도 null → 이 함수도 null', () => {
      expect(resolveNextAdjacentStationName('2', '시청', '존재하지않는역명XYZ')).toBeNull();
    });
  });

  describe('#2446 — 하이브리드 순환 노선(6호선 응암 루프)도 loop fallback으로 동작', () => {
    it('합정 → 공덕 방향(본선 forward) → 상수(1-hop)', () => {
      expect(resolveNextAdjacentStationName('6', '합정', '공덕')).toBe('상수');
    });

    it('합정 → 망원 방향(본선 backward) → 망원(1-hop, 종점 인접이라 그 자체가 다음역)', () => {
      expect(resolveNextAdjacentStationName('6', '합정', '망원')).toBe('망원');
    });
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
