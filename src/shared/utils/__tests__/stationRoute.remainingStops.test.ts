// #1480 — 홈 상단 "N STOPS"는 여정 전체가 아니라 현재역 기준 남은 정거장.
// 실데이터(stations.json), mock 없음. 실측: trip 180(성수→건대입구→용마산) 건대입구 7호선 위 = 4.
import { anchorRouteToCurrentStation, findRoute, getRouteTotalStops, getStationById } from '../stationRoute';

function station(id: string) {
  const s = getStationById(id);
  if (!s) throw new Error(`station not found: ${id}`);
  return s;
}

const DEST = '7-015'; // 용마산

describe('getRouteTotalStops (재앵커링 route 기준 남은 정거장)', () => {
  const stored = findRoute('2-011', DEST)!; // 성수(2) → 건대입구 환승 → 용마산(7)

  it('환승 전 출발역: 1+4 = 5 유지 (여정 전체 = 재앵커 전과 동일)', () => {
    expect(stored.type).toBe('transfer');
    expect(getRouteTotalStops(anchorRouteToCurrentStation(stored, station('2-011'), DEST)!)).toBe(5);
  });

  it('환승 후 건대입구 7호선 위: toLine 남은 4', () => {
    expect(getRouteTotalStops(anchorRouteToCurrentStation(stored, station('7-019'), DEST)!)).toBe(4);
  });

  it('toLine에서 한 역 진행할 때마다 1씩 감소', () => {
    const ids = ['7-019', '7-018', '7-017', '7-016', '7-015'];
    const counts = ids.map((id) => getRouteTotalStops(anchorRouteToCurrentStation(stored, station(id), DEST)!));
    expect(counts).toEqual([4, 3, 2, 1, 0]);
  });

  it('direct: stops', () => {
    const direct = findRoute('2-011', '2-012')!;
    expect(getRouteTotalStops(direct)).toBe(1);
  });

  it('다중 환승: transfers 순회 합 (환승 완료 구간은 0으로 차감)', () => {
    const multi = findRoute('9-030', '6-026')!;
    expect(multi.type).toBe('multi-transfer');
    const full = getRouteTotalStops(multi);
    const onLast = getRouteTotalStops(anchorRouteToCurrentStation(multi, station('6-025'), '6-026')!);
    expect(onLast).toBe(1);
    expect(full).toBeGreaterThan(onLast);
  });
});
