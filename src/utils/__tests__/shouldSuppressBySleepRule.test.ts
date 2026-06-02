import { shouldSuppressBySleepRule } from '../shouldSuppressBySleepRule';
import type { BoardingLock } from '../../types/boardingLock';

// #750 — 공통 게이트 단위 테스트.
// 동일 규칙(="탑승/leg 시작 직후 첫 hop이 transfer + sleep ON → suppress")이
// scheduler/FG/BG 3개 path에서 일관 적용되는지 검증한다.

const lock: BoardingLock = {
  destinationId: 'D1',
  trainCode: 'T-1',
  boardingStationId: 'S-BOARD',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 60_000,
};

describe('shouldSuppressBySleepRule', () => {
  it('transfer + sleep ON + firstHop=true → suppress', () => {
    expect(
      shouldSuppressBySleepRule({
        lock,
        event: { type: 'transfer', stationName: '교대' },
        sleepMode: true,
        isFirstHop: true,
      }),
    ).toBe(true);
  });

  it('transfer + sleep ON + firstHop=false → fire (둘째 이후 hop은 영향 없음)', () => {
    expect(
      shouldSuppressBySleepRule({
        lock,
        event: { type: 'transfer', stationName: '약수' },
        sleepMode: true,
        isFirstHop: false,
      }),
    ).toBe(false);
  });

  it('destination + sleep ON + firstHop=true → fire (destination 카테고리 영향 없음)', () => {
    expect(
      shouldSuppressBySleepRule({
        lock,
        event: { type: 'destination', stationName: '강남' },
        sleepMode: true,
        isFirstHop: true,
      }),
    ).toBe(false);
  });

  it('station-passed + sleep ON + firstHop=true → fire (station-passed 카테고리 영향 없음)', () => {
    expect(
      shouldSuppressBySleepRule({
        lock,
        event: { type: 'station-passed', stationName: '교대' },
        sleepMode: true,
        isFirstHop: true,
      }),
    ).toBe(false);
  });

  it('transfer + sleep OFF + firstHop=true → fire', () => {
    expect(
      shouldSuppressBySleepRule({
        lock,
        event: { type: 'transfer', stationName: '교대' },
        sleepMode: false,
        isFirstHop: true,
      }),
    ).toBe(false);
  });

  it('lock=null + 모든 조합 → fire (게이트는 lock 활성 시에만 의미)', () => {
    expect(
      shouldSuppressBySleepRule({
        lock: null,
        event: { type: 'transfer', stationName: '교대' },
        sleepMode: true,
        isFirstHop: true,
      }),
    ).toBe(false);
  });
});
