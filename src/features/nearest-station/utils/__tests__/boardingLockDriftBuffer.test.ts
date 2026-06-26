/**
 * #1896 (RC-8) — boarding-lock GPS displacement gate trigger 전용 buffer 단위 테스트.
 *
 * 검증:
 *   1. push/get — positionTrain / arvlCdArrived branch 양쪽 + driftMeters null 케이스
 *   2. clear — entries 비움
 *   3. subscribe — push/clear 시 listener 호출, unsubscribe 후 호출 안 됨
 *   4. cap=BOARDING_LOCK_DRIFT_BUFFER_CAPACITY ring buffer overwrite (점령 회귀 차단)
 */
import {
  BOARDING_LOCK_DRIFT_BUFFER_CAPACITY,
  clearBoardingLockDriftEntries,
  getBoardingLockDriftEntries,
  pushBoardingLockDriftEntry,
  subscribeBoardingLockDrift,
  type BoardingLockDriftEntry,
} from '../boardingLockDriftBuffer';

function makeEntry(overrides: Partial<BoardingLockDriftEntry> = {}): BoardingLockDriftEntry {
  return {
    kind: 'boarding-lock-drift',
    ts: 1_700_000_000_000,
    branch: 'positionTrain',
    lockStationName: '동대문역사문화공원',
    lockStationLine: '2',
    driftMeters: 1020,
    ...overrides,
  };
}

describe('boardingLockDriftBuffer (#1896 RC-8)', () => {
  beforeEach(() => {
    clearBoardingLockDriftEntries();
  });

  it('pushes entries in order and exposes branch + driftMeters fields', () => {
    pushBoardingLockDriftEntry(makeEntry({ branch: 'positionTrain', driftMeters: 1020 }));
    pushBoardingLockDriftEntry(
      makeEntry({
        ts: 1_700_000_001_000,
        branch: 'arvlCdArrived',
        lockStationName: '신당',
        driftMeters: null, // GPS 없는 케이스 (타입 안정 분기)
      }),
    );
    const entries = getBoardingLockDriftEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('boarding-lock-drift');
    expect(entries[0].branch).toBe('positionTrain');
    expect(entries[0].driftMeters).toBe(1020);
    expect(entries[1].branch).toBe('arvlCdArrived');
    expect(entries[1].driftMeters).toBeNull();
  });

  it('clears entries', () => {
    pushBoardingLockDriftEntry(makeEntry());
    clearBoardingLockDriftEntries();
    expect(getBoardingLockDriftEntries()).toHaveLength(0);
  });

  it('caps at BOARDING_LOCK_DRIFT_BUFFER_CAPACITY, dropping oldest', () => {
    for (let i = 0; i < BOARDING_LOCK_DRIFT_BUFFER_CAPACITY + 3; i++) {
      pushBoardingLockDriftEntry(makeEntry({ ts: i, lockStationName: `S${i}` }));
    }
    const entries = getBoardingLockDriftEntries();
    expect(entries).toHaveLength(BOARDING_LOCK_DRIFT_BUFFER_CAPACITY);
    // 가장 오래된 3개(S0/S1/S2)는 evict, 가장 오래된 잔존 entry는 S3.
    expect(entries[0].lockStationName).toBe('S3');
  });

  it('notifies subscribers on push and clear, unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribeBoardingLockDrift(listener);
    pushBoardingLockDriftEntry(makeEntry());
    expect(listener).toHaveBeenCalledTimes(1);
    pushBoardingLockDriftEntry(makeEntry({ ts: 2 }));
    expect(listener).toHaveBeenCalledTimes(2);
    clearBoardingLockDriftEntries();
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
    pushBoardingLockDriftEntry(makeEntry({ ts: 3 }));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
