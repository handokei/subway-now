/**
 * #2152 — BoardingLock lifecycle breadcrumb 전용 buffer 단위 테스트.
 *
 * 검증:
 *   1. push/get — create/release 엔트리 양쪽
 *   2. clear — entries 비움
 *   3. subscribe — push/clear 시 listener 호출, unsubscribe 후 호출 안 됨
 *   4. cap=BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY ring buffer overwrite (점령 회귀 차단)
 */
import {
  BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY,
  clearLockLifecycleEntries,
  getLockLifecycleEntries,
  pushLockLifecycleEntry,
  subscribeLockLifecycle,
  type LockLifecycleEntry,
} from '../boardingLockLifecycleBuffer';

function makeCreateEntry(
  overrides: Partial<LockLifecycleEntry> = {},
): LockLifecycleEntry {
  return {
    kind: 'boarding-lock-lifecycle',
    event: 'create',
    ts: 1_700_000_000_000,
    source: 'user-tap',
    trainCode: 'T-100',
    line: '2',
    stationId: 'stn-A',
    ...overrides,
  } as LockLifecycleEntry;
}

function makeReleaseEntry(
  overrides: Partial<LockLifecycleEntry> = {},
): LockLifecycleEntry {
  return {
    kind: 'boarding-lock-lifecycle',
    event: 'release',
    ts: 1_700_000_001_000,
    reason: 'user',
    trainCode: 'T-100',
    line: '2',
    ...overrides,
  } as LockLifecycleEntry;
}

describe('boardingLockLifecycleBuffer (#2152)', () => {
  beforeEach(() => {
    clearLockLifecycleEntries();
  });

  it('pushes create/release entries in order and exposes fields', () => {
    pushLockLifecycleEntry(makeCreateEntry({ source: 'boarding-prompt-response' }));
    pushLockLifecycleEntry(makeReleaseEntry({ reason: 'vanish' }));
    const entries = getLockLifecycleEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('boarding-lock-lifecycle');
    expect(entries[0].event).toBe('create');
    expect((entries[0] as { source: string }).source).toBe('boarding-prompt-response');
    expect(entries[1].event).toBe('release');
    expect((entries[1] as { reason: string }).reason).toBe('vanish');
  });

  it('clears entries', () => {
    pushLockLifecycleEntry(makeCreateEntry());
    clearLockLifecycleEntries();
    expect(getLockLifecycleEntries()).toHaveLength(0);
  });

  it('caps at BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY, dropping oldest', () => {
    for (let i = 0; i < BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY + 3; i++) {
      pushLockLifecycleEntry(makeCreateEntry({ ts: i, trainCode: `T-${i}` }));
    }
    const entries = getLockLifecycleEntries();
    expect(entries).toHaveLength(BOARDING_LOCK_LIFECYCLE_BUFFER_CAPACITY);
    // 가장 오래된 3개(T-0/T-1/T-2)는 evict, 가장 오래된 잔존 entry는 T-3.
    expect((entries[0] as { trainCode: string }).trainCode).toBe('T-3');
  });

  it('notifies subscribers on push and clear, unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribeLockLifecycle(listener);
    pushLockLifecycleEntry(makeCreateEntry());
    expect(listener).toHaveBeenCalledTimes(1);
    pushLockLifecycleEntry(makeReleaseEntry());
    expect(listener).toHaveBeenCalledTimes(2);
    clearLockLifecycleEntries();
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
    pushLockLifecycleEntry(makeCreateEntry({ ts: 3 }));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
