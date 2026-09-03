/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { useBoardingLockSync, GOOD_FIX_ACCURACY_MAX_M, SYNC_DEBOUNCE_MS } from '../useBoardingLockSync';
import { syncBoardingLock } from '../../../nearest-station/api/boardingLockSync';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('../../../nearest-station/api/boardingLockSync', () => ({
  syncBoardingLock: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockedSync = syncBoardingLock as jest.MockedFunction<typeof syncBoardingLock>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(APNS_TOKEN_KEY, 'apns-tok');
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-tok');
  mockedSync.mockResolvedValue({ ok: true, advanced: true, currentWaypoint: '역삼', nextStation: '역삼' });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushAsyncStorage(): Promise<void> {
  // AsyncStorage getItem은 microtask 큐로 처리 — fake timers 사용 중에도 promise를 흘려보낸다.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useBoardingLockSync (#901)', () => {
  type SyncInputs = Parameters<typeof useBoardingLockSync>[0];
  const defaults: SyncInputs = { currentStationName: '강남', accuracyMeters: 10, tripActive: true };
  const renderSync = (overrides: Partial<SyncInputs> = {}) =>
    renderHook(() => useBoardingLockSync({ ...defaults, ...overrides }));

  it.each<{ label: string; overrides: Partial<SyncInputs> }>([
    { label: 'tripActive=false', overrides: { tripActive: false } },
    { label: 'currentStationName=null', overrides: { currentStationName: null } },
    { label: 'accuracy=null', overrides: { accuracyMeters: null } },
    { label: 'accuracy > 50m', overrides: { accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 1 } },
  ])('게이트 실패 ($label) → debounce 후에도 미발사', async ({ overrides }) => {
    renderSync(overrides);
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('좋은 fix + 새 station → debounce 후 1회 발사', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    // debounce 도달 전엔 미발사
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
    // debounce 경과 후 발사
    act(() => jest.advanceTimersByTime(200));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        token: 'apns-tok',
        observedStationName: '강남',
        accuracy: 10,
      }),
    );
  });

  it('debounce 안에서 station 다시 바뀌면 timer reset → 1회만 발사', async () => {
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 1000));
    rerender({ station: '역삼' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(200));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0].observedStationName).toBe('역삼');
  });

  it('같은 station 재발사 안 함 (lastSentStation 기억)', async () => {
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ station: '강남' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 변경 → debounce 우회 즉시 발사', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string | null }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: null as string | null } },
    );
    expect(mockedSync).not.toHaveBeenCalled();
    rerender({ key: 'trip-created' });
    await flushAsyncStorage();
    // debounce 경과 없이도 발사됐어야 함
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('같은 forceTriggerKey 재전달 → 재발사 안 함', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: 'k1' } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ key: 'k1' });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 다른 값 → 재발사', async () => {
    const { rerender } = renderHook(
      ({ key }: { key: string }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          forceTriggerKey: key,
        }),
      { initialProps: { key: 'k1' } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    rerender({ key: 'k2' });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(2);
  });

  it.each<{ label: string; overrides: Partial<SyncInputs> }>([
    { label: 'currentStation null', overrides: { currentStationName: null } },
    { label: 'accuracy null', overrides: { accuracyMeters: null } },
    { label: 'accuracy > 50m', overrides: { accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 1 } },
    { label: 'tripActive=false', overrides: { tripActive: false } },
  ])('force 트리거지만 $label → 발사 안 함', async ({ overrides }) => {
    renderSync({ forceTriggerKey: 'k', ...overrides });
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it.each<{ label: string; key: typeof APNS_TOKEN_KEY | typeof ACTIVE_TRIP_KEY }>([
    { label: 'APNs 토큰', key: APNS_TOKEN_KEY },
    { label: 'ACTIVE_TRIP_KEY', key: ACTIVE_TRIP_KEY },
  ])('$label 없으면 graceful skip', async ({ key }) => {
    await AsyncStorage.removeItem(key);
    renderSync();
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it('subsurface 옵션 전달', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
        subsurface: false,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedSync.mock.calls[0][0].subsurface).toBe(false);
  });

  it('같은 station이지만 다른 dep(accuracy) 변경 시 — 재발사 안 함 (lastSentStation 게이트)', async () => {
    const { rerender } = renderHook(
      ({ acc }: { acc: number }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: acc,
          tripActive: true,
        }),
      { initialProps: { acc: 10 } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // accuracy만 바뀌어 effect 재실행되지만 같은 station → lastSentStation 게이트로 발사 안 함
    rerender({ acc: 20 });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('forceTriggerKey 발사 후 다른 dep만 변경 → lastForceKey 게이트로 재발사 안 함', async () => {
    const { rerender } = renderHook(
      ({ acc }: { acc: number }) =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: acc,
          tripActive: true,
          forceTriggerKey: 'k1',
        }),
      { initialProps: { acc: 10 } },
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // accuracy만 바뀌어 force effect 재실행. forceTriggerKey 동일 → 발사 안 함.
    rerender({ acc: 20 });
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('backend 응답에 advanced/currentWaypoint 누락 → log fallback (?? 분기 커버)', async () => {
    mockedSync.mockResolvedValueOnce({ ok: true });
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it('force 트리거 + station 동시 변경 — 중복 발사 차단 (race 가드)', async () => {
    // 같은 mount에서 forceTriggerKey와 station이 동시에 활성 — effect 2가 즉시 발사하고,
    // effect 1의 5s timer는 lastSentStation 동기 set 덕에 fireSync 호출 skip해야 함.
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
        forceTriggerKey: 'k1',
      }),
    );
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    // debounce 만료 — 이미 lastSentStation이 set돼 있어 추가 발사 없어야 함.
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  // #2352 — 구 #915/#916 onAutoLockCandidate 무탭 hydrate 채널은 삭제됐다. 옵션 자체가 더 이상
  // 존재하지 않으므로, backend 응답에 (구버전/캐시 등으로) autoLockCandidate가 섞여 와도 아무
  // 콜백도 없이 graceful하게 무시되는지 확인 — RED였던 "탭 없이 lock 생성"이 이제 발생 불가함을
  // 회귀 방지 차원에서 명시.
  it('#2352 — 응답에 autoLockCandidate가 섞여 있어도 콜백 채널 자체가 없어 무시(throw 없음)', async () => {
    mockedSync.mockResolvedValueOnce({
      ok: true,
      advanced: false,
      currentWaypoint: '역삼',
      nextStation: '역삼',
      // @ts-expect-error — 구버전 backend 잔존 필드 시뮬레이션. 현재 응답 타입엔 없다.
      autoLockCandidate: { trainCode: 'AUTO-7', line: '2', subwayId: '1002' },
    });
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
    await expect(flushAsyncStorage()).resolves.toBeUndefined();
  });

  // D4 (#1210) — 활성 lock trainCode/line forward + 환승 leg trainCode 변경 시 재발사.
  describe('boardingLock trainCode/line forward (#1210)', () => {
    // 단일 렌더 + debounce 또는 force 발사 케이스 3건을 1 시나리오 1 케이스로 일괄 검증.
    // 각 케이스는 옵션 셋과 expectedPayloadFields, expectedAbsent를 명시한다.
    it.each<{
      label: string;
      options: Partial<Parameters<typeof useBoardingLockSync>[0]>;
      expectedFields: Record<string, string> | null;
      expectedAbsent: ReadonlyArray<string>;
    }>([
      {
        label: 'trainCode + line 제공 → payload에 forward',
        options: { boardingLockTrainCode: 'T-1', boardingLockLine: '2' },
        expectedFields: { trainCode: 'T-1', boardingLine: '2' },
        expectedAbsent: [],
      },
      {
        label: 'trainCode/line null → payload에 미포함',
        options: { boardingLockTrainCode: null, boardingLockLine: null },
        expectedFields: null,
        expectedAbsent: ['trainCode', 'boardingLine'],
      },
      {
        label: 'force-trigger 경로도 trainCode/line forward',
        options: {
          forceTriggerKey: 'k1',
          boardingLockTrainCode: 'T-FORCE',
          boardingLockLine: '9',
        },
        expectedFields: { trainCode: 'T-FORCE', boardingLine: '9' },
        expectedAbsent: [],
      },
    ])('$label', async ({ options, expectedFields, expectedAbsent }) => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          ...options,
        }),
      );
      // force-trigger 케이스는 debounce 우회 → advance 호출도 영향 없음 (timer 미설정).
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      const sent = mockedSync.mock.calls[0][0];
      if (expectedFields) {
        expect(sent).toEqual(expect.objectContaining(expectedFields));
      }
      for (const key of expectedAbsent) {
        expect(sent).not.toHaveProperty(key);
      }
    });

    it('같은 station + trainCode 변경 → debounce 후 재발사', async () => {
      const { rerender } = renderHook(
        ({ tc }: { tc: string | null }) =>
          useBoardingLockSync({
            currentStationName: '건대입구',
            accuracyMeters: 10,
            tripActive: true,
            boardingLockTrainCode: tc,
            boardingLockLine: tc === 'T-1' ? '2' : '7',
          }),
        { initialProps: { tc: 'T-1' as string | null } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      expect(mockedSync.mock.calls[0][0].trainCode).toBe('T-1');
      // 환승 leg simulation — 같은 환승역에서 lock이 새 trainCode로 교체됨.
      rerender({ tc: 'T-2' });
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(2);
      expect(mockedSync.mock.calls[1][0]).toEqual(
        expect.objectContaining({ trainCode: 'T-2', boardingLine: '7' }),
      );
    });

    it('같은 station + 같은 trainCode → 재발사 안 함', async () => {
      const { rerender } = renderHook(
        ({ tc }: { tc: string }) =>
          useBoardingLockSync({
            currentStationName: '강남',
            accuracyMeters: 10,
            tripActive: true,
            boardingLockTrainCode: tc,
          }),
        { initialProps: { tc: 'T-1' } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      rerender({ tc: 'T-1' });
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
    });

    // #2407 sentinel leak (신규) — buildBoardingLockMeta는 pending sentinel을 이미 걸러내지만
    // /boarding-lock/sync 경로(fireSync)는 동일 가드가 없어 PENDING-TRAIN-CODE가 그대로
    // payload.trainCode로 나간다. backend가 이 sentinel로 실시간 API를 조회하면 못 찾아
    // 정상 trainCode를 덮어쓰는 회귀 — payload에서 반드시 생략돼야 한다.
    it('#2407 — boardingLockTrainCode가 PENDING 센티넬이면 payload에서 trainCode 생략', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: 10,
          tripActive: true,
          boardingLockTrainCode: 'PENDING-TRAIN-CODE',
          boardingLockLine: '2',
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      const sent = mockedSync.mock.calls[0][0];
      expect(sent).not.toHaveProperty('trainCode');
      // line은 trainCode 없이는 backend에서 무시되지만(D4 주석), sentinel 자체가 노선 정보로
      // 오인되지 않도록 함께 생략한다.
      expect(sent).not.toHaveProperty('boardingLine');
    });

    it('tripActive false → true 전환 시 trainCode dedup ref도 reset', async () => {
      const { rerender } = renderHook(
        ({ active }: { active: boolean }) =>
          useBoardingLockSync({
            currentStationName: '강남',
            accuracyMeters: 10,
            tripActive: active,
            boardingLockTrainCode: 'T-1',
          }),
        { initialProps: { active: true } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      // trip 종료.
      rerender({ active: false });
      // trip 재시작 — 같은 station/trainCode면서 첫 sync는 다시 나가야 함.
      rerender({ active: true });
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(2);
    });
  });

  // #1286 — WiFi SSID 확정 역(stationFromWifi=true)은 accuracy>50m 게이트 우회.
  describe('stationFromWifi accuracy 게이트 우회 (#1286)', () => {
    it('stationFromWifi=true + accuracy>50m → debounce 후 발사 (게이트 우회)', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '용마산',
          accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 150,
          tripActive: true,
          stationFromWifi: true,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      expect(mockedSync.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          observedStationName: '용마산',
          accuracy: GOOD_FIX_ACCURACY_MAX_M + 150,
        }),
      );
    });

    it('stationFromWifi=true + force-trigger + accuracy>50m → 즉시 발사 (게이트 우회)', async () => {
      const { rerender } = renderHook(
        ({ key }: { key: string | null }) =>
          useBoardingLockSync({
            currentStationName: '용마산',
            accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 150,
            tripActive: true,
            stationFromWifi: true,
            forceTriggerKey: key,
          }),
        { initialProps: { key: null as string | null } },
      );
      expect(mockedSync).not.toHaveBeenCalled();
      rerender({ key: 'wifi-underground' });
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
    });

    it('stationFromWifi=false(GPS 역) + accuracy>50m → 미발사 (게이트 유지)', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '강남',
          accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 150,
          tripActive: true,
          stationFromWifi: false,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).not.toHaveBeenCalled();
    });

    it('stationFromWifi=true + accuracy=null → 여전히 미발사 (관측 부재)', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '용마산',
          accuracyMeters: null,
          tripActive: true,
          stationFromWifi: true,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).not.toHaveBeenCalled();
    });
  });

  it('debounce timer cleanup — unmount 시 미발사', async () => {
    const { unmount } = renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS - 1000));
    unmount();
    act(() => jest.advanceTimersByTime(2000));
    await flushAsyncStorage();
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
