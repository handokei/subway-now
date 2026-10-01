import {
  PUSH_RECEIPT_BUFFER_CAPACITY,
  clearPushReceiptEntries,
  getPushReceiptEntries,
  pushPushReceiptEntry,
  subscribePushReceipt,
  type PushReceiptBufferEntry,
} from '../pushReceiptBuffer';

function makeEntry(overrides: Partial<PushReceiptBufferEntry> = {}): PushReceiptBufferEntry {
  return {
    ts: Date.now(),
    corrId: null,
    detail: {
      pushId: 'push-1',
      station: '용마산',
      kind: 'station-passed',
      pushType: 'background',
      displayed: true,
    },
    ...overrides,
  };
}

describe('pushReceiptBuffer (#2861 T1 — cycle/enter/exit과 cap 비공유)', () => {
  beforeEach(() => {
    clearPushReceiptEntries();
  });

  it('pushes and reads entries in order', () => {
    pushPushReceiptEntry(makeEntry({ ts: 1 }));
    pushPushReceiptEntry(makeEntry({ ts: 2 }));
    const entries = getPushReceiptEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(1);
    expect(entries[1].ts).toBe(2);
  });

  it('caps at PUSH_RECEIPT_BUFFER_CAPACITY, dropping oldest', () => {
    for (let i = 0; i < PUSH_RECEIPT_BUFFER_CAPACITY + 3; i += 1) {
      pushPushReceiptEntry(makeEntry({ ts: i }));
    }
    const entries = getPushReceiptEntries();
    expect(entries).toHaveLength(PUSH_RECEIPT_BUFFER_CAPACITY);
    expect(entries[0].ts).toBe(3);
  });

  it('clears entries', () => {
    pushPushReceiptEntry(makeEntry());
    clearPushReceiptEntries();
    expect(getPushReceiptEntries()).toHaveLength(0);
  });

  it('notifies subscribers on push and unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribePushReceipt(listener);
    pushPushReceiptEntry(makeEntry());
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    pushPushReceiptEntry(makeEntry());
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
