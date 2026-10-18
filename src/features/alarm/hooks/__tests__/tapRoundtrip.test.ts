/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트: responder(orchestrator)와 nearest-station api를 함께 다룬다.
 */
/**
 * #3055 C — 탑승 표명 탭 왕복 완결(사슬 테스트). 스펙 SSoT: 이슈 #3055 plan v4.
 *
 * 구현을 보지 않고 스펙만으로 작성(TDD red 먼저). 실 `useBoardingLockStore`(storage만 mock)를
 * 쓴다 — responder가 "스토어에 실제로 무엇을 남기는가"를 본다(mock createLock 호출 검증이
 * 아니라 최종 상태 assert).
 *
 * 스펙 요약:
 *  - 응답의 resolvedTrainCode는 **현재 store lock이 PENDING일 때만** 교체한다.
 *  - 교체 시 boardedAt(원 표명 시각)·boardingEvidence는 보존, trainCode(+resolveTier)만 교체.
 *  - 실 lock 존재(reconfirmed) / lock 부재(skip·dismiss) / 응답에 trainCode 없음 → 변경 없음.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { handleResponse } from '../useBoardingPromptResponder';
import { BOARDING_PROMPT_ACTION_BOARDED, BOARDING_PROMPT_ACTION_NOT_BOARDED } from '../../utils/notificationCategory';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { clearLockLifecycleEntries, getLockLifecycleEntries } from '../../utils/boardingLockLifecycleBuffer';
import * as positionUpload from '../../../nearest-station/api/positionUpload';
import { isPendingTrainCode, isRealBoardingLock, PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import type { StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

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

const { findStationByNameAndLine } = jest.requireMock('../../../../shared/utils/stationLookup');
const postBoardingConfirmMock = positionUpload.postBoardingConfirm as jest.Mock;

const PAYLOAD = {
  kind: 'boarding-prompt' as const,
  originStation: '강남',
  line: '2',
  tripToken: 'tok',
  destinationDirection: 'up' as const,
};

function arrivalWith(trainCodes: string[]): StationArrival {
  return {
    up: trainCodes.map((trainCode) => ({
      destination: '',
      arrivalMinutes: 1,
      arrivalSeconds: 60,
      statusMessage: '',
      trainCode,
      line: '2',
      receivedAtMs: 0,
      arrivalCode: 2,
      isLastTrain: false,
      trainType: 'normal' as const,
    })),
    down: [],
  };
}

/** arrivals 재조회 실패 → tryAutoLock이 PENDING fallback lock을 만든다(10/18 실측 모양). */
function pendingDeps() {
  return {
    fetchArrivalsForStation: jest.fn(async () => null),
    destinationId: 'dst',
    expectedDurationMs: 600_000,
    createLock: useBoardingLockStore.getState().createLock,
  };
}

describe('#3055 C — 응답 소비로 PENDING lock 교체', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    useBoardingLockStore.setState({ lock: null });
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
  });

  it('RED(사슬): PENDING 생성 → 응답 resolvedTrainCode=7325 → store lock이 실 열차로 교체(억제 predicate 해제)', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());

    const { lock } = useBoardingLockStore.getState();
    expect(lock?.trainCode).toBe('7325');
    // useStationAlarm :226 억제는 isPendingTrainCode(lock.trainCode)로 판정 — 교체 후 해제.
    expect(isPendingTrainCode(lock!.trainCode)).toBe(false);
    expect(isRealBoardingLock(lock)).toBe(true);
  });

  it('boardedAt(원 표명 시각)·boardingEvidence·역/노선은 보존하고 trainCode만 교체한다(resolveTier는 저장 안 함)', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    postBoardingConfirmMock.mockImplementation(async () => {
      // 응답이 늦게 도착(PENDING 생성 후 시간 경과) — 교체가 boardedAt을 지금으로 덮으면 안 된다.
      nowSpy.mockReturnValue(1_700_000_030_000);
      return { ok: true, status: 200, resolvedTrainCode: '7325', resolveTier: 'assertion-departed' };
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    nowSpy.mockRestore();

    expect(useBoardingLockStore.getState().lock).toEqual(
      expect.objectContaining({
        trainCode: '7325',
        boardedAt: 1_700_000_000_000,
        boardingEvidence: false,
        boardingStationId: 'S1',
        boardingLine: '2',
        destinationId: 'dst',
      }),
    );
    expect(useBoardingLockStore.getState().lock).not.toHaveProperty('resolveTier');
  });

  it('승격은 생성과 구분되는 lifecycle source로 남고 resolveTier는 telemetry entry에만 실린다', async () => {
    clearLockLifecycleEntries();
    postBoardingConfirmMock.mockResolvedValue({
      ok: true,
      status: 200,
      resolvedTrainCode: '7325',
      resolveTier: 'assertion-departed',
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    const creates = getLockLifecycleEntries().filter((e) => e.event === 'create');
    expect(creates.map((e) => e.source)).toEqual(['boarding-prompt-response', 'boarding-confirm-response']);
    expect(creates[1]).toEqual(expect.objectContaining({ trainCode: '7325', resolveTier: 'assertion-departed' }));
    expect(creates[0]).not.toHaveProperty('resolveTier');
  });

  it('ⓑ 응답에 resolvedTrainCode 없음(lock 미성립) → PENDING 유지', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200 });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe(PENDING_TRAIN_CODE);
  });

  it('ⓑ POST 실패(ok:false) → PENDING 유지', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: false, status: 500 });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe(PENDING_TRAIN_CODE);
  });

  it('ⓑ resolvedTrainCode가 빈 문자열/PENDING sentinel이면 교체하지 않는다(비실체 lock 금지)', async () => {
    for (const bad of ['', PENDING_TRAIN_CODE]) {
      useBoardingLockStore.setState({ lock: null });
      postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: bad });
      await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
      expect(useBoardingLockStore.getState().lock?.trainCode).toBe(PENDING_TRAIN_CODE);
    }
  });

  it('ⓒ 실 lock이 이미 있으면(reconfirmed 경로) 응답이 달라도 교체하지 않는다', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: 'OTHER' });
    const deps = { ...pendingDeps(), fetchArrivalsForStation: jest.fn(async () => arrivalWith(['T1'])) };
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe('T1');
  });

  it('ⓓ lock이 아예 없을 때(skip: position 모순) 응답을 무시한다 — lock 신규 생성 금지', async () => {
    // BG_LAST_STATION이 payload 역과 모순되는 fresh 관측 → createPendingFallbackLock skip.
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
      JSON.stringify({
        station: { id: 'BG1', line: '7', name: '용마산' },
        distanceKm: 0.1,
        timestamp: Date.now(),
      }),
    );
    (findStationByNameAndLine as jest.Mock).mockImplementation((name: string, line: string) =>
      name === '강남' && line === '2' ? { id: 'S1', line: '2', name: '강남' } : null,
    );
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock).toBeNull();
  });

  it('ⓓ [미탑승]/dismiss 경로는 boarding-confirm POST 자체가 없고 lock도 만들지 않는다', async () => {
    await handleResponse(BOARDING_PROMPT_ACTION_NOT_BOARDED, PAYLOAD, pendingDeps());
    expect(postBoardingConfirmMock).not.toHaveBeenCalled();
    expect(useBoardingLockStore.getState().lock).toBeNull();
  });

  it('ⓔ responder 경로의 fresh trainCode 전송은 불변(#3028) — 재확정 T1을 5번째 인자로 forward', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200 });
    const deps = { ...pendingDeps(), fetchArrivalsForStation: jest.fn(async () => arrivalWith(['T1'])) };
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(postBoardingConfirmMock).toHaveBeenCalledWith('tok', 'boarded', '강남', '2', 'T1');
  });

  // P1-1 소유권 — skip 분기에서 이전 탭의 stale PENDING이 남아 있으면 이번 응답으로 덮지 않는다.
  const STALE_PENDING: BoardingLock = {
    destinationId: 'dst',
    trainCode: PENDING_TRAIN_CODE,
    boardingStationId: 'S0',
    boardingLine: '1' as const,
    boardedAt: 1_000,
    expectedDurationMs: 600_000,
    boardingEvidence: false,
  };

  it('[거부] 이전 탭의 stale PENDING + 이번 탭 skip(position 모순) + 응답 resolvedTrainCode → lock 불변', async () => {
    useBoardingLockStore.setState({ lock: STALE_PENDING });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
      JSON.stringify({
        station: { id: 'BG1', line: '7', name: '용마산' },
        distanceKm: 0.1,
        timestamp: Date.now(),
      }),
    );
    (findStationByNameAndLine as jest.Mock).mockImplementation((name: string, line: string) =>
      name === '강남' && line === '2' ? { id: 'S1', line: '2', name: '강남' } : null,
    );
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock).toEqual(STALE_PENDING);
  });

  it('[거부] 이전 탭의 stale PENDING + 이번 탭 station lookup 실패 skip → lock 불변', async () => {
    useBoardingLockStore.setState({ lock: STALE_PENDING });
    (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock).toEqual(STALE_PENDING);
  });

  it('[거부] createLock이 조용히 skip(immutability 모사)돼 이번 PENDING이 안 올라오면 stale PENDING 불변', async () => {
    useBoardingLockStore.setState({ lock: STALE_PENDING });
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    const deps = { ...pendingDeps(), createLock: jest.fn(async () => undefined) };
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.createLock).toHaveBeenCalledTimes(1); // PENDING 생성 시도만, 승격 호출 없음
    expect(useBoardingLockStore.getState().lock).toEqual(STALE_PENDING);
  });

  it('[거부] createLock 예외 → createdPending=false, 승격 시도 없음', async () => {
    postBoardingConfirmMock.mockResolvedValue({ ok: true, status: 200, resolvedTrainCode: '7325' });
    const deps = {
      ...pendingDeps(),
      createLock: jest.fn(async () => {
        throw new Error('storage down');
      }),
    };
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.createLock).toHaveBeenCalledTimes(1);
  });

  // ⓖ 상호작용(스펙 선언): PENDING 상태에서 브릿지 재진입(LA 버튼 → FG)하면 `tryAutoLock`이 PENDING을
  // **재생성**해 boardedAt이 갱신된다(createPendingFallbackLock 불변). U1 보존 규칙은 "응답 시점의
  // PENDING이 가진 boardedAt을 유지"이므로 최종 boardedAt = 마지막 표명 시각(두 표명 모두 5분 stale
  // 게이트 안의 사용자 명시 표명). 이 동작을 고정한다 — 의도 변경 시 이 테스트가 먼저 깨진다.
  it('ⓖ 재진입으로 PENDING이 재생성된 뒤 승격 → boardedAt은 마지막 표명 시각(선언된 동작)', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    postBoardingConfirmMock.mockResolvedValueOnce({ ok: true, status: 200 }); // 1차: 미해소
    nowSpy.mockReturnValue(1_700_000_000_000);
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    expect(useBoardingLockStore.getState().lock?.boardedAt).toBe(1_700_000_000_000);

    postBoardingConfirmMock.mockResolvedValueOnce({ ok: true, status: 200, resolvedTrainCode: '7325' });
    nowSpy.mockReturnValue(1_700_000_120_000);
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps());
    nowSpy.mockRestore();

    expect(useBoardingLockStore.getState().lock).toEqual(
      expect.objectContaining({ trainCode: '7325', boardedAt: 1_700_000_120_000 }),
    );
  });

  it('postBoardingConfirm이 undefined를 돌려줘도(mock/예외 경로) throw 없이 PENDING 유지', async () => {
    postBoardingConfirmMock.mockResolvedValue(undefined);
    await expect(handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, pendingDeps())).resolves.toBeUndefined();
    expect(useBoardingLockStore.getState().lock?.trainCode).toBe(PENDING_TRAIN_CODE);
  });
});
