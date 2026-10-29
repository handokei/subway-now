/**
 * #3158 PR-2 — `rejectAmbiguousUntiered`(vanish 한정 opt-in): tier(2/1/0/3/5) 후보가 없고 99-only 후보가 2개 이상이면 null.
 * 플래그 없는 호출(프롬프트 `scheduled.ts` 등)의 "받은 순서 첫 후보" 계약은 무변경.
 */
import { describe, expect, it } from 'vitest';
import { resolveTrainCodeWithFallback } from '../arrivalsFromPositions';
import { pickAutoTrainCode } from '../boardingPrompt';
import type { ArrivalEntry } from '../seoul';

function arrival(trainCode: string, arvlCd: number, isUp = true): ArrivalEntry {
  return { trainCode, arvlCd, isUp, destination: '', arrivalSeconds: 60, subwayNm: '2호선' };
}
const OPT = { rejectAmbiguousUntiered: true } as const;

describe('pickAutoTrainCode rejectAmbiguousUntiered', () => {
  const two99 = [arrival('2288', 99), arrival('3290', 99)];

  it('99-only 2개: 플래그 켜면 null, 끄면 받은 순서 첫 후보(무변경)', () => {
    expect(pickAutoTrainCode(two99, '2', 'up', OPT)).toBeNull();
    expect(pickAutoTrainCode(two99, '2', 'up')).toBe('2288');
  });

  it('99-only 1개: 플래그 켜도 그 열차를 고른다', () => {
    expect(pickAutoTrainCode([arrival('3324', 99)], '2', 'up', OPT)).toBe('3324');
  });

  it('tier 단독(arvlCd5) + 99 다수: 플래그 켜도 tier 후보 선택(10/22 6405)', () => {
    const pool = [arrival('2361', 99), arrival('6405', 5), arrival('2000', 99)];
    expect(pickAutoTrainCode(pool, '2', 'up', OPT)).toBe('6405');
  });

  it('반대 방향 99는 모호성 계산에서 제외: 같은 방향 99 1개 + 반대 방향 99 -> 그 1개', () => {
    const pool = [arrival('2288', 99, true), arrival('2999', 99, false)];
    expect(pickAutoTrainCode(pool, '2', 'up', OPT)).toBe('2288');
  });
});

describe('resolveTrainCodeWithFallback rejectAmbiguousUntiered 전달', () => {
  const base = {
    positions: undefined,
    line: '2',
    direction: 'up' as const,
    segmentStations: ['건대입구'],
    targetStation: '건대입구',
  };
  const realArrivals = [arrival('2288', 99), arrival('3290', 99)];

  it('플래그 on: real 99-only 모호 -> null', () => {
    expect(resolveTrainCodeWithFallback({ ...base, realArrivals, rejectAmbiguousUntiered: true })).toBeNull();
  });

  it('플래그 off: 기존대로 첫 후보 2288', () => {
    expect(resolveTrainCodeWithFallback({ ...base, realArrivals })?.trainCode).toBe('2288');
  });
});
