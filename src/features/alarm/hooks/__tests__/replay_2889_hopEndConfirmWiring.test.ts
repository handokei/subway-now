/* eslint-disable import/no-restricted-paths --
 * 검증 전용 재현 테스트. 대상 모듈(useBoardingPromptResponder)이 cross-feature orchestrator라
 * 직접 import가 본질적이므로 대상 파일과 동일하게 옵트인한다.
 */
/**
 * #2889 — 재현 전용(replay) 테스트. 프로덕션 코드는 건드리지 않는다.
 *
 * ## 판정 정정 (재현 결과 '결함 아님')
 *
 * 최초 재현 과제는 "hop-end 응답이 backend에 전달되지 않는다"는 의심이었다. 그러나
 * `useBoardingPromptResponder.ts`의 hop-end 분기 주석(#2282/#2278/#2287)을 보면 이는
 * 결함이 아니라 **설계상 두 개의 분리된 확정 채널**이다:
 *
 *   - **탑승(boarding) 확정** 채널 — `postBoardingConfirm(tripToken, 'boarded', ...)`.
 *     "지금 이 열차에 탔다"를 backend anchor resolver에 알리는 전용 신호(#2852, :312).
 *   - **하차(hop-end) 확정** 채널 — `releaseLock('user')` + `stampLegAdvance(nextLine)`
 *     (둘 다 device-local). `handleHopEndResponse`의 주석(:336-338)이 명시하듯, backend는
 *     hop-end 프롬프트를 **발사(fire)한 시점에 이미** `hopEndPromptState[legKey].fired=true`
 *     로 stamp를 끝냈다 — 사용자가 [하차함]으로 응답한 시점에 추가로 backend에 알릴 "새
 *     사실"이 없다(다음 leg 진행은 backend cron이 다음 cycle에 자연 발사). 그래서 이 확정
 *     경로는 `postBoardingConfirm`은 물론 `dismissBoardingPrompt`도 호출하지 않는다 —
 *     device-local 반영만으로 충분하다는 것이 설계 의도다.
 *   - hop-end의 **[아직]("NOT_YET") 응답**만 backend에 추가 POST(`dismissBoardingPrompt`,
 *     실측에서 200 확인)를 보낸다 — 5분 재발사 억제(`silencedUntil`)가 목적이라 backend에
 *     "아직 아니다"라는 새 사실을 반드시 전달해야 하기 때문이다(:399-403).
 *
 * 즉 "탑승 확정"과 "하차 확정"은 같은 모양의 사용자 응답처럼 보이지만 backend 입장에서
 * 의미가 다르다(전자=새 사실 전달 필요, 후자=이미 아는 사실의 device-local 반영) — 이 파일은
 * 그 **경계**를 고정한다. hop-end 확정 응답이 `postBoardingConfirm`을 호출하기 **시작**하면
 * 그것이 오히려 회귀다(설계 의도와 다른 이중 confirm 신호가 backend로 새어나가는 것).
 *
 * 실측 근거(2026-10-07 저녁 트립): device 응답 4회(19:23:36/19:25:16/19:30:31/19:37:18),
 * backend D1 `boarding-confirm-result` 2건(19:23:37/19:30:33, 모두 승차 응답 시각과 일치) —
 * 이 비대칭은 위 설계 그대로다. hop-end 응답 2건이 `boarding-confirm-result`에 없는 것은
 * 정상이며, hop-end가 실제로 backend에 반영됐는지는 이 파일의 "[아직]" 테스트가 보여주는
 * `dismissBoardingPrompt` 채널(확정 응답은 발사-시점 stamp로 이미 충분) 또는 backend
 * `hopEndPromptState[legKey].fired` 기록으로 확인한다.
 *
 * 참고: 동일 경계는 기존 `useBoardingPromptResponder.test.ts`
 * (describe 'handleResponse — #2034 hop-end', #2852 주석)에도 개별적으로 고정돼 있다. 이
 * 파일은 탑승/하차 두 채널을 한 파일에서 나란히 대조하는 것이 목적이며, 기존 테스트의
 * 기대값은 변경하지 않는다.
 */
import * as Notifications from 'expo-notifications';
import { handleResponse } from '../useBoardingPromptResponder';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  DISEMBARK_ACTION_DISEMBARKED,
  DISEMBARK_ACTION_NOT_YET,
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
jest.mock('../../store/useLegAdvanceStore', () => {
  const mockStampLegAdvance = jest.fn();
  return {
    useLegAdvanceStore: {
      getState: () => ({ stampLegAdvance: mockStampLegAdvance }),
    },
    __mockStampLegAdvance: mockStampLegAdvance,
  };
});
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

const { __mockCreateLock: createLockMock, __mockReleaseLock: releaseLockMock } = jest.requireMock(
  '../../store/useBoardingLockStore',
);
const { __mockStampLegAdvance: stampLegAdvanceMock } = jest.requireMock('../../store/useLegAdvanceStore');

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
  nextLine: '5', // 유효한 LineNumber — stampLegAdvance(nextLine) 호출 경로를 고정하기 위함.
  nextStation: '왕십리',
};

describe('#2889 재현 — 탑승 확정 vs 하차(hop-end) 확정 채널 경계', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 대조군(control): 승차 프롬프트 응답 → postBoardingConfirm 호출됨.
  // 현재 dev에서 정상 동작하는 경로이며, 이 경계가 바뀌어도 이 경로는 무변경이어야 한다.
  it('[대조군] 승차(boarding) 프롬프트 [탑승] 응답 → postBoardingConfirm이 호출된다', async () => {
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, BOARDING_PAYLOAD, makeDeps());

    expect(positionUpload.postBoardingConfirm).toHaveBeenCalledWith(
      'tok-board',
      'boarded',
      '성수',
      '2',
    );
  });

  // 설계 경계 고정(boundary pin): hop-end(환승역 "하차했나요?") [하차함] 확정 응답은
  // postBoardingConfirm을 호출하지 않는다 — 결함이 아니라 설계 의도다(파일 상단 설명 참고,
  // #2282/#2278/#2287). backend는 이 프롬프트를 발사한 시점에 이미
  // hopEndPromptState[legKey].fired=true로 stamp를 마쳤으므로, 사용자의 [하차함] 응답은
  // device-local 반영(releaseLock + stampLegAdvance)만으로 충분하다.
  //
  // 이 테스트가 깨지고(= postBoardingConfirm이 호출되기 시작하고) 의도된 변경이 아니라면
  // 그것이 회귀다 — hop-end 확정과 탑승 확정이 뒤섞여 backend에 이중 confirm 신호가
  // 새어나가는 것을 의미한다.
  it(
    '[설계 경계 고정] hop-end(환승역 하차 확인) [하차함] 응답 → postBoardingConfirm은 ' +
      '호출되지 않는다 (결함 아님 — backend는 발사 시점에 이미 fired=true로 stamp 완료)',
    async () => {
      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeDeps(),
      );

      expect(positionUpload.postBoardingConfirm).not.toHaveBeenCalled();
    },
  );

  // hop-end [하차함] 확정이 "backend에 전혀 반영되지 않는다"는 오해를 막기 위해, 실제로
  // 무엇으로 상태가 반영되는지 명시적으로 고정한다 — device-local releaseLock('user') +
  // stampLegAdvance(nextLine). dismissBoardingPrompt(backend POST)는 이 확정 경로에서는
  // 호출되지 않는다(= backend에 새로 전달할 사실이 없다는 설계 의도, 위 주석 참고).
  it(
    '[설계 경계 고정] hop-end [하차함] 응답 → releaseLock("user") + stampLegAdvance(nextLine)로 ' +
      'device-local 반영, dismissBoardingPrompt(backend POST)는 호출하지 않는다',
    async () => {
      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeDeps(),
      );

      expect(releaseLockMock).toHaveBeenCalledWith('user');
      expect(stampLegAdvanceMock).toHaveBeenCalledWith('5');
      expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
    },
  );

  // hop-end가 backend에 "전혀" 반영 안 되는 게 아니라는 것을 보여주는 대조: [아직]
  // (NOT_YET) 응답은 5분 재발사 억제를 위해 dismissBoardingPrompt로 backend에 POST된다
  // (실측에서 200 확인) — 이것이 hop-end의 실제 backend 반영 채널 중 하나다.
  it(
    '[대조군] hop-end [아직](NOT_YET) 응답 → dismissBoardingPrompt(backend POST)가 호출된다 ' +
      '(hop-end가 backend에 반영되는 실제 채널)',
    async () => {
      await handleResponse(DISEMBARK_ACTION_NOT_YET, HOP_END_PAYLOAD, makeDeps());

      expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok-hopend');
      expect(positionUpload.postBoardingConfirm).not.toHaveBeenCalled();
    },
  );

  // 같은 종류로 보이는 "확정" 응답(탑승 vs 하차)이 backend로 가는 채널이 다르다는 것을
  // 한 assertion에서 나란히 비교 — 비대칭은 결함이 아니라 두 채널의 의미가 다르기 때문이다.
  it('탑승 확정과 하차 확정은 backend로 가는 채널이 다르다 (경계 고정, 결함 아님)', async () => {
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, BOARDING_PAYLOAD, makeDeps());
    const boardingConfirmAfterBoarding = (positionUpload.postBoardingConfirm as jest.Mock).mock
      .calls.length;

    await handleResponse(DISEMBARK_ACTION_DISEMBARKED, HOP_END_PAYLOAD, makeDeps());
    const boardingConfirmAfterHopEnd = (positionUpload.postBoardingConfirm as jest.Mock).mock
      .calls.length;

    expect(boardingConfirmAfterBoarding).toBe(1); // 탑승 확정 → postBoardingConfirm 채널.
    expect(boardingConfirmAfterHopEnd).toBe(1); // 하차 확정 후에도 불변 → 별도 채널(local) 사용.
    expect(releaseLockMock).toHaveBeenCalledWith('user'); // 하차 확정의 실제 반영 채널.
  });
});
