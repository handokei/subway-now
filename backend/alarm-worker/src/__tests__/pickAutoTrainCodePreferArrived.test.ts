/**
 * #3221 PR-4 (D-1a) — `preferArrivedOverDeparted`(탑승 질문 발사 전용 opt-in): 도착(1) > 출발(2) > 진입(0).
 * 플래그 없는 호출(vanish-swap·arrivalsFromPositions 등)의 2>1>0 계약은 무변경.
 */
import { describe, expect, it } from 'vitest';
import { resolveTrainCodeWithFallback } from '../arrivalsFromPositions';
import { pickAutoTrainCode } from '../boardingPrompt';
import type { ArrivalEntry } from '../seoul';

function arrival(trainCode: string, arvlCd: number, isUp = true): ArrivalEntry {
  return { trainCode, arvlCd, isUp, destination: '', arrivalSeconds: 60, subwayNm: '2호선' };
}
const OPT = { preferArrivedOverDeparted: true } as const;

describe('pickAutoTrainCode preferArrivedOverDeparted', () => {
  const departedAndArrived = [arrival('A-2', 2), arrival('B-1', 1)];

  it('출발(2) A + 도착(1) B: 플래그 켜면 B, 끄면 A(기존 2>1>0 무변경)', () => {
    expect(pickAutoTrainCode(departedAndArrived, '2', 'up', OPT)).toBe('B-1');
    expect(pickAutoTrainCode(departedAndArrived, '2', 'up')).toBe('A-2');
  });

  it('도착 열차가 없으면 플래그 켜도 출발 열차(회고 탭 보존)', () => {
    expect(pickAutoTrainCode([arrival('A-2', 2), arrival('C-0', 0)], '2', 'up', OPT)).toBe('A-2');
  });

  it('출발(2) > 진입(0) 순서는 유지', () => {
    expect(pickAutoTrainCode([arrival('C-0', 0), arrival('A-2', 2)], '2', 'up', OPT)).toBe('A-2');
  });

  it('도착(1) 2대면 ambiguity null — 출발 열차로 폴백하지 않는다', () => {
    const pool = [arrival('A-2', 2), arrival('B-1', 1), arrival('D-1', 1)];
    expect(pickAutoTrainCode(pool, '2', 'up', OPT)).toBeNull();
  });

  it('반대 방향 도착(1) 열차는 무시: 같은 방향 출발(2)을 고른다', () => {
    const pool = [arrival('A-2', 2, true), arrival('X-1', 1, false)];
    expect(pickAutoTrainCode(pool, '2', 'up', OPT)).toBe('A-2');
  });

  it('다른 호출자 경로(resolveTrainCodeWithFallback)는 옵션 없이 2>1>0 유지', () => {
    const r = resolveTrainCodeWithFallback({
      positions: undefined,
      line: '2',
      direction: 'up',
      segmentStations: ['건대입구'],
      targetStation: '건대입구',
      realArrivals: departedAndArrived,
    });
    expect(r?.trainCode).toBe('A-2');
  });
});
