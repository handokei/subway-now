/* eslint-disable import/no-restricted-paths --
 * 검증 전용 재현 테스트. 대상 모듈(useBoardingPromptResponder)이 cross-feature orchestrator라
 * 직접 import가 본질적이므로 대상 파일과 동일하게 옵트인한다.
 */
/**
 * #2889 — 재현 전용(replay) 테스트. 프로덕션 코드는 건드리지 않는다.
 *
 * 실측 근거(2026-10-07 저녁 트립): device는 프롬프트 응답을 4회 기록했으나
 * (19:23:36 boarding / 19:25:16 hop-end / 19:30:31 boarding / 19:37:18 hop-end 추정),
 * backend D1 `boarding-confirm-result`에는 2건(19:23:37 / 19:30:33)만 도달했다 —
 * 모두 "승차(boarding)" 응답과 시각이 일치하고, hop-end(환승역 하차 확인) 응답 2건은
 * 도달한 기록이 없다.
 *
 * 코드 조사 결과: `useBoardingPromptResponder.ts`의
 *   - 승차 분기(`handleResponse`, 약 :283-326)는 tryAutoLock 직후 무조건
 *     `postBoardingConfirm(payload.tripToken, 'boarded', ...)`을 호출한다(#2852, 라인 ~312).
 *   - hop-end 분기(`handleHopEndResponse`, 약 :344-404)는 releaseLock / stampLegAdvance /
 *     dismissBoardingPrompt만 호출하고 `postBoardingConfirm` 호출이 **존재하지 않는다**.
 *
 * 즉 "탑승했다"와 "하차(환승 완료)했다"는 사용자 입장에서 같은 종류의 확정 행동(명시 의향
 * 응답)인데, 전자만 backend에 도달하고 후자는 device 로컬 처리로 끝난다 — 이 파일은 그
 * 비대칭을 같은 파일 안에서 나란히 고정해 보여준다.
 *
 * 참고: hop-end의 "postBoardingConfirm 미호출"은 기존
 * `useBoardingPromptResponder.test.ts`(describe 'handleResponse — #2034 hop-end', #2852 주석)
 * 에도 이미 개별적으로 固定돼 있다. 이 파일은 #2889 재현 과제 전용으로, 승차/hop-end 두 경로를
 * 한 파일에서 대조하는 것이 목적이며 기존 테스트의 기대값을 변경하지 않는다.
 *
 * #2889에서 hop-end 분기에 `postBoardingConfirm` 배선을 추가하면, 아래 두 번째 테스트
 * ("hop-end 응답 → postBoardingConfirm 미호출")는 **뒤집혀야 한다**(실패하게 된다) —
 * 그 시점에 이 테스트를 "호출됨"으로 갱신해야 wiring이 완성된 것이다.
 */
import * as Notifications from 'expo-notifications';
import { handleResponse } from '../useBoardingPromptResponder';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  DISEMBARK_ACTION_DISEMBARKED,
} from '../../utils/notificationCategory';
import * as positionUpload from '../../../nearest-station/api/positionUpload';

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
jest.mock('../useAlarmEndTripResponder', () => ({
  handleAlarmEndTripResponse: jest.fn(),
}));
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: jest.fn(() => ({ id: 'S1', line: '2', name: '성수' })),
}));
jest.mock('../../utils/alarmLog', () => ({
  logBoardingPromptAutoLock: jest.fn(),
  logBoardingPromptResponded: jest.fn(),
  logBoardingPromptFired: jest.fn(),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
}));
jest.mock('../useBoardingPromptDisplayLogger', () => ({
  wasBoardingPromptDisplayed: jest.fn(() => false),
  markBoardingPromptDisplayed: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('../../store/useBoardingLockStore', () => {
  const mockCreateLock = jest.fn();
  const mockReleaseLock = jest.fn(() => Promise.resolve());
  return {
    useBoardingLockStore: {
      getState: () => ({ createLock: mockCreateLock, releaseLock: mockReleaseLock }),
    },
    __mockCreateLock: mockCreateLock,
    __mockReleaseLock: mockReleaseLock,
  };
});
jest.mock('../../store/useUserIntentStore', () => ({
  useUserIntentStore: {
    getState: () => ({
      setInfoModeEnabled: jest.fn(() => Promise.resolve()),
      setBoardingCommitted: jest.fn(() => Promise.resolve()),
    }),
  },
}));
jest.mock('../../../route/store/useNavigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ startNavigation: jest.fn() }),
  },
}));
jest.mock('../../store/useLegAdvanceStore', () => ({
  useLegAdvanceStore: {
    getState: () => ({ stampLegAdvance: jest.fn() }),
  },
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

const { __mockCreateLock: createLockMock } = jest.requireMock('../../store/useBoardingLockStore');

function makeDeps(overrides: Partial<Parameters<typeof handleResponse>[2]> = {}) {
  return {
    fetchArrivalsForStation: jest.fn(async () => null),
    destinationId: 'dst',
    expectedDurationMs: 600_000,
    createLock: createLockMock,
    ...overrides,
  };
}

const BOARDING_PAYLOAD = {
  kind: 'boarding-prompt' as const,
  originStation: '성수',
  line: '2',
  tripToken: 'tok-board',
  destinationDirection: 'up' as const,
};

const HOP_END_PAYLOAD = {
  kind: 'boarding-prompt' as const,
  originStation: '성수',
  line: '2',
  tripToken: 'tok-hopend',
  hopEndKind: 'disembark' as const,
  nextLine: 'K',
  nextStation: '왕십리',
};

describe('#2889 재현 — 승차/hop-end 응답의 backend 도달 비대칭', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 대조군(control): 승차 프롬프트 응답 → postBoardingConfirm 호출됨.
  // 현재 dev에서 정상 동작하는 경로이며, #2889 fix가 이걸 깨서는 안 된다.
  it('[대조군] 승차(boarding) 프롬프트 [탑승] 응답 → postBoardingConfirm이 호출된다', async () => {
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, BOARDING_PAYLOAD, makeDeps());

    expect(positionUpload.postBoardingConfirm).toHaveBeenCalledWith(
      'tok-board',
      'boarded',
      '성수',
      '2',
    );
  });

  // 결함 재현: hop-end(환승역 "하차했나요?") [하차함] 응답 → postBoardingConfirm 미호출.
  // 이것이 #2889 결함의 재현이다 — 승차와 같은 종류의 명시 의향 확정 응답인데 backend에
  // 도달하지 않는다. #2889에서 배선을 추가하면 이 assertion은 뒤집혀야 한다(현재 동작 고정).
  it(
    '[결함 재현 #2889] hop-end(환승역 하차 확인) [하차함] 응답 → postBoardingConfirm이 ' +
      '호출되지 않는다 (현재 동작을 고정한 것 — #2889에서 배선 추가 시 이 테스트를 뒤집어야 함)',
    async () => {
      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeDeps(),
      );

      expect(positionUpload.postBoardingConfirm).not.toHaveBeenCalled();
    },
  );

  // 같은 사용자 행동(확정 응답)인데 갈리는 지점을 한 assertion에 나란히 보이게 — 두 호출
  // 모두 수행한 뒤 mock.calls 배열 자체를 비교.
  it('같은 종류의 확정 응답(탑승 vs 하차)인데 backend 도달 여부가 갈린다', async () => {
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, BOARDING_PAYLOAD, makeDeps());
    const afterBoarding = (positionUpload.postBoardingConfirm as jest.Mock).mock.calls.length;

    await handleResponse(DISEMBARK_ACTION_DISEMBARKED, HOP_END_PAYLOAD, makeDeps());
    const afterHopEnd = (positionUpload.postBoardingConfirm as jest.Mock).mock.calls.length;

    expect(afterBoarding).toBe(1); // 승차 응답 → backend 도달.
    expect(afterHopEnd).toBe(1); // hop-end 응답 후에도 호출 횟수 불변 → backend 미도달.
  });
});
