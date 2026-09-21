/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import {
  useBoardingLockSync,
  GOOD_FIX_ACCURACY_MAX_M,
  SYNC_DEBOUNCE_MS,
  __resetFireSync404GuardForTests,
} from '../useBoardingLockSync';
import { syncBoardingLock } from '../../../nearest-station/api/boardingLockSync';
import { resetAlarmBackendDedup } from '../../api/alarmBackend';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import {
  LOCK_ONLY_SYNC_ACCURACY_METERS,
  LOCK_SYNC_RETRY_BACKOFF_MS,
} from '../../../../shared/constants/boardingLock';
import { logLockSyncDelivery } from '../../utils/alarmLog';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

jest.mock('../../../nearest-station/api/boardingLockSync', () => ({
  syncBoardingLock: jest.fn(),
}));

// #2699 (리뷰 지적, PR #2789 "각도 C") — 404 self-heal wire 검증용.
jest.mock('../../api/alarmBackend', () => ({
  resetAlarmBackendDedup: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// #2709 — lock-identity 계측 채널을 spy로 격리. AsyncStorage 실 mock을 통한 alarmLog ring buffer
// round-trip은 다른 스위트(alarmLog.test.ts)에서 검증되므로 여기선 호출 자체만 확인한다.
jest.mock('../../utils/alarmLog', () => ({
  logLockSyncDelivery: jest.fn(),
}));

const mockedSync = syncBoardingLock as jest.MockedFunction<typeof syncBoardingLock>;
const mockedLogLockSyncDelivery = logLockSyncDelivery as jest.MockedFunction<typeof logLockSyncDelivery>;
const mockedResetAlarmBackendDedup = resetAlarmBackendDedup as jest.MockedFunction<typeof resetAlarmBackendDedup>;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(APNS_TOKEN_KEY, 'apns-tok');
  await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'trip-tok');
  mockedSync.mockResolvedValue({ ok: true, advanced: true, currentWaypoint: '역삼', nextStation: '역삼' });
  jest.useFakeTimers();
  // #2699 (리뷰 지적, 항목 3) — 404 churn 가드는 모듈 레벨 state라 테스트 간 격리 필요.
  __resetFireSync404GuardForTests();
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

  // #2699 (리뷰 지적, PR #2789 "각도 C" 최우선) — 이 파일의 원래 docstring이 "404 →
  // useApnsTripRegistration이 다음 cycle에 재등록"이라 주장했지만 명시 wire가 없었다.
  // #2699가 register dedup hash에서 시간종속 alarmBucket을 제거하면서, 그 재등록을
  // 우연히 가능케 했던 hash 회전도 함께 사라진다 — 명시 wire 없이는 backend가 trip을
  // 잃어도 device가 영원히 모른 채 dedup-skip만 반복한다.
  it('#2699 sync 응답이 404(trip_not_found)면 alarmBackend dedup을 리셋한다 — 다음 register가 skip 아니라 실 POST로 이어지게', async () => {
    mockedSync.mockResolvedValueOnce({ ok: false, status: 404 });
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(1);
  });

  // #2699 (리뷰 지적, PR #2789 리뷰 2라운드 — 항목 3) — 지속 장애(backend가 계속 404를
  // 돌려주는 상태) 시나리오. 매 station-change마다 무조건 리셋하면 다음 register가 매번
  // dedup skip을 우회해 죽어가는 backend에 POST가 계속 쌓인다 — reset 자체가 상한 없이
  // 반복되면 안 된다.
  it('#2699 같은 token에 연속 404 × N → resetAlarmBackendDedup은 상한(1회)만 호출된다', async () => {
    mockedSync.mockResolvedValue({ ok: false, status: 404 });
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(1);

    // 서로 다른 station으로 계속 전환 — 매번 새 sync가 발사되지만(같은 station dedup과
    // 무관) 여전히 backend는 404. reset은 최초 1회에서 상한 도달.
    for (const station of ['역삼', '선릉', '삼성']) {
      rerender({ station });
      // eslint-disable-next-line no-await-in-loop -- 실제 station-change 순서가 본질적.
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
      // eslint-disable-next-line no-await-in-loop -- 위와 동일한 이유.
      await flushAsyncStorage();
    }
    expect(mockedSync).toHaveBeenCalledTimes(4); // sync 자체는 매번 발사.
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(1); // reset은 상한 1회.
  });

  it('#2699 404 리셋 이후 sync가 성공(회복)하면, 다음 404 에피소드에서 다시 리셋할 수 있다', async () => {
    mockedSync.mockResolvedValueOnce({ ok: false, status: 404 });
    const { rerender } = renderHook(
      ({ station }: { station: string }) =>
        useBoardingLockSync({
          currentStationName: station,
          accuracyMeters: 10,
          tripActive: true,
        }),
      { initialProps: { station: '강남' } },
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(1);

    // 회복 — sync 성공.
    mockedSync.mockResolvedValueOnce({ ok: true, advanced: true, currentWaypoint: '역삼', nextStation: '역삼' });
    rerender({ station: '역삼' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(1); // 성공 사이클엔 추가 리셋 없음.

    // 새 404 에피소드 — latch가 풀렸으므로 다시 리셋돼야 한다.
    mockedSync.mockResolvedValueOnce({ ok: false, status: 404 });
    rerender({ station: '선릉' });
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedResetAlarmBackendDedup).toHaveBeenCalledTimes(2);
  });

  it('#2699 sync 응답이 404가 아닌 실패(예: 500)면 dedup을 건드리지 않는다 — trip 손실 신호가 아니므로', async () => {
    mockedSync.mockResolvedValueOnce({ ok: false, status: 500 });
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedResetAlarmBackendDedup).not.toHaveBeenCalled();
  });

  it('#2699 sync 성공(ok:true)이면 dedup을 건드리지 않는다', async () => {
    renderHook(() =>
      useBoardingLockSync({
        currentStationName: '강남',
        accuracyMeters: 10,
        tripActive: true,
      }),
    );
    act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS));
    await flushAsyncStorage();
    expect(mockedSync).toHaveBeenCalledTimes(1);
    expect(mockedResetAlarmBackendDedup).not.toHaveBeenCalled();
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

  // #2709 — lock 신원 → backend 전달 경로 통합. GPS 상태와 무관하게 발동, 실패 시 재시도,
  // station 관측과는 필드 단위로 게이트가 분리됨을 검증.
  describe('#2709 lock identity — GPS 무관 통합 경로', () => {
    const boardingStationId = '2-022'; // stations.json 강남(2호선) — 실 lookup 대상.
    const boardingStationName = canonicalStationName('강남', '2');

    it('red 재현 조건(GPS accuracyMeters==null + currentStationName null) + lock 존재 → boarding station fallback anchor로 발사', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      const sent = mockedSync.mock.calls[0][0];
      expect(sent.observedStationName).toBe(boardingStationName);
      expect(sent.accuracy).toBe(LOCK_ONLY_SYNC_ACCURACY_METERS);
      expect(sent.trainCode).toBe('7246');
      expect(sent.boardingLine).toBe('2');
      expect(mockedLogLockSyncDelivery).toHaveBeenCalledWith({ outcome: 'attempt' });
      expect(mockedLogLockSyncDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success' }),
      );
    });

    it('red 재현 조건(accuracy > 50m, GPS 신뢰 불가) + lock 존재 → 여전히 boarding station fallback으로 발사(station 게이트와 독립)', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: '사가정', // GPS가 잡았지만 신뢰 불가 — advance 오염 방지 위해 미사용.
          accuracyMeters: GOOD_FIX_ACCURACY_MAX_M + 200,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '7',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      const sent = mockedSync.mock.calls[0][0];
      // 신뢰 불가 GPS station('사가정')이 아니라 lock의 boarding station이 나가야 한다.
      expect(sent.observedStationName).toBe(boardingStationName);
      expect(sent.accuracy).toBe(LOCK_ONLY_SYNC_ACCURACY_METERS);
    });

    it('전달 성공 시 lock.boardedAt으로부터 경과 초(delaySeconds)를 계측', async () => {
      const boardedAt = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(boardedAt + 12_000);
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
          boardingLockBoardedAt: boardedAt,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedLogLockSyncDelivery).toHaveBeenCalledWith({
        outcome: 'success',
        delaySeconds: 12,
      });
      (Date.now as jest.Mock).mockRestore();
    });

    it('boarding station lookup 실패(존재하지 않는 id) + GPS도 없으면 시도 자체가 불가 — blocked 계측, POST 없음', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: '__no_such_station_id__',
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).not.toHaveBeenCalled();
      expect(mockedLogLockSyncDelivery).toHaveBeenCalledWith({ outcome: 'blocked' });
      expect(mockedLogLockSyncDelivery).not.toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'attempt' }),
      );
    });

    it('POST 실패 시 backoff 재시도 — 재시도에서 성공하면 delivered로 확정', async () => {
      mockedSync
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, advanced: false, currentWaypoint: null });
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);

      // 재시도 backoff 전에는 추가 호출 없음.
      act(() => jest.advanceTimersByTime(LOCK_SYNC_RETRY_BACKOFF_MS[0] - 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);

      // backoff 경과 → 재시도 발사, 성공.
      act(() => jest.advanceTimersByTime(200));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(2);
      expect(mockedLogLockSyncDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success' }),
      );
    });

    it('스케줄 fallback(SCHED-*) / pending sentinel trainCode는 lock 신원 전달 대상에서 제외(GPS 없으면 완전 무발사)', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: 'SCHED-UP-1',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).not.toHaveBeenCalled();
    });

    it('회귀 — route/destination 변경과 무관, forceTriggerKey 경로도 lock identity fallback을 동일하게 지원', async () => {
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          forceTriggerKey: 'register-done',
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
      const sent = mockedSync.mock.calls[0][0];
      expect(sent.observedStationName).toBe(boardingStationName);
      expect(sent.trainCode).toBe('7246');
    });

    it('재시도 상한(LOCK_SYNC_RETRY_MAX_ATTEMPTS) 도달 시 추가 재시도 없이 중단', async () => {
      mockedSync.mockResolvedValue({ ok: false });
      renderHook(() =>
        useBoardingLockSync({
          currentStationName: null,
          accuracyMeters: null,
          tripActive: true,
          boardingLockTrainCode: '7246',
          boardingLockLine: '2',
          boardingLockBoardingStationId: boardingStationId,
        }),
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 최초 시도(항상 실패)

      // backoff 3단계를 모두 소진 — 매번 실패하므로 재시도마다 1회씩 추가.
      for (const backoffMs of LOCK_SYNC_RETRY_BACKOFF_MS) {
        act(() => jest.advanceTimersByTime(backoffMs + 100));
        await flushAsyncStorage();
      }
      expect(mockedSync).toHaveBeenCalledTimes(1 + LOCK_SYNC_RETRY_BACKOFF_MS.length);

      // 상한 도달 후 추가 시간이 지나도 더 이상 재시도하지 않음.
      act(() => jest.advanceTimersByTime(60_000));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1 + LOCK_SYNC_RETRY_BACKOFF_MS.length);
    });

    it('재시도 대기 중 lock이 pending sentinel로 전환되면 재시도 시점에 조용히 중단(usable 아님)', async () => {
      mockedSync.mockResolvedValueOnce({ ok: false });
      const { rerender } = renderHook(
        ({ tc }: { tc: string }) =>
          useBoardingLockSync({
            currentStationName: null,
            accuracyMeters: null,
            tripActive: true,
            boardingLockTrainCode: tc,
            boardingLockLine: '2',
            boardingLockBoardingStationId: boardingStationId,
          }),
        { initialProps: { tc: '7246' } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 실패 — 재시도 armed

      // 대기 중 lock이 pending fallback으로 전환(예: 환승 중 trainCode 미확정) — 새 effect run은
      // hasUsableLockIdentity=false + GPS도 없어 자체적으로는 아무 것도 발사하지 않는다.
      rerender({ tc: 'PENDING-TRAIN-CODE' });
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 새 dispatch 없음(anchor 자체가 null)

      // stale 재시도 타이머가 그대로 발화 — 그 시점 latest trainCode는 pending이라 조용히 중단.
      act(() => jest.advanceTimersByTime(LOCK_SYNC_RETRY_BACKOFF_MS[0] + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 재시도가 실제 POST를 내지 않음
    });

    it('재시도 대기 중 lock이 다른 trainCode로 교체되면 stale 재시도는 sig 불일치로 중단', async () => {
      mockedSync.mockResolvedValueOnce({ ok: false });
      const invalidBoardingStationId = '__no_such_station_for_new_lock__';
      const { rerender } = renderHook(
        ({ tc, bid }: { tc: string; bid: string }) =>
          useBoardingLockSync({
            currentStationName: null,
            accuracyMeters: null,
            tripActive: true,
            boardingLockTrainCode: tc,
            boardingLockLine: '2',
            boardingLockBoardingStationId: bid,
          }),
        { initialProps: { tc: '7246', bid: boardingStationId } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 실패 — 재시도 armed(sig='7246|2')

      // 새 trainCode로 교체. boardingStationId를 의도적으로 무효화해 새 lock 자체의 즉시 시도는
      // blocked로 끝나게 하고(=경쟁 타이머 미생성), stale 재시도만 단독으로 발화하게 만든다.
      rerender({ tc: '9999', bid: invalidBoardingStationId });
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 새 lock 자체 시도는 anchor 없음(blocked)

      // stale 재시도(sig='7246|2') 발화 — 그 시점 latest trainCode는 '9999'라 sig 불일치로 중단.
      act(() => jest.advanceTimersByTime(LOCK_SYNC_RETRY_BACKOFF_MS[0] + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
    });

    it('재시도 대기 중 GPS/anchor 둘 다 사라지면 stale 재시도는 blocked로 조용히 중단', async () => {
      mockedSync.mockResolvedValueOnce({ ok: false });
      const { rerender } = renderHook(
        ({ bid }: { bid: string }) =>
          useBoardingLockSync({
            currentStationName: null,
            accuracyMeters: null,
            tripActive: true,
            boardingLockTrainCode: '7246',
            boardingLockLine: '2',
            boardingLockBoardingStationId: bid,
          }),
        { initialProps: { bid: boardingStationId } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 실패 — 재시도 armed

      // 같은 trainCode/line(sig 불변) — effect deps가 boardingLockBoardingStationId도 포함하므로
      // 새 render는 발생하지만, 새 anchor 자체가 없어(blocked) 경쟁 타이머는 생기지 않는다.
      rerender({ bid: '__no_such_station_after_all__' });
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);

      // stale 재시도 발화 — sig는 일치하지만 그 시점 boarding station lookup이 실패해 anchor가
      // 없다(blocked) — 조용히 중단.
      act(() => jest.advanceTimersByTime(LOCK_SYNC_RETRY_BACKOFF_MS[0] + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1);
    });

    it('재시도 대기 중 trip이 종료되면 대기 타이머를 취소(clearLockRetry non-null 분기)', async () => {
      mockedSync.mockResolvedValueOnce({ ok: false });
      const { rerender } = renderHook(
        ({ active }: { active: boolean }) =>
          useBoardingLockSync({
            currentStationName: null,
            accuracyMeters: null,
            tripActive: active,
            boardingLockTrainCode: '7246',
            boardingLockLine: '2',
            boardingLockBoardingStationId: boardingStationId,
          }),
        { initialProps: { active: true } },
      );
      act(() => jest.advanceTimersByTime(SYNC_DEBOUNCE_MS + 100));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 실패 — 재시도 armed

      rerender({ active: false }); // trip 종료 — armed된 재시도 타이머를 취소.
      act(() => jest.advanceTimersByTime(LOCK_SYNC_RETRY_BACKOFF_MS[0] + 1000));
      await flushAsyncStorage();
      expect(mockedSync).toHaveBeenCalledTimes(1); // 취소됐으므로 재시도 POST 없음
    });
  });
});
