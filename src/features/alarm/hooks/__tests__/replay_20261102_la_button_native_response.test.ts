/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트: LA 브릿지 + responder + 실 lock store를 한 사슬로 다룬다.
 */
/**
 * #3055 PR-1 — 2026-11-02 19:54:57~19:55:09 LA "탑승했어요" 실측 replay (plan v6 §5 A1).
 *
 * ## 실측 사실 (불변 — 통과시키려 조정 금지)
 * 출처: 기기 덤프 `텍스트-AB2FB85C916A-1.txt` Alarm log 326-343행 + D1 `trip_events` id 1995~1998
 * (token_hash b00dd879, 건대입구/7호선).
 *  - 19:54:57 backend가 LA 버튼 native POST로 lock 7320을 정확히 만들었다(D1 1996 `lock-attached`
 *    path=confirm trainCode=7320, 1997 `boarding-confirm-result` outcome=resolved).
 *  - 기기: 같은 intent가 `response-boarded`로 **19:55:00(덤프 343)과 19:55:04(덤프 336)에 2번**
 *    처리됐다. 매번 `autolock-direction-unresolved` → `autolock-fallback-pending`(덤프 341/339,
 *    335/333) = 2번 모두 PENDING을 만들었다. 3번째는 19:55:08 알림 응답(`autolock-success`).
 *  - 재진입 기전(코드 확정, 어느 트리거인지는 덤프로 구분 불가): (T1) RootLayout 리렌더 → inline deps
 *    객체 → `run` 재생성 → useEffect 재실행 (T2) AppState 'active' 전이 즉시 실행 (T3) 5s 폴링.
 *    clear는 `await handleResponse` 뒤라 POST가 도는 동안 같은 intent가 다시 읽힌다.
 *
 * ## 입력 구분
 *  - **실측**: intent {action BOARDING_BOARDED, originStation 건대입구, line 7, atMs 19:54:57 KST},
 *    backend 응답 resolvedTrainCode 7320, reason 쌍(`autolock-direction-unresolved` →
 *    `autolock-fallback-pending`), arrivals 재조회가 방향 미해결로 chosen을 못 고른 상태.
 *  - **합성(라벨)**: tripToken 문자열, intent id, T1/T2/T3 호출 순서·횟수(덤프로 구분 불가),
 *    POST 지연(deferred), 시나리오 (d)의 `nativePost`(PR-2 Swift가 쓰는 필드 — 실측 아님).
 *
 * ## 기대
 *  (a) 재진입(T1+T2+T3)에도 같은 intent는 1번만 처리: PENDING 생성 1회, POST 1회.
 *  (b) 그 PENDING은 confirm 응답의 resolvedTrainCode(7320)로 승격.
 *  (d) native가 이미 받은 응답이 있으면 PENDING·POST 없이 7320 lock 1개.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, act } from '@testing-library/react-native';
import { useLiveActivityIntentBridge } from '../useLiveActivityIntentBridge';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import * as positionUpload from '../../../nearest-station/api/positionUpload';
import * as alarmLog from '../../utils/alarmLog';
import {
  isRealBoardingLock,
  NATIVE_CONFIRM_WAIT_MS,
  PENDING_TRAIN_CODE,
} from '../../../../shared/constants/boardingLock';

const mockReadPending = jest.fn();
const mockClearPending = jest.fn();
jest.mock('live-activity', () => ({
  readPendingBoardingIntent: (...a: unknown[]) => mockReadPending(...a),
  clearPendingBoardingIntent: (...a: unknown[]) => mockClearPending(...a),
}));

let capturedPoll: (() => void) | null = null;
jest.mock('../../../../shared/hooks/usePolling', () => ({
  usePolling: (cb: () => void) => {
    capturedPoll = cb;
  },
}));

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
}));
jest.mock('../../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: jest.fn(),
  postBoardingConfirm: jest.fn(),
}));
jest.mock('../useAlarmEndTripResponder', () => ({ handleAlarmEndTripResponse: jest.fn() }));
jest.mock('../../../../shared/utils/stationLookup', () => ({ findStationByNameAndLine: jest.fn() }));
jest.mock('../../utils/alarmLog', () => ({
  logBoardingPromptAutoLock: jest.fn(),
  logBoardingPromptResponded: jest.fn(),
  logBoardingPromptFired: jest.fn(),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
  addLogBreadcrumb: jest.fn(),
}));
jest.mock('../useBoardingPromptDisplayLogger', () => ({
  wasBoardingPromptDisplayed: jest.fn(() => false),
  markBoardingPromptDisplayed: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../../store/useUserIntentStore', () => ({
  useUserIntentStore: {
    getState: () => ({
      setInfoModeEnabled: jest.fn(() => Promise.resolve()),
      setBoardingCommitted: jest.fn(() => Promise.resolve()),
    }),
  },
}));
jest.mock('../../store/tripBoundCleanups', () => ({ resumeNavigation: jest.fn() }));
jest.mock('../../store/useLegAdvanceStore', () => ({
  useLegAdvanceStore: { getState: () => ({ stampLegAdvance: jest.fn() }) },
}));
jest.mock('../../utils/widgetRefreshContext', () => {
  const actual = jest.requireActual('../../utils/widgetRefreshContext');
  return {
    ...actual,
    readWidgetRefreshContext: jest.fn(async () => ({ destination: null, route: null, bgContext: null })),
  };
});
jest.mock('../../../route/utils/findActiveTransferContext', () => ({
  findLocklessTransferWaypoint: jest.fn(() => null),
}));
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: jest.fn(),
  setBoardingLock: jest.fn(async () => undefined),
  clearBoardingLock: jest.fn(async () => undefined),
}));
jest.mock('../../utils/dismissSilenceStorage', () => ({
  clearDismissSilence: jest.fn(async () => undefined),
}));
jest.mock('../../utils/boardingActivityChannel', () => ({
  endBoardingActivity: jest.fn().mockResolvedValue(undefined),
}));

const { findStationByNameAndLine } = jest.requireMock('../../../../shared/utils/stationLookup');
const postBoardingConfirmMock = positionUpload.postBoardingConfirm as jest.Mock;
const autoLockLogMock = alarmLog.logBoardingPromptAutoLock as jest.Mock;
const ORIGINAL_CREATE_LOCK = useBoardingLockStore.getState().createLock;

// 실측: 19:54:57 KST = 10:54:57Z. 브릿지 첫 실행 19:55:00, 재실행 19:55:04.
const TAP_AT_MS = Date.UTC(2026, 10, 2, 10, 54, 57);
const RUN_1_AT_MS = Date.UTC(2026, 10, 2, 10, 55, 0);
// 합성(라벨): 실제 토큰 아님.
const TRIP_TOKEN = 'synthetic-token-b00dd879';
const INTENT_ID = `${TRIP_TOKEN}-${TAP_AT_MS}`;

function intentRaw(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: INTENT_ID,
    tripToken: TRIP_TOKEN,
    action: 'BOARDING_BOARDED',
    originStation: '건대입구',
    line: '7',
    atMs: TAP_AT_MS,
    ...extra,
  });
}

/** 실측: 재조회가 방향 미해결로 chosen을 못 고른다 → direction-unresolved → PENDING fallback. */
function makeDeps() {
  return {
    fetchArrivalsForStation: jest.fn(async () => ({ up: [], down: [] })),
    destinationId: 'dst-yongmasan',
    expectedDurationMs: 30 * 60_000,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

describe('replay 2026-11-02 19:54:57 — LA 버튼 브릿지 재진입 + PENDING 승격', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedPoll = null;
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    useBoardingLockStore.setState({ lock: null, createLock: ORIGINAL_CREATE_LOCK });
    findStationByNameAndLine.mockReturnValue({ id: 'S-kondae', line: '7', name: '건대입구' });
    mockReadPending.mockReturnValue(intentRaw());
  });

  it('(a)(b) 재진입 T1+T2+T3 중에도 같은 intent는 1번만 처리되고, PENDING은 응답 7320으로 승격된다', async () => {
    const post = deferred<{ ok: boolean; status: number; resolvedTrainCode: string }>();
    postBoardingConfirmMock.mockReturnValue(post.promise);
    const deps = makeDeps();

    // 첫 실행(19:55:00, 마운트 effect).
    const { rerender } = renderHook(
      ({ d }: { d: typeof deps }) => useLiveActivityIntentBridge(d, () => RUN_1_AT_MS),
      { initialProps: { d: deps } },
    );
    await flush();

    // POST가 도는 동안: (T1) RootLayout 리렌더 → 새 deps 객체 → effect 재실행.
    rerender({ d: { ...deps } });
    // (T3) 5s 폴링 / (T2) AppState active 전이 즉시 실행 — 둘 다 같은 poll 콜백.
    act(() => {
      capturedPoll?.();
      capturedPoll?.();
    });
    await flush();

    // 같은 intent가 이 시점까지 1번만 처리됐다(덤프: 2번 처리돼 PENDING 2회 생성).
    expect(deps.fetchArrivalsForStation).toHaveBeenCalledTimes(1);
    expect(postBoardingConfirmMock).toHaveBeenCalledTimes(1);
    // PENDING 중간 상태 + 실측 사유 쌍이 정확히 1번씩.
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe(PENDING_TRAIN_CODE);
    expect(autoLockLogMock.mock.calls.map(([e]) => e.reason)).toEqual([
      'autolock-direction-unresolved',
      'autolock-fallback-pending',
    ]);
    expect(mockClearPending).not.toHaveBeenCalled();

    // backend 응답(실측 D1 1997: resolved 7320) 도착 → PENDING 승격.
    post.resolve({ ok: true, status: 200, resolvedTrainCode: '7320' });
    await flush();

    const { lock } = useBoardingLockStore.getState();
    expect(lock?.trainCode).toBe('7320');
    expect(isRealBoardingLock(lock)).toBe(true);
    expect(postBoardingConfirmMock).toHaveBeenCalledTimes(1);
    expect(mockClearPending).toHaveBeenCalledTimes(1);
    expect(mockClearPending).toHaveBeenCalledWith(INTENT_ID);
  });

  it('(d) [합성 nativePost] native가 이미 받은 응답이 있으면 PENDING·POST 없이 7320 lock 1개 — 재진입에도 1번', async () => {
    mockReadPending.mockReturnValue(
      intentRaw({ nativePost: { status: 200, resolvedTrainCode: '7320', lockState: 'leg2', atMs: TAP_AT_MS + 500 } }),
    );
    const deps = makeDeps();
    const createLockSpy = jest.fn(ORIGINAL_CREATE_LOCK);
    useBoardingLockStore.setState({ createLock: createLockSpy });

    const { rerender } = renderHook(
      ({ d }: { d: typeof deps }) => useLiveActivityIntentBridge(d, () => RUN_1_AT_MS),
      { initialProps: { d: deps } },
    );
    rerender({ d: { ...deps } });
    act(() => {
      capturedPoll?.();
    });
    await flush();

    expect(useBoardingLockStore.getState().lock?.trainCode).toBe('7320');
    expect(createLockSpy).toHaveBeenCalledTimes(1);
    expect(postBoardingConfirmMock).not.toHaveBeenCalled();
    expect(deps.fetchArrivalsForStation).not.toHaveBeenCalled();
    expect(autoLockLogMock).not.toHaveBeenCalled();
    expect(mockClearPending).toHaveBeenCalledTimes(1);
    expect(mockClearPending).toHaveBeenCalledWith(INTENT_ID);
  });

  it('(e) R15 [합성] native 예산(15s) 경과 → 브릿지 fallback으로 7320 승격, 이후 native 늦은 성공 기록이 와도 lock 중복 생성 0', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7320' });
    const deps = makeDeps();
    const createLockSpy = jest.fn(ORIGINAL_CREATE_LOCK);
    useBoardingLockStore.setState({ createLock: createLockSpy });

    // 1) native가 15s 넘게 in-flight → 브릿지가 fallback POST.
    mockReadPending.mockReturnValue(intentRaw({ nativePost: 'in-flight' }));
    const { rerender } = renderHook(
      ({ now }: { now: number }) => useLiveActivityIntentBridge(deps, () => now),
      { initialProps: { now: TAP_AT_MS + NATIVE_CONFIRM_WAIT_MS + 1 } },
    );
    await flush();
    expect(postBoardingConfirmMock).toHaveBeenCalledTimes(1);
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe('7320');
    expect(mockClearPending).toHaveBeenCalledTimes(1);
    const locksCreatedByFallback = createLockSpy.mock.calls.length; // PENDING 생성 + 승격

    // 2) native가 늦게 성공 기록(id 비교를 우회한 최악 경우) → 같은 열차·역·노선이라 no-op.
    mockReadPending.mockReturnValue(
      intentRaw({ nativePost: { status: 200, resolvedTrainCode: '7320', lockState: 'leg2', atMs: TAP_AT_MS + 20_000 } }),
    );
    rerender({ now: TAP_AT_MS + 21_000 });
    await flush();
    expect(createLockSpy.mock.calls.length).toBe(locksCreatedByFallback);
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe('7320');
    expect(postBoardingConfirmMock).toHaveBeenCalledTimes(1);
  });
});
