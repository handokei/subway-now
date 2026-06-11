/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
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
import type { StationArrival } from '../../../../shared/types/arrival';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
jest.mock('../../../nearest-station/api/positionUpload', () => ({
  dismissBoardingPrompt: jest.fn(),
}));
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: jest.fn(),
}));
jest.mock('../../utils/alarmLog', () => ({
  logBoardingPromptAutoLock: jest.fn(),
  logBoardingPromptResponded: jest.fn(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
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

const { findStationByNameAndLine } = jest.requireMock('../../../../shared/utils/stationLookup');
const { logBoardingPromptAutoLock, logBoardingPromptResponded } = jest.requireMock('../../utils/alarmLog');
const { __mockCreateLock: createLockMock } = jest.requireMock(
  '../../store/useBoardingLockStore',
);

type UpEntry = StationArrival['up'][number];

function makeUpEntry(overrides: Partial<UpEntry> = {}): UpEntry {
  return {
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
  };
}

function makeArrival(overrides: Partial<UpEntry> = {}): StationArrival {
  return { up: [makeUpEntry(overrides)], down: [] };
}

function makeArrivalWithUp(entries: Partial<UpEntry>[]): StationArrival {
  return { up: entries.map(makeUpEntry), down: [] };
}

// 두 후보 같은 priority 케이스 — ambiguity fallback 측정용 (행동 + telemetry 양쪽 공유).
const AMBIGUOUS_TRAINS: Partial<UpEntry>[] = [
  { arrivalMinutes: 1, arrivalSeconds: 60, trainCode: 'T1' },
  { arrivalMinutes: 2, arrivalSeconds: 120, trainCode: 'T2' },
];

// line 불일치 단일 후보 — empty candidate set 케이스 공유 (행동 + telemetry).
const LINE_MISMATCH_TRAIN: Partial<UpEntry>[] = [{ line: '9' }];

// 공통 fixture — handleResponse describe 블록 2개(#819 행동, #1170 telemetry)가 공유.
// 모듈 스코프로 끌어올려 중복 제거 (SonarCloud dup).
const HANDLE_RESPONSE_PAYLOAD = {
  kind: 'boarding-prompt' as const,
  originStation: '강남',
  line: '2',
  tripToken: 'tok',
};

function makeHandleResponseDeps(
  overrides: Partial<Parameters<typeof handleResponse>[2]> = {},
) {
  return {
    fetchArrivalsForStation: jest.fn(async () => makeArrival()),
    destinationId: 'dst',
    expectedDurationMs: 600_000,
    createLock: createLockMock,
    ...overrides,
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

  const PAYLOAD = HANDLE_RESPONSE_PAYLOAD;
  const makeDeps = makeHandleResponseDeps;

  it('[탑승] 액션 + 후보 명확 + station 매칭 → createLock 호출 + initialEtaSeconds 스냅샷(#897)', async () => {
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
        // #897 Seam A: auto-lock 시점의 ETA(makeArrival 기본=60s) 스냅샷.
        initialEtaSeconds: 60,
      }),
    );
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
    // #1167 — autolock-success telemetry
    expect(logBoardingPromptAutoLock).toHaveBeenCalledWith({
      reason: 'autolock-success',
      originStation: '강남',
      line: '2',
    });
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
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(AMBIGUOUS_TRAINS)),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it('station lookup 실패 → manual fallback (createLock 안 함)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
    const deps = makeDeps();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  it.each([
    ['arrivalSeconds <= 0 (지나간 열차)', [{ arrivalMinutes: 0, arrivalSeconds: 0, trainCode: 'T-old' }]],
    ['line 불일치', LINE_MISMATCH_TRAIN],
  ])('후보 필터링 — %s → lock 안 함', async (_label, entries) => {
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(entries)),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
  });

  // #1167 — autoLock telemetry. 모든 케이스가 같은 형태로 logBoardingPromptAutoLock을 호출한다.
  // setup만 다르고 expected reason 1개만 다르므로 it.each + setup factory로 일반화.
  type AutoLockReason =
    | 'autolock-no-trip'
    | 'autolock-arrivals-empty'
    | 'autolock-ambiguity'
    | 'autolock-station-lookup'
    | 'autolock-lock-failed';

  const STATION_MATCH = { id: 'S1', line: '2', name: '강남' };

  // 각 케이스는 deps override + 사전 mock setup을 반환. handleResponse 호출과 assertion은 공통.
  const autoLockCases: Array<[
    string,
    AutoLockReason,
    () => Partial<Parameters<typeof makeDeps>[0]>,
  ]> = [
    ['destinationId null', 'autolock-no-trip', () => ({ destinationId: null })],
    [
      'arrivals null',
      'autolock-arrivals-empty',
      () => ({ fetchArrivalsForStation: jest.fn(async () => null) }),
    ],
    [
      'line 후보 0개 (모두 필터됨)',
      'autolock-arrivals-empty',
      () => ({
        fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(LINE_MISMATCH_TRAIN)),
      }),
    ],
    [
      'ambiguity (same priority 후보 2+)',
      'autolock-ambiguity',
      () => ({
        fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(AMBIGUOUS_TRAINS)),
      }),
    ],
    [
      'station lookup 실패',
      'autolock-station-lookup',
      () => {
        (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
        return {};
      },
    ],
    [
      'createLock 예외 (manual fallback + swallow)',
      'autolock-lock-failed',
      () => {
        (findStationByNameAndLine as jest.Mock).mockReturnValue(STATION_MATCH);
        return {
          createLock: jest.fn(async () => {
            throw new Error('storage write failed');
          }),
        };
      },
    ],
  ];

  it.each(autoLockCases)('telemetry — %s → %s', async (_label, reason, setup) => {
    const deps = makeDeps(setup());
    await expect(
      handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps),
    ).resolves.toBeUndefined();
    expect(logBoardingPromptAutoLock).toHaveBeenCalledWith({
      reason,
      originStation: '강남',
      line: '2',
    });
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

describe('handleResponse — #1170 응답 telemetry (logBoardingPromptResponded)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each<[string, string, 'boarded' | 'dismissed']>([
    ['[탑승] 액션', BOARDING_PROMPT_ACTION_BOARDED, 'boarded'],
    ['기본 탭 ($default)', Notifications.DEFAULT_ACTION_IDENTIFIER, 'boarded'],
    ['[미탑승] 액션', BOARDING_PROMPT_ACTION_NOT_BOARDED, 'dismissed'],
    ['알 수 없는 액션', 'SOME_OTHER_ACTION', 'dismissed'],
  ])('%s → logBoardingPromptResponded({outcome: "%s"})', async (_label, action, outcome) => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    await handleResponse(action, HANDLE_RESPONSE_PAYLOAD, makeHandleResponseDeps());
    expect(logBoardingPromptResponded).toHaveBeenCalledWith({ outcome });
  });
});
