import {
  arcIndexOfStation,
  interpolateBoardingLockStation,
} from '../boardingLockInterpolation';
import { HOP_TIME_MS } from '../../constants/boardingLock';
import type { BoardingLock } from '../../types/boardingLock';
import type { Station } from '../../types/station';

const ARC: Station[] = [
  { id: '7-001', name: '용마산', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-002', name: '중곡', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-003', name: '군자', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-004', name: '어린이대공원', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: '7-005', name: '건대입구', line: '7', lineColor: '#x', lat: 0, lng: 0 },
];

const T0 = 1_700_000_000_000;

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: '2-011',
    trainCode: '7093',
    boardingStationId: '7-001',
    boardingLine: '7',
    boardedAt: T0,
    expectedDurationMs: 10 * 60 * 1000,
    ...overrides,
  };
}

describe('interpolateBoardingLockStation', () => {
  it('lock null이면 null', () => {
    expect(interpolateBoardingLockStation({ lock: null, arcStations: ARC, now: T0 })).toBeNull();
  });

  it('arcStations 비면 null', () => {
    expect(
      interpolateBoardingLockStation({ lock: makeLock(), arcStations: [], now: T0 }),
    ).toBeNull();
  });

  it('boardingStationId가 arc에 없으면 null', () => {
    expect(
      interpolateBoardingLockStation({
        lock: makeLock({ boardingStationId: '9-999' }),
        arcStations: ARC,
        now: T0,
      }),
    ).toBeNull();
  });

  it('lock 만료면 null (expectedDurationMs * 1.5 초과)', () => {
    const lock = makeLock({ expectedDurationMs: 60_000 });
    const expired = T0 + 60_000 * 1.5 + 1;
    expect(
      interpolateBoardingLockStation({ lock, arcStations: ARC, now: expired }),
    ).toBeNull();
  });

  it('경과 시간이 음수(시계 후진)면 null', () => {
    expect(
      interpolateBoardingLockStation({
        lock: makeLock(),
        arcStations: ARC,
        now: T0 - 1,
      }),
    ).toBeNull();
  });

  it('탑승 직후(elapsed=0)는 boarding station 반환', () => {
    const r = interpolateBoardingLockStation({ lock: makeLock(), arcStations: ARC, now: T0 });
    expect(r).toEqual({ station: ARC[0], index: 0 });
  });

  it('1 hop 경과 시 다음 역', () => {
    const r = interpolateBoardingLockStation({
      lock: makeLock(),
      arcStations: ARC,
      now: T0 + HOP_TIME_MS,
    });
    expect(r).toEqual({ station: ARC[1], index: 1 });
  });

  it('3 hop 경과 — 중간 역', () => {
    const r = interpolateBoardingLockStation({
      lock: makeLock(),
      arcStations: ARC,
      now: T0 + 3 * HOP_TIME_MS,
    });
    expect(r).toEqual({ station: ARC[3], index: 3 });
  });

  it('arc 끝을 넘는 경과 시간 — 마지막 역으로 cap (만료 전)', () => {
    // expectedDurationMs를 충분히 크게 잡아 만료 가드(*1.5)에 안 걸리게 한다.
    const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
    const r = interpolateBoardingLockStation({
      lock,
      arcStations: ARC,
      now: T0 + (ARC.length - 1 + 1) * HOP_TIME_MS,
    });
    expect(r).toEqual({ station: ARC[4], index: 4 });
  });

  it('종착역 cap 후 OVER_TERMINAL_GRACE_HOPS(2) 초과 → null (영구 고정 회피)', () => {
    const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
    // ARC length 5, boardingIdx=0 → lastIdx=4. hopsElapsed=7 > 4+2 → null.
    const r = interpolateBoardingLockStation({
      lock,
      arcStations: ARC,
      now: T0 + 7 * HOP_TIME_MS,
    });
    expect(r).toBeNull();
  });

  it('종착역 cap 후 grace hop(2) 이내는 종착역 유지', () => {
    const lock = makeLock({ expectedDurationMs: 100 * HOP_TIME_MS });
    // hopsElapsed=6, lastIdx=4, lastIdx+grace=6 → cap된 종착역 반환
    const r = interpolateBoardingLockStation({
      lock,
      arcStations: ARC,
      now: T0 + 6 * HOP_TIME_MS,
    });
    expect(r).toEqual({ station: ARC[4], index: 4 });
  });

  it('boardingStationId가 중간이면 그 위치 기준으로 hop 추가', () => {
    const r = interpolateBoardingLockStation({
      lock: makeLock({ boardingStationId: '7-003' }),
      arcStations: ARC,
      now: T0 + HOP_TIME_MS,
    });
    expect(r).toEqual({ station: ARC[3], index: 3 });
  });
});

describe('arcIndexOfStation', () => {
  it('null 입력 시 -1', () => {
    expect(arcIndexOfStation(ARC, null)).toBe(-1);
    expect(arcIndexOfStation(ARC, undefined)).toBe(-1);
  });

  it('arc에 있는 station이면 인덱스 반환', () => {
    expect(arcIndexOfStation(ARC, ARC[2])).toBe(2);
  });

  it('arc에 없는 station이면 -1', () => {
    expect(
      arcIndexOfStation(ARC, { id: 'x', name: 'x', line: '1', lineColor: '', lat: 0, lng: 0 }),
    ).toBe(-1);
  });
});
