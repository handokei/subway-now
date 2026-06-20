import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOTIFICATION_DELIVERY_LOG_KEY } from '../../../shared/constants/storageKeys';
import {
  NOTIFICATION_DELIVERY_LOG_CAP,
  __resetDeliveryLogForTest,
  appendDeliveryEntry,
  clearDeliveryLog,
  getDeliveryEntries,
  hydrateDeliveryLog,
  type NotificationDeliveryEntry,
} from '../store/notificationDeliveryLog';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeEntry(
  overrides: Partial<NotificationDeliveryEntry> = {},
): NotificationDeliveryEntry {
  return {
    alarmId: 'a-1',
    eventKey: 'station-passed:중곡',
    surface: 'banner',
    source: 'bg-silent-push',
    result: 'delivered',
    at: 1_000,
    ...overrides,
  };
}

describe('notificationDeliveryLog (#1575)', () => {
  beforeEach(async () => {
    __resetDeliveryLogForTest();
    await AsyncStorage.clear();
  });

  it('append + read returns inserted entries', () => {
    appendDeliveryEntry(makeEntry());
    appendDeliveryEntry(makeEntry({ alarmId: 'a-2' }));
    expect(getDeliveryEntries()).toHaveLength(2);
    expect(getDeliveryEntries()[1]?.alarmId).toBe('a-2');
  });

  it('evicts oldest when buffer exceeds CAP (FIFO)', () => {
    for (let i = 0; i < NOTIFICATION_DELIVERY_LOG_CAP + 5; i += 1) {
      appendDeliveryEntry(makeEntry({ alarmId: `a-${i}` }));
    }
    const entries = getDeliveryEntries();
    expect(entries).toHaveLength(NOTIFICATION_DELIVERY_LOG_CAP);
    // oldest 5건은 evicted: a-0..a-4 가 빠지고 a-5가 첫 항목.
    expect(entries[0]?.alarmId).toBe('a-5');
    expect(entries[entries.length - 1]?.alarmId).toBe(
      `a-${NOTIFICATION_DELIVERY_LOG_CAP + 4}`,
    );
  });

  it('clearDeliveryLog clears both memory + AsyncStorage', async () => {
    appendDeliveryEntry(makeEntry());
    // persist는 fire-and-forget이라 다음 tick까지 기다린다.
    await Promise.resolve();
    expect(
      await AsyncStorage.getItem(NOTIFICATION_DELIVERY_LOG_KEY),
    ).not.toBeNull();

    await clearDeliveryLog();
    expect(getDeliveryEntries()).toHaveLength(0);
    expect(
      await AsyncStorage.getItem(NOTIFICATION_DELIVERY_LOG_KEY),
    ).toBeNull();
  });

  it('clearDeliveryLog swallows AsyncStorage errors gracefully', async () => {
    appendDeliveryEntry(makeEntry());
    const spy = jest
      .spyOn(AsyncStorage, 'removeItem')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(clearDeliveryLog()).resolves.toBeUndefined();
    // 메모리는 비워졌어야 함 (storage 실패는 graceful swallow).
    expect(getDeliveryEntries()).toHaveLength(0);
    spy.mockRestore();
  });

  it('hydrateDeliveryLog restores valid entries from AsyncStorage', async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify([
        makeEntry({ alarmId: 'a-hydrate-1' }),
        makeEntry({ alarmId: 'a-hydrate-2', result: 'suppressed' }),
      ]),
    );
    await hydrateDeliveryLog();
    expect(getDeliveryEntries().map((e) => e.alarmId)).toEqual([
      'a-hydrate-1',
      'a-hydrate-2',
    ]);
  });

  it('hydrateDeliveryLog filters invalid entries (corrupt schema)', async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify([
        makeEntry({ alarmId: 'ok' }),
        { alarmId: 'missing-fields' },
        null,
        'not-an-object',
        { ...makeEntry({ alarmId: 'bad-result' }), result: 'unknown' },
      ]),
    );
    await hydrateDeliveryLog();
    expect(getDeliveryEntries().map((e) => e.alarmId)).toEqual(['ok']);
  });

  it('hydrateDeliveryLog with non-array storage value returns empty', async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify({ not: 'an array' }),
    );
    await hydrateDeliveryLog();
    expect(getDeliveryEntries()).toHaveLength(0);
  });

  it('hydrateDeliveryLog returns empty when key absent', async () => {
    await hydrateDeliveryLog();
    expect(getDeliveryEntries()).toHaveLength(0);
  });

  it('hydrateDeliveryLog swallows JSON parse errors', async () => {
    await AsyncStorage.setItem(NOTIFICATION_DELIVERY_LOG_KEY, '{not json');
    await hydrateDeliveryLog();
    expect(getDeliveryEntries()).toHaveLength(0);
  });

  it('hydrateDeliveryLog only runs once (idempotent)', async () => {
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify([makeEntry({ alarmId: 'first' })]),
    );
    await hydrateDeliveryLog();
    // 두 번째 호출 — 메모리 buffer를 덮어쓰지 않아야 한다.
    appendDeliveryEntry(makeEntry({ alarmId: 'memory-only' }));
    await hydrateDeliveryLog();
    expect(getDeliveryEntries().map((e) => e.alarmId)).toEqual([
      'first',
      'memory-only',
    ]);
  });

  it('hydrateDeliveryLog truncates to CAP when stored array oversized', async () => {
    const oversized = Array.from({ length: NOTIFICATION_DELIVERY_LOG_CAP + 3 }, (_, i) =>
      makeEntry({ alarmId: `a-${i}` }),
    );
    await AsyncStorage.setItem(
      NOTIFICATION_DELIVERY_LOG_KEY,
      JSON.stringify(oversized),
    );
    await hydrateDeliveryLog();
    const entries = getDeliveryEntries();
    expect(entries).toHaveLength(NOTIFICATION_DELIVERY_LOG_CAP);
    expect(entries[0]?.alarmId).toBe('a-3');
  });

  it('append persists to AsyncStorage (fire-and-forget)', async () => {
    appendDeliveryEntry(makeEntry({ alarmId: 'persist-me' }));
    // setItem은 mock이라 microtask로 resolve. flush.
    await Promise.resolve();
    await Promise.resolve();
    const raw = await AsyncStorage.getItem(NOTIFICATION_DELIVERY_LOG_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as NotificationDeliveryEntry[];
    expect(parsed[0]?.alarmId).toBe('persist-me');
  });

  it('append swallows AsyncStorage setItem errors gracefully', async () => {
    const spy = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockRejectedValueOnce(new Error('quota'));
    appendDeliveryEntry(makeEntry({ alarmId: 'still-in-mem' }));
    await Promise.resolve();
    // 메모리 buffer에는 정상 추가됨.
    expect(getDeliveryEntries()[0]?.alarmId).toBe('still-in-mem');
    spy.mockRestore();
  });
});
