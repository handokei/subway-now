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

  it('2호선 순환선 비-seam 구간 — 뚝섬→성수(짧은 forward, idx 증가) → up (내선, #2867)', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
    expect(directionOnLine('2', ddukseom.id, seongsu.id)).toBe('up');
  });

  it('2호선 순환선 비-seam 구간 — 성수→뚝섬(짧은 backward, idx 감소) → down (외선, #2867)', () => {
    const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
    const seongsu = findStationByNameAndLine(canonicalStationName('성수', '2'), '2')!;
    expect(directionOnLine('2', seongsu.id, ddukseom.id)).toBe('down');
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

  // 2호선 순환선 seam(시청↔충정로) — directionOnLine과 resolveTripDirection이 내부적으로 같은
  // travelDirectionSign(#2949 단일 primitive, `shortestLinePathIndices`가 계산한 부호를 그대로
  // 반환)을 쓰므로 두 함수는 항상 self-consistent하다. 충정로→시청은 물리적으로 바로 옆
  // 역(내선, 1 hop)이라 'up'이 정답 — #2949 fix 전에는 seam에서 `firstStepIdx > fromIdx`
  // 재계산이 wrap을 "idx 증가"로 오해해 'down'(오답)을 냈다(K-2 #2954가 그 오답을 계약으로
  // 고정했던 값, #2949가 고치며 갱신).
  it('2호선 seam(충정로→시청, wrap) → up(내선, #2949 fix 후 정답)', () => {
    const chungjeongno = findStationByNameAndLine(canonicalStationName('충정로', '2'), '2')!;
    const sicheong = findStationByNameAndLine(canonicalStationName('시청', '2'), '2')!;
    expect(directionOnLine('2', chungjeongno.id, sicheong.id)).toBe('up');
  });
});
