import {
  BOARDING_LOCK_EXPIRY_FACTOR,
  isBoardingLockExpired,
  type BoardingLock,
} from '../boardingLock';

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'T-100',
    boardingStationId: 'stn-A',
    boardingLine: '2',
    boardedAt: 1_000_000,
    expectedDurationMs: 600_000, // 10분
    ...overrides,
  };
}

describe('isBoardingLockExpired', () => {
  it('boardedAt 이전 시각이면 만료 아님 (defensive)', () => {
    const lock = makeLock();
    expect(isBoardingLockExpired(lock, lock.boardedAt - 1)).toBe(false);
  });

  it('expectedDurationMs 미만 경과면 만료 아님', () => {
    const lock = makeLock();
    expect(isBoardingLockExpired(lock, lock.boardedAt + lock.expectedDurationMs)).toBe(false);
  });

  it('expectedDurationMs × 1.5 = expiry 경계 (정확히 같으면 아직 만료 아님)', () => {
    const lock = makeLock();
    const boundary = lock.boardedAt + lock.expectedDurationMs * BOARDING_LOCK_EXPIRY_FACTOR;
    expect(isBoardingLockExpired(lock, boundary)).toBe(false);
    expect(isBoardingLockExpired(lock, boundary + 1)).toBe(true);
  });
});
