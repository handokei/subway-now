/**
 * #2954 K-2 — `stationRoute.ts:94`(`getLineStationsCached`)의 `sort((a,b)=>a.id.localeCompare(b.id))`는
 * "station id 순서 = 노선 물리적 순서"를 암묵 전제한다. 방향 판정(`directionOnLine.ts`,
 * `tripDirection.ts:resolveTripDirection`, backend `legDirection.ts:inferLegDirection`)이 전부
 * 이 전제 위에서 동작한다.
 *
 * 그런데 실측(2026-10-11, 공식 Seoul API `trainLineNm`의 "…방면" = 그 열차의 물리적 다음
 * 정차역, 152행 중 판정가능 137행 전부 인접)으로 그 전제가 두 지점에서 이미 깨져 있다:
 *
 *   - 1호선 구로(1-042) ↔ 가산디지털단지(1-100) — 공식 인접이지만 id 배열 idx 차이 21.
 *     원인: 가산디지털단지가 경부선 본선 역으로 100번대에 단독 배치(번호 사고).
 *   - 2호선 시청(2-001) ↔ 충정로(2-043) — 공식 인접(순환선 seam)이지만 idx 차이 42.
 *     원인: `lineLoopPath.ts`의 `CLOSED_LOOP_MAIN_ID_RANGES`(2호선 본선 2-001~2-043)가
 *     wraparound를 명시 처리해 **방향 판정 자체는 정확**하다. 다만 그 처리는 이 두 id가
 *     "본선 range의 양 끝"이라는 **현재 배치**에 의존한다 — 역 추가로 range 양 끝이나
 *     range 내부 상대 순서가 바뀌면 wraparound 계산이 어긋날 수 있다.
 *
 * 1호선 쪽은 상황이 더 나쁘다 — `directionOnLine.ts`/`inferLegDirection`은 두 역이
 * closed-loop 본선이 아니므로 단순 forward slice를 쓰는데, 그 slice가 만드는 경로(인천 경유)는
 * **물리적으로 틀렸다**. 방향 부호가 맞는 건 "분기 양쪽(인천행도 가산디지털단지행도) 모두
 * 구로보다 id가 크다"는 **데이터 배치의 우연**일 뿐이다(`legDirection.ts` 상단 doc,
 * `../../features/route/utils/__tests__/idAdjacencyContract.test.ts` 참고).
 *
 * **누락 61역 추가가 예정돼 있다**(`tasks/2026-10-11-station-data-audit-official-csv.md`,
 * PR #2954 — 공식 역간거리 CSV 전수 대조). 그 작업이 이 배치를 조용히 깨뜨릴 수 있다.
 *
 * 본 테스트는 그 배치를 **고정**한다 — 역 추가/재번호로 아래 assert가 깨지면, 방향 판정
 * 테스트(`idAdjacencyContract.test.ts`, backend `legDirection.test.ts` "#2954 seam" 블록)도
 * 함께 재검증해야 한다는 신호다. 이 테스트만 통과시키려 id를 조정하지 말 것 — stations.json은
 * 공식 역명/번호 SSoT다.
 */

import stationsData from '../stations.json';
import type { Station } from '../../shared/types/station';

const stations = stationsData as Station[];

function findById(id: string): Station {
  const found = stations.find((s) => s.id === id);
  if (!found) throw new Error(`fixture station id 누락: ${id} — stations.json 변경 시 본 테스트부터 갱신 필요`);
  return found;
}

describe('stations.json id 배치 — 방향 판정이 의존하는 현재 상태 고정 (#2954 K-2)', () => {
  it('1호선 구로(1-042) < 가산디지털단지(1-100) — id 사전순, 노선 물리 순서와 불일치(번호 사고)', () => {
    const guro = findById('1-042');
    const gasan = findById('1-100');
    expect(guro.name).toBe('구로');
    expect(gasan.name).toBe('가산디지털단지');
    expect(guro.id < gasan.id).toBe(true);
  });

  it('2호선 시청(2-001) < 충정로(2-043) — 둘 다 closed-loop 본선 range 양 끝(순환선 seam)', () => {
    const cityHall = findById('2-001');
    const chungjeongno = findById('2-043');
    expect(cityHall.name).toBe('시청');
    expect(chungjeongno.name.startsWith('충정로')).toBe(true);
    expect(cityHall.id < chungjeongno.id).toBe(true);
  });
});
