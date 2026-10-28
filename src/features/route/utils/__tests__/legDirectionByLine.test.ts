/**
 * #3191 PR-2D — arcStations → 노선별 leg 진행 방향 맵.
 *
 * 기대값 출처(구현을 보고 쓰지 않는다):
 *  - 7호선 용마산→중곡(trip 179 leg 1) = 'down'. 사용자 열차 7035(석남행)가 R2 position에서 updnLine=1(하행),
 *    반대 방향 7012(도봉산행)가 updnLine=0 (seoul-capture/2026-10-27/1793136405264.json).
 *  - 7호선 건대입구→용마산(trip 180) = 'up'(도봉산행 = updnLine 0 = 상행).
 *  - run 길이 1 / 같은 노선 run끼리 방향 불일치 → null(미해결, fail-closed 입력).
 */
import { computeRouteArc } from '../routeProgress';
import { legDirectionByLine } from '../tripDirection';
import { findRoutes, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';

function arcOf(fromName: string, fromLine: Station['line'], toName: string, toLine: Station['line']) {
  const origin = findStationByNameAndLine(fromName, fromLine)!;
  const destination = findStationByNameAndLine(toName, toLine)!;
  const [candidate] = findRoutes(origin.id, destination.id);
  return computeRouteArc(candidate.route, origin, destination)!.stations;
}

describe('legDirectionByLine (#3191 PR-2D)', () => {
  it('trip 179 용마산(7)→건대입구→뚝섬(2): 7호선 down, 2호선은 외선(down)', () => {
    const map = legDirectionByLine(arcOf('용마산', '7', '뚝섬', '2'));
    expect(map.get('7')).toBe('down');
    expect(map.get('2')).toBe('down');
    expect(map.size).toBe(2);
  });

  it('trip 180 성수(2)→건대입구→용마산(7): 2호선 내선(up), 7호선 up', () => {
    const map = legDirectionByLine(arcOf('성수', '2', '용마산', '7'));
    expect(map.get('2')).toBe('up');
    expect(map.get('7')).toBe('up');
  });

  it('run 길이 1인 노선은 null(미해결)', () => {
    const yongmasan = findStationByNameAndLine('용마산', '7')!;
    const seongsu = findStationByNameAndLine('성수', '2')!;
    const junggok = findStationByNameAndLine('중곡', '7')!;
    const map = legDirectionByLine([yongmasan, junggok, seongsu]);
    expect(map.get('7')).toBe('down');
    expect(map.get('2')).toBeNull();
  });

  it('같은 노선 run끼리 방향이 다르면 null', () => {
    const a = findStationByNameAndLine('용마산', '7')!;
    const b = findStationByNameAndLine('중곡', '7')!;
    const x = findStationByNameAndLine('성수', '2')!;
    const y = findStationByNameAndLine('건대입구', '2')!;
    // 7호선 run1: 용마산→중곡(down), run2: 중곡→용마산(up)
    const map = legDirectionByLine([a, b, x, y, b, a]);
    expect(map.get('7')).toBeNull();
    expect(map.get('2')).toBe('up');
  });

  it('빈 arc는 빈 맵', () => {
    expect(legDirectionByLine([]).size).toBe(0);
  });
});
