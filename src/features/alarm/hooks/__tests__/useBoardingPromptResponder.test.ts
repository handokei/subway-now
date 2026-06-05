import * as Notifications from 'expo-notifications';
import {
  extractBoardingPromptPayload,
  handleResponse,
  useBoardingPromptResponder,
} from '../useBoardingPromptResponder';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
} from '../../utils/notificationCategory';
import * as positionUpload from '../../../nearest-station/api/positionUpload';
import { renderHook } from '@testing-library/react-native';
import type { StationArrival } from '../../../arrival/api/arrivalApi';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
jest.mock('../../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: jest.fn(),
}));
jest.mock('../../../nearest-station/utils/stationLookup', () => ({
  findStationByNameAndLine: jest.fn(),
}));
jest.mock('../../../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// useBoardingLockStore mock — createLock 호출 검증용. jest.mock는 호이스팅되므로 모듈 내부 변수
// 직접 참조 금지 — `mock` prefix 가진 변수만 허용. 외부 캡처 변수 대신 jest.fn()을 mock 내부에서
// 만들고, 테스트는 requireMock으로 접근한다.
jest.mock('../../store/useBoardingLockStore', () => {
  const mockCreateLock = jest.fn();
  return {
    useBoardingLockStore: Object.assign(
      (selector: (state: { createLock: jest.Mock }) => unknown) =>
        selector({ createLock: mockCreateLock }),
      {
        getState: () => ({ createLock: mockCreateLock }),
      },
    ),
    __mockCreateLock: mockCreateLock,
  };
});

const { findStationByNameAndLine } = jest.requireMock('../../../nearest-station/utils/stationLookup');
const { __mockCreateLock: createLockMock } = jest.requireMock(
  '../../store/useBoardingLockStore',
);

function makeArrival(overrides: Partial<StationArrival['up'][number]> = {}): StationArrival {
  return {
    up: [
      {
        destination: '',
        arrivalMinutes: 1,
        arrivalSeconds: 60,
        statusMessage: '',
        trainCode: 'T1',
        line: '2',
        receivedAtMs: 0,
        arrivalCode: 2,
        isLastTrain: false,
        trainType: 'normal',
        ...overrides,
      },
    ],
    down: [],
  };
}

describe('extractBoardingPromptPayload', () => {
  it('valid payload → 보존', () => {
    expect(
      extractBoardingPromptPayload({
        kind: 'boarding-prompt',
        originStation: '강남',
        line: '2',
        tripToken: 'tok',
      }),
    ).toEqual({
      kind: 'boarding-prompt',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
    });
  });

  it.each([
    ['null', null],
    ['string', 'oops'],
    ['kind 다른 값', { kind: 'reschedule', originStation: 'S', line: 'L', tripToken: 'T' }],
    ['originStation 누락', { kind: 'boarding-prompt', line: 'L', tripToken: 'T' }],
    ['originStation 빈 문자열', { kind: 'boarding-prompt', originStation: '', line: 'L', tripToken: 'T' }],
    ['line 누락', { kind: 'boarding-prompt', originStation: 'S', tripToken: 'T' }],
    ['line 빈 문자열', { kind: 'boarding-prompt', originStation: 'S', line: '', tripToken: 'T' }],
    ['tripToken 누락', { kind: 'boarding-prompt', originStation: 'S', line: 'L' }],
    ['tripToken 빈 문자열', { kind: 'boarding-prompt', originStation: 'S', line: 'L', tripToken: '' }],
  ])('invalid payload — %s → null', (_label, input) => {
    expect(extractBoardingPromptPayload(input)).toBeNull();
  });
});

describe('handleResponse — boarding-prompt 분기 (#819)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const PAYLOAD = {
    kind: 'boarding-prompt' as const,
    originStation: '강남',
    line: '2',
    tripToken: 'tok',
  };

  function makeDeps(overrides: Partial<Parameters<typeof handleResponse>[2]> = {}) {
    return {
      fetchArrivalsForStation: jest.fn(async () => makeArrival()),
      destinationId: 'dst',
      expectedDurationMs: 600_000,
      createLock: createLockMock,
      ...overrides,
    };
  }

  it('[탑승] 액션 + 후보 명확 + station 매칭 → createLock 호출', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const deps = makeDeps();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.fetchArrivalsForStation).toHaveBeenCalledWith('강남');
    expect(createLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: 'dst',
        trainCode: 'T1',
        boardingStationId: 'S1',
        boardingLine: '2',
        expectedDurationMs: 600_000,
      }),
    );
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
  });

  it('기본 탭 ($default) → boarded 분기와 동일 처리', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const deps = makeDeps();
    await handleResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, PAYLOAD, deps);
    expect(createLockMock).toHaveBeenCalled();
  });

  it('[미탑승] 액션 → dismissBoardingPrompt 호출 (lock 미생성)', async () => {
    const deps = makeDeps();
    await handleResponse(BOARDING_PROMPT_ACTION_NOT_BOARDED, PAYLOAD, deps);
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok');
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('dismiss(불명 액션) → dismissBoardingPrompt', async () => {
    const deps = makeDeps();
    await handleResponse('SOME_OTHER_ACTION', PAYLOAD, deps);
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok');
  });

  it('destinationId null → dismiss POST만 발사 (lock 시도 안 함)', async () => {
    const deps = makeDeps({ destinationId: null });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.fetchArrivalsForStation).not.toHaveBeenCalled();
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok');
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('arrivals null → fallback to manual (createLock/dismiss 없음)', async () => {
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
  });

  it('ambiguity (같은 priority 후보 2+) → manual fallback, lock 안 함', async () => {
    const arrival: StationArrival = {
      up: [
        {
          destination: '',
          arrivalMinutes: 1,
          arrivalSeconds: 60,
          statusMessage: '',
          trainCode: 'T1',
          line: '2',
          receivedAtMs: 0,
          arrivalCode: 2,
          isLastTrain: false,
          trainType: 'normal',
        },
        {
          destination: '',
          arrivalMinutes: 2,
          arrivalSeconds: 120,
          statusMessage: '',
          trainCode: 'T2',
          line: '2',
          receivedAtMs: 0,
          arrivalCode: 2,
          isLastTrain: false,
          trainType: 'normal',
        },
      ],
      down: [],
    };
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => arrival) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('station lookup 실패 → manual fallback (createLock 안 함)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
    const deps = makeDeps();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('arrivalSeconds <= 0인 후보는 필터됨 (지나간 열차 lock 차단)', async () => {
    const arrival: StationArrival = {
      up: [
        {
          destination: '',
          arrivalMinutes: 0,
          arrivalSeconds: 0,
          statusMessage: '',
          trainCode: 'T-old',
          line: '2',
          receivedAtMs: 0,
          arrivalCode: 2,
          isLastTrain: false,
          trainType: 'normal',
        },
      ],
      down: [],
    };
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => arrival) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('line 불일치 후보는 필터됨', async () => {
    const arrival: StationArrival = {
      up: [
        {
          destination: '',
          arrivalMinutes: 1,
          arrivalSeconds: 60,
          statusMessage: '',
          trainCode: 'T1',
          line: '9',
          receivedAtMs: 0,
          arrivalCode: 2,
          isLastTrain: false,
          trainType: 'normal',
        },
      ],
      down: [],
    };
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => arrival) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });
});

describe('useBoardingPromptResponder hook wiring', () => {
  let registeredHandler: ((response: any) => void) | null = null;
  const subscriptionRemove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandler = null;
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementation(
      (handler) => {
        registeredHandler = handler;
        return { remove: subscriptionRemove };
      },
    );
  });

  it('listener 등록 후 boarding-prompt payload 수신 시 handleResponse 분기 진입', () => {
    const fetchArrivalsForStation = jest.fn(async () => makeArrival());
    renderHook(() =>
      useBoardingPromptResponder({
        fetchArrivalsForStation,
        destinationId: 'dst',
        expectedDurationMs: 600_000,
      }),
    );
    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(registeredHandler).not.toBeNull();

    // boarding-prompt 아닌 payload — 무시
    registeredHandler!({
      actionIdentifier: BOARDING_PROMPT_ACTION_BOARDED,
      notification: { request: { content: { data: { kind: 'reschedule' } } } },
    });
    expect(fetchArrivalsForStation).not.toHaveBeenCalled();
  });

  it('unmount 시 subscription remove', () => {
    const { unmount } = renderHook(() =>
      useBoardingPromptResponder({
        fetchArrivalsForStation: jest.fn(),
        destinationId: 'dst',
        expectedDurationMs: 600_000,
      }),
    );
    unmount();
    expect(subscriptionRemove).toHaveBeenCalled();
  });

  it('valid payload 수신 시 handleResponse 발화 (createLock 또는 dismiss)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    renderHook(() =>
      useBoardingPromptResponder({
        fetchArrivalsForStation: async () => makeArrival(),
        destinationId: 'dst',
        expectedDurationMs: 600_000,
      }),
    );
    await registeredHandler!({
      actionIdentifier: BOARDING_PROMPT_ACTION_BOARDED,
      notification: {
        request: {
          content: {
            data: {
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'tok',
            },
          },
        },
      },
    });
    // hook의 비동기 handleResponse 처리 후 검증
    await new Promise((r) => setTimeout(r, 0));
    expect(createLockMock).toHaveBeenCalled();
  });
});
