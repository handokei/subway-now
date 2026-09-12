import { directionOnLine } from '../directionOnLine';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

describe('directionOnLine (#2455)', () => {
  it('단조 노선(3호선) 정방향 — id 증가 → down', () => {
    const daehwa = findStationByNameAndLine(canonicalStationName('대화', '3'), '3')!;
    const madu = findStationByNameAndLine(canonicalStationName('마두', '3'), '3')!;
    expect(directionOnLine('3', daehwa.id, madu.id)).toBe('down');
  });

  it('단조 노선(3호선) 역방향 — id 감소 → up', () => {
    const daehwa = findStationByNameAndLine(canonicalStationName('대화', '3'), '3')!;
    const madu = findStationByNameAndLine(canonicalStationName('마두', '3'), '3')!;
    expect(directionOnLine('3', madu.id, daehwa.id)).toBe('up');
  });

  it('2호선 순환선 비-seam 구간 — 뚝섬→성수(짧은 forward) → down', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
    expect(directionOnLine('2', ddukseom.id, seongsu.id)).toBe('down');
  });

  it('2호선 순환선 비-seam 구간 — 성수→뚝섬(짧은 backward) → up', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
    expect(directionOnLine('2', seongsu.id, ddukseom.id)).toBe('up');
  });

  it('같은 station이면 null', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    expect(directionOnLine('2', ddukseom.id, ddukseom.id)).toBeNull();
  });

  it('fromStationId가 해당 노선에 없으면 null', () => {
    const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
    expect(directionOnLine('2', 'unknown-id', seongsu.id)).toBeNull();
  });

  it('toStationId가 해당 노선에 없으면 null', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    expect(directionOnLine('2', ddukseom.id, 'unknown-id')).toBeNull();
  });

  // 2호선 순환선 seam(시청↔충정로) — resolveTripDirection이 내부적으로 쓰는 것과 동일한
  // shortestLinePathIndices 알고리즘이므로, resolveTripDirection(route, '시청', 충정로.id)와
  // 정확히 같은 값을 내야 한다(#2455 설계 노트에서 검증한 값 그대로 고정).
  it('2호선 seam(충정로→시청, wrap) — resolveTripDirection과 동일한 값으로 고정', () => {
    const chungjeongno = findStationByNameAndLine(canonicalStationName('충정로', '2'), '2')!;
    const sicheong = findStationByNameAndLine(canonicalStationName('시청', '2'), '2')!;
    expect(directionOnLine('2', chungjeongno.id, sicheong.id)).toBe('up');
  });
});
