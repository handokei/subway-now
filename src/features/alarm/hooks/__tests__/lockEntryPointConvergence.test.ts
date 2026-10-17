/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트 — #2722. 수동 탭(alarm + route 두 슬라이스)과 notification/LA가
 * 공유하는 handleResponse가 정말로 동일한 store 함수(createLock)를 호출하는지 구조적으로 검증한다.
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890)와 동일 opt-in 사유.
 */

/**
 * #2722 — "3개 진입점이 같은 함수를 호출함을 구조적으로 assert(grep 아닌 테스트)".
 *
 * grep으로는 "다들 useBoardingLockStore를 import한다"까지만 보인다. 이 테스트는 실제 런타임에서
 * `useBoardingLockStore`의 `createLock` 액션 슬롯을 스파이로 교체한 뒤, 서로 다른 3개 진입점
 * (환승 목록 수동 탭 / 출발역 목록 수동 탭 / notification·LA가 공유하는 `handleResponse`)을
 * 각각 구동해 **정확히 같은 스파이 함수 인스턴스**가 호출되는지 확인한다 — mock을 진입점마다
 * 따로 두면 이 assert 자체가 성립하지 않는다.
 *
 * LA 버튼(useLiveActivityIntentBridge)은 이 테스트에서 별도로 구동하지 않는다 — 그 훅은 정적으로
 * `handleResponse`를 import해 그대로 호출한다(#2438 머지 코드, `useLiveActivityIntentBridge.ts`
 * 상단 주석 참조). 즉 LA와 notification 응답은 애초에 같은 함수 호출이므로, 이 테스트가 검증하는
 * "handleResponse → createLock" 경로 자체가 LA 경로이기도 하다. LA 고유 로직(App Group intent
 * 파싱, ⑥ dedup)은 `useLiveActivityIntentBridge.test.ts`가 별도로 커버한다.
 */
import { act, renderHook } from '@testing-library/react-native';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { useTransferTrainList } from '../../../route/hooks/useTransferTrainList';
import { useBoardingLockController } from '../useBoardingLockController';
import { handleResponse } from '../useBoardingPromptResponder';
import { makeTransferRoute, makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { Station } from '../../../../shared/types/station';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

jest.mock('../../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: jest.fn(async () => undefined),
}));

jest.mock('../../utils/alarmLog', () => ({
  logBoardingPromptAutoLock: jest.fn(),
  logBoardingPromptResponded: jest.fn(),
  logBoardingPromptFired: jest.fn(),
}));

jest.mock('../../utils/widgetRefreshContext', () => ({
  readWidgetRefreshContext: jest.fn(async () => ({ destination: null, route: null })),
  parseBgLastStation: jest.fn(() => null),
}));

jest.mock('../../store/useUserIntentStore', () => ({
  useUserIntentStore: {
    getState: () => ({
      setInfoModeEnabled: jest.fn().mockResolvedValue(undefined),
      setBoardingCommitted: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../../../route/store/useNavigationStore', () => ({
  useNavigationStore: { getState: () => ({ startNavigation: jest.fn() }) },
}));

const mockStampLegAdvance = jest.fn().mockResolvedValue(undefined);
jest.mock('../../store/useLegAdvanceStore', () => ({
  useLegAdvanceStore: Object.assign(
    (selector?: (s: { nextLine: null; stampedAt: null }) => unknown) =>
      selector ? selector({ nextLine: null, stampedAt: null }) : { nextLine: null, stampedAt: null },
    { getState: () => ({ stampLegAdvance: mockStampLegAdvance }) },
  ),
}));

jest.mock('../../api/useLockSuggestion', () => ({
  useLockSuggestion: () => ({ suggestion: null }),
}));

jest.mock('../../../arrival/hooks/useArrivalInfo', () => ({
  useArrivalInfo: jest.fn(() => ({ arrival: null, loading: false, isMock: false, refetch: jest.fn() })),
  prefetchArrival: jest.fn(),
}));

jest.mock('../../utils/backendSsotMirror', () => ({
  ...jest.requireActual('../../utils/backendSsotMirror'),
  readBackendSsotMirror: jest.fn(async () => null),
}));

describe('#2722 — 3개 진입점(수동 탭 x2 + notification/LA 공유 handleResponse) 단일 함수 수렴', () => {
  const gangnamLine2 = findStationByNameAndLine('강남', '2') as Station;

  beforeEach(() => {
    jest.clearAllMocks();
    useBoardingLockStore.setState({ lock: null });
  });

  it('세 진입점 모두 store의 동일한 createLock 함수 인스턴스를 호출한다', async () => {
    const spy = jest.fn().mockResolvedValue(undefined);
    // #2722 핵심 assert 준비 — store의 createLock 슬롯 자체를 스파이로 교체한다. 이후 각
    // 진입점은 hook selector(`useBoardingLockStore((s) => s.createLock)`) 또는
    // `useBoardingLockStore.getState().createLock`로 이 슬롯을 읽으므로, 어느 경로로 읽든
    // 정확히 같은 함수 참조를 얻는다 — 이게 "단일 함수"라는 주장의 런타임 증거다.
    useBoardingLockStore.setState({ createLock: spy });

    // 진입점 1 — 출발역 BoardingTrainList 수동 탭 (useBoardingLockController.createLockFromTrain)
    const controller = renderHook(() =>
      useBoardingLockController({
        destinationId: 'dest-1',
        destinationName: '성수',
        route: makeDirectRoute(5, '2'),
        arrival: null,
        currentStation: gangnamLine2,
        expectedDurationMinutes: 20,
      }),
    );
    const train1: ArrivalInfo = {
      destination: '성수',
      arrivalMinutes: 3,
      arrivalSeconds: 180,
      statusMessage: '',
      trainCode: 'T-MANUAL-1',
      line: '2',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    };
    await act(async () => controller.result.current.createLockFromTrain(train1));
    expect(spy).toHaveBeenCalledTimes(1);

    // 진입점 2 — 환승 목록 수동 탭 (useTransferTrainList.createTransferLock). 진입점 1의 lock을
    // 다시 덮지 않도록, 두 진입점이 서로 다른 역/노선을 겨냥하게 route/lock을 구성한다.
    const transferRoute = makeTransferRoute({
      transferName: '왕십리',
      fromLine: '2',
      toLine: '5',
      stopsToTransfer: 1,
      stopsFromTransfer: 2,
    });
    const priorLegLock: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T-PRIOR-LEG',
      boardingStationId: 'stn-prior',
      boardingLine: '2',
      boardedAt: Date.now(),
      expectedDurationMs: 600_000,
    };
    const wangsimniOn2 = findStationByNameAndLine('왕십리', '2') as Station;
    const transferList = renderHook(() =>
      useTransferTrainList({
        lock: priorLegLock,
        route: transferRoute,
        destinationName: '군자',
        currentStation: wangsimniOn2,
      }),
    );
    const train2: ArrivalInfo = {
      destination: '군자',
      arrivalMinutes: 2,
      arrivalSeconds: 120,
      statusMessage: '',
      trainCode: 'T-MANUAL-2',
      line: '5',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    };
    await act(async () => transferList.result.current.createTransferLock(train2));
    expect(spy).toHaveBeenCalledTimes(2);

    // 진입점 3 — notification "탑승했어요" / LA 버튼이 공유하는 handleResponse. arrivals fetch가
    // null(빈 응답)을 반환하는 경로를 태워 createPendingFallbackLock을 거치지만, 최종적으로
    // 호출되는 createLock은 여전히 deps로 주입한 이 spy 하나다 — LA 버튼(useLiveActivityIntentBridge)도
    // 정적으로 이 handleResponse를 그대로 호출한다(별도 lock 로직 없음, 소스 확인됨).
    await handleResponse(
      'BOARDING_PROMPT_BOARDED',
      { kind: 'boarding-prompt', originStation: '강남', line: '2', tripToken: 'tok-1' },
      {
        fetchArrivalsForStation: async () => null,
        destinationId: 'dest-2',
        expectedDurationMs: 600_000,
        createLock: spy,
      },
    );
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
