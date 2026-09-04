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
  DISEMBARK_ACTION_DISEMBARKED,
  DISEMBARK_ACTION_NOT_YET,
} from '../../utils/notificationCategory';
import * as positionUpload from '../../../nearest-station/api/positionUpload';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook } from '@testing-library/react-native';
import type { StationArrival } from '../../../../shared/types/arrival';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import { makeTransferRoute } from '../../../../testUtils/routeFixtures';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
// #2408 — 위험1 guard: BG_LAST_STATION_KEY read. 기본값은 부재(null) → guard 미작동(기존 동작).
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
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
  logBoardingPromptFired: jest.fn(),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
}));
jest.mock('../useBoardingPromptDisplayLogger', () => {
  const seen = new Set<string>();
  return {
    wasBoardingPromptDisplayed: jest.fn((id: string) => seen.has(id)),
    markBoardingPromptDisplayed: jest.fn((id: string) => {
      seen.add(id);
    }),
    __resetMockDedup: () => seen.clear(),
  };
});
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
  const mockReleaseLock = jest.fn(() => Promise.resolve());
  return {
    useBoardingLockStore: Object.assign(
      (selector: (state: { createLock: jest.Mock; releaseLock: jest.Mock }) => unknown) =>
        selector({ createLock: mockCreateLock, releaseLock: mockReleaseLock }),
      {
        getState: () => ({ createLock: mockCreateLock, releaseLock: mockReleaseLock }),
      },
    ),
    __mockCreateLock: mockCreateLock,
    __mockReleaseLock: mockReleaseLock,
  };
});

// #1923 — useUserIntentStore mock. tryAutoLock 진입 시 setInfoModeEnabled(true) 호출 검증.
jest.mock('../../store/useUserIntentStore', () => {
  const mockSetInfoModeEnabled = jest.fn(() => Promise.resolve());
  return {
    useUserIntentStore: {
      getState: () => ({ setInfoModeEnabled: mockSetInfoModeEnabled }),
    },
    __mockSetInfoModeEnabled: mockSetInfoModeEnabled,
  };
});

// #2371 — useNavigationStore mock. boarded path 진입 시 startNavigation() 호출 검증
// (#2306 RCA — 잠금 시 BG GPS 미시작 회귀 fix).
jest.mock('../../../route/store/useNavigationStore', () => {
  const mockStartNavigation = jest.fn();
  return {
    useNavigationStore: {
      getState: () => ({ startNavigation: mockStartNavigation }),
    },
    __mockStartNavigation: mockStartNavigation,
  };
});

// #2278 — useLegAdvanceStore mock. hop-end BOARDED 응답에서 stampLegAdvance 호출 검증.
jest.mock('../../store/useLegAdvanceStore', () => {
  const mockStampLegAdvance = jest.fn();
  return {
    useLegAdvanceStore: {
      getState: () => ({ stampLegAdvance: mockStampLegAdvance }),
    },
    __mockStampLegAdvance: mockStampLegAdvance,
  };
});

// #2410 — nextLine 무효 시 route derive fallback. parseBgLastStation은 실제 구현 유지
// (#2408 위험1 guard 테스트가 이미 real 함수에 의존), readWidgetRefreshContext만 mock해
// route/destination fixture를 직접 제어한다.
jest.mock('../../utils/widgetRefreshContext', () => {
  const actual = jest.requireActual('../../utils/widgetRefreshContext');
  const mockReadWidgetRefreshContext = jest.fn(async () => ({
    destination: null,
    route: null,
    bgContext: null,
  }));
  return {
    ...actual,
    readWidgetRefreshContext: mockReadWidgetRefreshContext,
    __mockReadWidgetRefreshContext: mockReadWidgetRefreshContext,
  };
});

// #2410 — findLocklessTransferWaypoint mock. 실 stations.json 데이터 의존 없이
// route derive 성공/실패 분기를 직접 제어한다.
jest.mock('../../../route/utils/findActiveTransferContext', () => ({
  findLocklessTransferWaypoint: jest.fn(() => null),
}));

const { findStationByNameAndLine } = jest.requireMock('../../../../shared/utils/stationLookup');
const {
  logBoardingPromptAutoLock,
  logBoardingPromptResponded,
  logBoardingPromptFired,
} = jest.requireMock('../../utils/alarmLog');
const { addDomainBreadcrumb } = jest.requireMock(
  '../../../../shared/infra/monitoring/breadcrumb',
);
const { __mockCreateLock: createLockMock, __mockReleaseLock: releaseLockMock } = jest.requireMock(
  '../../store/useBoardingLockStore',
);
const { __mockSetInfoModeEnabled: setInfoModeEnabledMock } = jest.requireMock(
  '../../store/useUserIntentStore',
);
const { __mockStartNavigation: startNavigationMock } = jest.requireMock(
  '../../../route/store/useNavigationStore',
);
const { __mockStampLegAdvance: stampLegAdvanceMock } = jest.requireMock(
  '../../store/useLegAdvanceStore',
);
const { __mockReadWidgetRefreshContext: readWidgetRefreshContextMock } = jest.requireMock(
  '../../utils/widgetRefreshContext',
);
const { findLocklessTransferWaypoint: findLocklessTransferWaypointMock } = jest.requireMock(
  '../../../route/utils/findActiveTransferContext',
);
const displayLoggerMock = jest.requireMock('../useBoardingPromptDisplayLogger');

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

function makeArrivalBothDirections(
  upEntries: Partial<UpEntry>[],
  downEntries: Partial<UpEntry>[],
): StationArrival {
  return { up: upEntries.map(makeUpEntry), down: downEntries.map(makeUpEntry) };
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

// #2407 — pending fallback lock(trainCode=PENDING_TRAIN_CODE) 생성 assertion 공통 헬퍼.
function expectPendingFallbackLockCalled(boardingLine?: string): void {
  expect(createLockMock).toHaveBeenCalledWith(
    boardingLine === undefined
      ? expect.objectContaining({ trainCode: PENDING_TRAIN_CODE })
      : expect.objectContaining({ trainCode: PENDING_TRAIN_CODE, boardingLine }),
    false,
    'boarding-prompt-response',
  );
}

// #2407/#2408 — logBoardingPromptAutoLock({ reason, originStation, line }) 호출 assertion
// 공통 헬퍼. originStation/line은 이 describe 전역에서 '강남'/'2'로 고정된 케이스가 대부분.
function expectAutoLockLogged(
  reason: string,
  originStation: string = '강남',
  line: string = '2',
): void {
  expect(logBoardingPromptAutoLock).toHaveBeenCalledWith({ reason, originStation, line });
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
      destinationDirection: undefined,
    });
  });

  it('#1740 — destinationDirection: "up" 포함 → 보존', () => {
    expect(
      extractBoardingPromptPayload({
        kind: 'boarding-prompt',
        originStation: '강남',
        line: '2',
        tripToken: 'tok',
        destinationDirection: 'up',
      }),
    ).toEqual({
      kind: 'boarding-prompt',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
      destinationDirection: 'up',
    });
  });

  it('#1740 — destinationDirection: "down" 포함 → 보존', () => {
    const result = extractBoardingPromptPayload({
      kind: 'boarding-prompt',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
      destinationDirection: 'down',
    });
    expect(result?.destinationDirection).toBe('down');
  });

  it('#1740 — destinationDirection 잘못된 값 → undefined (backward compat)', () => {
    const result = extractBoardingPromptPayload({
      kind: 'boarding-prompt',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
      destinationDirection: 'invalid',
    });
    expect(result?.destinationDirection).toBeUndefined();
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
      // #2290 P2(재검토) — BOARDED 응답 = 사용자 탑승 상태 명시 확정 → evidence true.
      true,
      // #2152 — boardingPrompt 응답 경로 lifecycle breadcrumb source.
      'boarding-prompt-response',
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

  // 진짜 trip 종료(storage에도 destination 없음) — dismiss만, lock 시도 안 함.
  // readWidgetRefreshContextMock 기본값(destination: null)을 그대로 사용.
  it('destinationId null + storage에도 destination 없음(진짜 trip 종료) → dismiss POST만 발사 (lock 시도 안 함)', async () => {
    const deps = makeDeps({ destinationId: null });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.fetchArrivalsForStation).not.toHaveBeenCalled();
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok');
    expect(createLockMock).not.toHaveBeenCalled();
  });

  // #2430 (cold-start race) — 알림의 "탑승했어요" 액션은 opensAppToForeground:true라
  // 탭 시 앱이 cold-start된다. HomeScreen의 destination store가 hydrate되기 전에 이 listener가
  // 응답을 처리하면 deps.destinationId(in-memory)는 일시 null이지만, trip은 여전히 활성이고
  // AsyncStorage(DESTINATION_KEY)에는 올바른 destination이 남아 있다(진짜 trip 종료 시에만 storage도
  // clear됨). storage live-read로 hydrate-전 일시 null과 진짜 종료를 구분해야 한다.
  it('#2430 destinationId null이지만 storage에 destination 존재(cold-start race) → storage 값으로 lock 생성', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    readWidgetRefreshContextMock.mockResolvedValueOnce({
      destination: { id: 'dst-from-storage', name: '잠실', line: '2' },
      route: null,
      bgContext: null,
    });
    const deps = makeDeps({ destinationId: null });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(deps.fetchArrivalsForStation).toHaveBeenCalledWith('강남');
    expect(createLockMock).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 'dst-from-storage', trainCode: 'T1' }),
      true,
      'boarding-prompt-response',
    );
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
    expect(logBoardingPromptAutoLock).toHaveBeenCalledWith({
      reason: 'autolock-success',
      originStation: '강남',
      line: '2',
    });
  });

  // #2407 (root fix) — train 확정 실패해도 lock은 생성한다(ADR-014 명시 탭=lock 동급).
  it('arrivals null → pending fallback lock 생성 (#2407, dismiss는 발사 안 함)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
  });

  // #2407 — ambiguity도 "탭했는데 train을 못 골랐다"는 동일 실패 모드라 pending fallback lock 대상.
  it('ambiguity (같은 priority 후보 2+) → pending fallback lock 생성 (#2407)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(AMBIGUOUS_TRAINS)),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
  });

  // #2407 — pending fallback lock도 payload.line이 유효 LineNumber가 아니면 생성 불가(극히
  // 드문 데이터 이상). manual fallback graceful skip.
  it('#2407 — pending fallback: payload.line이 유효하지 않으면 createLock 안 함', async () => {
    const invalidPayload = { ...PAYLOAD, line: '99' };
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, invalidPayload, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expectAutoLockLogged('autolock-station-lookup', '강남', '99');
  });

  // #2407 — pending fallback: station lookup 자체가 실패하면 lock 없이 graceful skip.
  it('#2407 — pending fallback: station lookup 실패 → createLock 안 함', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expectAutoLockLogged('autolock-station-lookup');
  });

  // #2407 — pending fallback createLock이 실패해도(storage/network 예외) 응답 처리는 graceful.
  it('#2407 — pending fallback: createLock 예외 시 graceful (autolock-lock-failed telemetry)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const failingCreateLock = jest.fn().mockRejectedValue(new Error('storage full'));
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () => null),
      createLock: failingCreateLock,
    });
    await expect(handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps)).resolves.toBeUndefined();
    expectAutoLockLogged('autolock-lock-failed');
  });

  // #2408 — 위험1 guard: stale prompt → 잘못된 lock 방지. BG_LAST_STATION mock helper.
  function mockBgLastStation(line: string, ageMs: number, name = '용마산'): void {
    (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () =>
      JSON.stringify({
        station: { id: 'BG1', line, name },
        distanceKm: 0.1,
        timestamp: Date.now() - ageMs,
      }),
    );
  }

  it('#2408 — fresh BG_LAST_STATION이 payload.line과 모순 → createLock 미호출(skip)', async () => {
    // 이름까지 다른 진짜 다른 역(용마산 vs 강남) — findStationByNameAndLine은 인자별로
    // 실제 역 매칭 여부를 흉내낸다(용마산은 2호선에 없음 → null).
    (findStationByNameAndLine as jest.Mock).mockImplementation(
      (name: string, line: string) => (name === '강남' && line === '2' ? { id: 'S1', line: '2', name: '강남' } : null),
    );
    mockBgLastStation('7', 0); // 7호선(용마산)에 있는데 payload.line='2'(강남) — 모순.
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expectAutoLockLogged('fallback-skipped-position-contradiction');
  });

  // #2408 Gap A (root fix) — 환승역(예: 건대입구=2호선+7호선)에서 BG fusion이 payload.line과
  // 다른 노선으로 최근접역을 stamp해도 같은 물리적 역이면 진짜 모순이 아니다. line만 비교하는
  // 구 guard는 이 케이스를 오판해 lock 생성을 skip(lockless cascade)했다.
  it('#2408 Gap A — 환승역에서 BG_LAST_STATION이 다른(그러나 유효한) 노선으로 관측 → 같은 물리적 역이면 모순 아님, pending fallback lock 생성', async () => {
    const transferPayload = { ...PAYLOAD, originStation: '건대입구', line: '2' };
    (findStationByNameAndLine as jest.Mock).mockImplementation((name: string, line: string) =>
      name === '건대입구' && (line === '2' || line === '7')
        ? { id: `${line}-X`, line, name: '건대입구' }
        : null,
    );
    mockBgLastStation('7', 0, '건대입구'); // BG_LAST_STATION: 건대입구 7호선. prompt: 건대입구 2호선.
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, transferPayload, deps);
    expectPendingFallbackLockCalled('2');
    expectAutoLockLogged('autolock-fallback-pending', '건대입구', '2');
  });

  // #2408 Gap A — false-positive 방어: line이 payload.line 위에서 둘 다 유효한 역으로 resolve돼도
  // station 이름 자체가 다르면(진짜 다른 물리적 역) 여전히 모순으로 skip해야 한다. "bg station이
  // payload.line 위에 존재하는지"만 보고 통과시키면 안 된다 — identity(이름) 비교가 필수.
  it('#2408 Gap A — 서로 다른 진짜 역(둘 다 payload.line에 존재)은 여전히 모순으로 skip', async () => {
    (findStationByNameAndLine as jest.Mock).mockImplementation((name: string, line: string) => {
      if (name === '강남' && line === '2') return { id: '2-S', line: '2', name: '강남' };
      if (name === '왕십리' && line === '2') return { id: '2-W', line: '2', name: '왕십리' };
      return null;
    });
    mockBgLastStation('5', 0, '왕십리'); // 왕십리(5호선) — 강남과 다른 물리적 위치.
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expectAutoLockLogged('fallback-skipped-position-contradiction');
  });

  // #2408 Gap A — payload.line 자체가 유효한 LineNumber가 아니면(데이터 이상) 환승역 동일성
  // 검증(promptLine 조회)이 애초에 불가능하다 — 검증 불가는 모순으로 간주해 기존대로 skip.
  it('#2408 Gap A — payload.line이 유효하지 않으면 환승역 판정 skip, 위치 모순으로 처리', async () => {
    const invalidLinePayload = { ...PAYLOAD, line: '99' };
    (findStationByNameAndLine as jest.Mock).mockReturnValue(null);
    mockBgLastStation('7', 0); // bgContext line('7') !== payload.line('99') — 모순.
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, invalidLinePayload, deps);
    expect(createLockMock).not.toHaveBeenCalled();
    expectAutoLockLogged('fallback-skipped-position-contradiction', '강남', '99');
  });

  it('#2408 — BG_LAST_STATION line이 payload.line과 일치 → 기존대로 pending fallback lock 생성', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    mockBgLastStation('2', 0);
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
    expectAutoLockLogged('autolock-fallback-pending');
  });

  it('#2408 — BG_LAST_STATION 부재(null) → 검증 불가, 기존대로 lock 생성(탭 신뢰)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () => null);
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
  });

  it('#2408 — BG_LAST_STATION stale(신선도 초과) → 검증 불가, 기존대로 lock 생성', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    // line 모순('7')이어도 신선도 초과(5분+1ms)면 guard 미작동 — 검증 불가로 간주.
    mockBgLastStation('7', 5 * 60_000 + 1);
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
  });

  it('#2408 — BG_LAST_STATION read 예외 → guard skip, 기존대로 lock 생성(graceful)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('IO error');
    });
    const deps = makeDeps({ fetchArrivalsForStation: jest.fn(async () => null) });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expectPendingFallbackLockCalled('2');
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

  // #1740 — destination 방향 filter 강화 테스트.
  it.each<['up' | 'down', string]>([
    ['up', 'UP1'],
    ['down', 'DOWN1'],
  ])(
    '#1740 — destinationDirection "%s" → %s 후보만 추림, 반대 후보 무시',
    async (direction, expectedTrainCode) => {
      (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
      const upTrain = { trainCode: 'UP1', arrivalCode: 2, line: '2' as const };
      const downTrain = { trainCode: 'DOWN1', arrivalCode: 2, line: '2' as const };
      const deps = makeDeps({
        fetchArrivalsForStation: jest.fn(async () =>
          makeArrivalBothDirections([upTrain], [downTrain]),
        ),
      });
      const payload = { ...PAYLOAD, destinationDirection: direction };
      await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, payload, deps);
      // 단일 방향 후보 → lock 생성, trainCode = 방향에 맞는 열차
      expect(createLockMock).toHaveBeenCalledWith(
        expect.objectContaining({ trainCode: expectedTrainCode }),
        true,
        'boarding-prompt-response',
      );
    },
  );

  // #2407 — up 후보 0건은 "line 매칭 0건" 실패 모드와 동일 — pending fallback lock 대상.
  it(
    '#1740 — destinationDirection "up" 지정 + up 후보 없음 → pending fallback lock 생성 ' +
      '(#2407, 반대 방향만 존재)',
    async () => {
      (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
      const downTrain = { trainCode: 'DOWN1', arrivalCode: 2, line: '2' as const };
      const deps = makeDeps({
        fetchArrivalsForStation: jest.fn(async () =>
          makeArrivalBothDirections([], [downTrain]),
        ),
      });
      const payload = { ...PAYLOAD, destinationDirection: 'up' as const };
      await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, payload, deps);
      expectPendingFallbackLockCalled('2');
    },
  );

  it('#1740 — destinationDirection undefined → 양방향 모두 후보 (backward compat)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const upTrain = { trainCode: 'UP1', arrivalCode: 2, line: '2' as const };
    const deps = makeDeps({
      fetchArrivalsForStation: jest.fn(async () =>
        makeArrivalBothDirections([upTrain], []),
      ),
    });
    // destinationDirection 미지정 — 기존 동작 유지
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, PAYLOAD, deps);
    expect(createLockMock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: 'UP1' }),
      true,
      'boarding-prompt-response',
    );
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
    displayLoggerMock.__resetMockDedup();
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

describe('useBoardingPromptResponder #1385 — cold-start fired 보완 + dedup', () => {
  let registeredHandler: ((response: any) => void) | null = null;

  function makeResponse(overrides: {
    identifier?: string;
    categoryIdentifier?: string | null | undefined;
    data?: unknown;
    actionIdentifier?: string;
  }) {
    return {
      actionIdentifier:
        overrides.actionIdentifier ?? Notifications.DEFAULT_ACTION_IDENTIFIER,
      notification: {
        request: {
          identifier: overrides.identifier ?? 'noti-cold-1',
          content: {
            categoryIdentifier:
              overrides.categoryIdentifier === undefined
                ? 'BOARDING_PROMPT'
                : overrides.categoryIdentifier,
            data:
              overrides.data ?? {
                kind: 'boarding-prompt',
                originStation: '강남',
                line: '2',
                tripToken: 'tok',
              },
          },
        },
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    registeredHandler = null;
    displayLoggerMock.__resetMockDedup();
    (findStationByNameAndLine as jest.Mock).mockReturnValue({
      id: 'S1',
      line: '2',
      name: '강남',
    });
    (Notifications.addNotificationResponseReceivedListener as jest.Mock).mockImplementation(
      (handler) => {
        registeredHandler = handler;
        return { remove: jest.fn() };
      },
    );
    renderHook(() =>
      useBoardingPromptResponder({
        fetchArrivalsForStation: async () => null,
        destinationId: 'dst',
        expectedDurationMs: 600_000,
      }),
    );
  });

  it('FG receive 못 잡은 cold-start 응답 → logBoardingPromptFired 호출 후 logBoardingPromptResponded', async () => {
    await registeredHandler!(makeResponse({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).toHaveBeenCalledWith({
      originStation: '강남',
      line: '2',
    });
    expect(logBoardingPromptResponded).toHaveBeenCalled();
  });

  it('FG receive 가 먼저 적재 → response 진입 시 dedup으로 fired 추가 호출 없음', async () => {
    // FG receive가 이미 적재한 상태를 시뮬레이션.
    displayLoggerMock.markBoardingPromptDisplayed('noti-cold-1');
    await registeredHandler!(makeResponse({ identifier: 'noti-cold-1' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
    // responded는 dedup과 무관하게 호출되어야 한다.
    expect(logBoardingPromptResponded).toHaveBeenCalled();
  });

  it('categoryIdentifier null (Android 등)이어도 payload 일치 시 cold-start fired 적재', async () => {
    await registeredHandler!(makeResponse({ categoryIdentifier: null }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
  });

  it('categoryIdentifier가 BOARDING_PROMPT가 아니고 payload만 일치 → cold-start fired 적재 안 함', async () => {
    await registeredHandler!(makeResponse({ categoryIdentifier: 'OTHER_CATEGORY' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
    // payload는 valid → responded는 정상 처리.
    expect(logBoardingPromptResponded).toHaveBeenCalled();
  });

  it('identifier 누락 → cold-start fired 적재 skip (responded는 정상)', async () => {
    await registeredHandler!(makeResponse({ identifier: '' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).not.toHaveBeenCalled();
    expect(logBoardingPromptResponded).toHaveBeenCalled();
  });

  it('같은 response identifier 재진입 → fired 1건만 (dedup)', async () => {
    await registeredHandler!(makeResponse({ identifier: 'dup-1' }));
    await registeredHandler!(makeResponse({ identifier: 'dup-1' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(logBoardingPromptFired).toHaveBeenCalledTimes(1);
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

// boarded-like / dismissed-like 액션 목록. #1923 infoModeEnabled stamp와 #2371
// navigationActive wire가 정확히 대칭이라 두 describe가 이 목록을 공유한다.
const BOARDED_LIKE_ACTIONS: [string, string][] = [
  ['[탑승] 액션', BOARDING_PROMPT_ACTION_BOARDED],
  ['기본 탭 ($default)', Notifications.DEFAULT_ACTION_IDENTIFIER],
];
const DISMISSED_LIKE_ACTIONS: [string, string][] = [
  ['[미탑승] 액션', BOARDING_PROMPT_ACTION_NOT_BOARDED],
  ['알 수 없는 액션', 'SOME_OTHER_ACTION'],
];

// boarded-like 액션마다 station lookup을 mock한 뒤 handleResponse를 호출하고 assertion을 실행.
function itEachBoardedLikeAction(title: string, assertion: () => void): void {
  it.each<[string, string]>(BOARDED_LIKE_ACTIONS)(title, async (_label, action) => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    await handleResponse(action, HANDLE_RESPONSE_PAYLOAD, makeHandleResponseDeps());
    assertion();
  });
}

// dismissed-like 액션마다 handleResponse를 호출하고 assertion을 실행 (station lookup mock 불필요).
function itEachDismissedLikeAction(title: string, assertion: () => void): void {
  it.each<[string, string]>(DISMISSED_LIKE_ACTIONS)(title, async (_label, action) => {
    await handleResponse(action, HANDLE_RESPONSE_PAYLOAD, makeHandleResponseDeps());
    assertion();
  });
}

// #1923 — 사용자 명시 의향 stamp. boarded path 진입 시 setInfoModeEnabled(true) 호출 검증.
// dismissed path는 stamp 안 함 (의향 표명 없음).
describe('handleResponse — #1923 infoModeEnabled stamp (사용자 명시 의향)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  itEachBoardedLikeAction('%s → useUserIntentStore.setInfoModeEnabled(true) 호출', () =>
    expect(setInfoModeEnabledMock).toHaveBeenCalledWith(true),
  );

  itEachDismissedLikeAction(
    '%s → setInfoModeEnabled 호출 안 함 (dismissed path는 의향 표명 없음)',
    () => expect(setInfoModeEnabledMock).not.toHaveBeenCalled(),
  );

  it('tryAutoLock 실패(arrivals null)해도 setInfoModeEnabled(true)는 호출 (의향 표명 사실은 실패와 무관)', async () => {
    const deps = makeHandleResponseDeps({
      fetchArrivalsForStation: jest.fn(async () => null),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(setInfoModeEnabledMock).toHaveBeenCalledWith(true);
  });

  it('destinationId null + [탑승] → setInfoModeEnabled(true)는 여전히 호출 (사용자가 boarded로 응답한 사실은 stamp)', async () => {
    const deps = makeHandleResponseDeps({ destinationId: null });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(setInfoModeEnabledMock).toHaveBeenCalledWith(true);
  });
});

// #2371 (Part of #2306) — boardingPrompt "탑승" 응답도 navigationActive를 켠다. 잠금 시 BG GPS
// 세션이 navigationActive에만 걸려 있어, 명시 의향을 표명해도 화면을 잠그면 BG GPS가 시작되지
// 않던 회귀(#2306 RCA)의 fix — infoMode stamp와 정확히 대칭으로 wire.
describe('handleResponse — #2371 navigationActive wire (BG GPS 시작 트리거)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  itEachBoardedLikeAction('%s → useNavigationStore.startNavigation() 호출', () =>
    expect(startNavigationMock).toHaveBeenCalledTimes(1),
  );

  itEachDismissedLikeAction(
    '%s → startNavigation 호출 안 함 (dismissed path는 의향 표명 없음)',
    () => expect(startNavigationMock).not.toHaveBeenCalled(),
  );
});

// #1888 (RC-13) — Interactive UI 작동 확인 + 빈 후보 graceful skip evidence.
// Sentry breadcrumb이 acceptance V/X dashboard 신호 (PR body 2단).
describe('handleResponse — #1888 RC-13 Sentry breadcrumb evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // V1: Interactive UI 작동. UNNotificationCategory가 노출되지 않았다면 OS가 액션 buttons를 그리지
  // 못해 이 breadcrumb이 발사되지 않는다. 발사 자체가 "Interactive 작동 확인" 신호.
  it.each<[string, string]>([
    ['[탑승] 액션', BOARDING_PROMPT_ACTION_BOARDED],
    ['기본 탭 ($default)', Notifications.DEFAULT_ACTION_IDENTIFIER],
    ['[미탑승] 액션', BOARDING_PROMPT_ACTION_NOT_BOARDED],
    ['알 수 없는 액션', 'SOME_OTHER_ACTION'],
  ])('%s → boarding_prompt_interactive_tap breadcrumb 발사', async (_label, action) => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    await handleResponse(action, HANDLE_RESPONSE_PAYLOAD, makeHandleResponseDeps());
    // #2034 — hopEndKind='boarding' 은 승차 prompt 기본값. hop-end 는 'disembark' 로 별개 test.
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_interactive_tap',
      { action, line: '2', hopEndKind: 'boarding' },
    );
  });

  // X-skip: 빈 후보(arrivals null) graceful skip. 1주 production: > 0 발생 시 candidate-generator
  // (arrivals fetch) 추가 보강 신호.
  it('arrivals null → boarding_prompt_empty_skip breadcrumb 발사 (reason: arrivals-null)', async () => {
    const deps = makeHandleResponseDeps({
      fetchArrivalsForStation: jest.fn(async () => null),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_empty_skip',
      { reason: 'arrivals-null', originStation: '강남', line: '2' },
    );
  });

  // X-skip: line 필터 후 0건 — 환승역에서 다른 호선만 도착해서 expected line 후보가 사라지는 케이스.
  it('line 후보 0개 → boarding_prompt_empty_skip breadcrumb 발사 (reason: line-filtered-empty)', async () => {
    const deps = makeHandleResponseDeps({
      fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(LINE_MISMATCH_TRAIN)),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_empty_skip',
      { reason: 'line-filtered-empty', originStation: '강남', line: '2' },
    );
  });

  // ambiguity는 후보가 있으나 자동 선택 불가 — empty와 별 신호이므로 empty_skip 발사 X.
  it('ambiguity (same priority 2+) → empty_skip breadcrumb 발사 안 함', async () => {
    const deps = makeHandleResponseDeps({
      fetchArrivalsForStation: jest.fn(async () => makeArrivalWithUp(AMBIGUOUS_TRAINS)),
    });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(addDomainBreadcrumb).not.toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_empty_skip',
      expect.anything(),
    );
  });

  // destinationId null + [탑승] 액션 → tryAutoLock 진입 전 dismiss path. empty_skip 발사 안 함.
  it('destinationId null + [탑승] → empty_skip breadcrumb 발사 안 함 (dismiss path)', async () => {
    const deps = makeHandleResponseDeps({ destinationId: null });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(addDomainBreadcrumb).not.toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_empty_skip',
      expect.anything(),
    );
    // 단, interactive_tap는 발사된다 (사용자가 Interactive UI를 탭한 사실은 destinationId와 무관).
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_interactive_tap',
      expect.objectContaining({ action: BOARDING_PROMPT_ACTION_BOARDED }),
    );
  });
});

// #1888 (RC-13) — banner tap($default action) navigation. 사용자가 list를 보고 싶다는 명시 의향에
// home 화면 navigation. action button BOARDED는 silent autolock으로 끝나므로 navigation X.
describe('handleResponse — #1888 RC-13 onBannerTap navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('$default action → onBannerTap 호출 (autolock 성공 케이스)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const onBannerTap = jest.fn();
    const deps = makeHandleResponseDeps({ onBannerTap });
    await handleResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(onBannerTap).toHaveBeenCalledTimes(1);
  });

  it(
    '$default action → onBannerTap 호출 (train 확정 실패해도 pending fallback lock 생성, #2407)',
    async () => {
      // arrivals 0건 → #2407 pending fallback lock 경로. 사용자는 여전히 list를 보고 싶다.
      (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
      const onBannerTap = jest.fn();
      const deps = makeHandleResponseDeps({
        fetchArrivalsForStation: jest.fn(async () => null),
        onBannerTap,
      });
      await handleResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, HANDLE_RESPONSE_PAYLOAD, deps);
      expect(onBannerTap).toHaveBeenCalledTimes(1);
      // #2407 root fix — train 미확정이어도 lock 자체는 생성된다 (trainCode=pending sentinel).
      expectPendingFallbackLockCalled();
    },
  );

  it('[탑승] action → onBannerTap 호출 안 함 (action button은 silent autolock)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const onBannerTap = jest.fn();
    const deps = makeHandleResponseDeps({ onBannerTap });
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(onBannerTap).not.toHaveBeenCalled();
  });

  it('[미탑승] action → onBannerTap 호출 안 함 (dismiss path)', async () => {
    const onBannerTap = jest.fn();
    const deps = makeHandleResponseDeps({ onBannerTap });
    await handleResponse(BOARDING_PROMPT_ACTION_NOT_BOARDED, HANDLE_RESPONSE_PAYLOAD, deps);
    expect(onBannerTap).not.toHaveBeenCalled();
  });

  it('알 수 없는 action → onBannerTap 호출 안 함 (dismiss path)', async () => {
    const onBannerTap = jest.fn();
    const deps = makeHandleResponseDeps({ onBannerTap });
    await handleResponse('SOME_OTHER_ACTION', HANDLE_RESPONSE_PAYLOAD, deps);
    expect(onBannerTap).not.toHaveBeenCalled();
  });

  it('$default action + onBannerTap 미전달 → no-op (회귀 보존)', async () => {
    (findStationByNameAndLine as jest.Mock).mockReturnValue({ id: 'S1', line: '2', name: '강남' });
    const deps = makeHandleResponseDeps();
    // onBannerTap 없이도 정상 진행.
    await expect(
      handleResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, HANDLE_RESPONSE_PAYLOAD, deps),
    ).resolves.toBeUndefined();
    // autolock은 정상 실행.
    expect(createLockMock).toHaveBeenCalled();
  });

  it('destinationId null + $default → dismiss path 진입. onBannerTap 호출 됨 (autolock 미진입과 무관)', async () => {
    const onBannerTap = jest.fn();
    const deps = makeHandleResponseDeps({ destinationId: null, onBannerTap });
    await handleResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, HANDLE_RESPONSE_PAYLOAD, deps);
    // destinationId null → tryAutoLock 진입 → dismiss POST → 그 뒤 onBannerTap 호출.
    expect(onBannerTap).toHaveBeenCalledTimes(1);
  });
});

// #2034 — hop-end (환승역 "하차했나요?") 응답 처리.
describe('handleResponse — #2034 hop-end', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const HOP_END_PAYLOAD = {
    kind: 'boarding-prompt' as const,
    originStation: '성수',
    line: '2',
    tripToken: 'tok-hop',
    hopEndKind: 'disembark' as const,
    nextLine: 'K',
    nextStation: '왕십리',
  };

  it('extractBoardingPromptPayload — hopEndKind + nextLine + nextStation 보존', () => {
    expect(
      extractBoardingPromptPayload({
        kind: 'boarding-prompt',
        originStation: '성수',
        line: '2',
        tripToken: 'tok-hop',
        hopEndKind: 'disembark',
        nextLine: 'K',
        nextStation: '왕십리',
      }),
    ).toEqual({
      kind: 'boarding-prompt',
      originStation: '성수',
      line: '2',
      tripToken: 'tok-hop',
      destinationDirection: undefined,
      hopEndKind: 'disembark',
      nextLine: 'K',
      nextStation: '왕십리',
    });
  });

  it('extractBoardingPromptPayload — hopEndKind 이 아닌 값이면 undefined 로 정규화', () => {
    const r = extractBoardingPromptPayload({
      kind: 'boarding-prompt',
      originStation: '성수',
      line: '2',
      tripToken: 'tok-hop',
      hopEndKind: 'invalid',
    });
    expect(r?.hopEndKind).toBeUndefined();
  });

  // #2282 — hop-end 는 DISEMBARK_PROMPT category(DISEMBARK_ACTION_DISEMBARKED/NOT_YET)로 발사되므로
  // handleHopEndResponse 는 이 식별자를 [하차함]으로 인식해야 한다.
  it('[하차함] (DISEMBARKED action) → releaseLock 호출 + tryAutoLock 진입 X + logBoardingPromptResponded(boarded)', async () => {
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
    expect(releaseLockMock).toHaveBeenCalledWith('user');
    // hop-end 는 autoLock 시도 안 함 — createLock 는 호출되면 안 됨.
    expect(createLockMock).not.toHaveBeenCalled();
    expect(logBoardingPromptResponded).toHaveBeenCalledWith({ outcome: 'boarded' });
    // dismiss POST 는 호출 안 함 — 이미 backend 가 fired stamp 완료.
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
  });

  it('[아직] (NOT_YET action) → dismissBoardingPrompt POST + logBoardingPromptResponded(dismissed)', async () => {
    await handleResponse(
      DISEMBARK_ACTION_NOT_YET,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok-hop');
    expect(logBoardingPromptResponded).toHaveBeenCalledWith({ outcome: 'dismissed' });
    // releaseLock 은 [아직] 응답 시 호출 안 함 — lock 유지.
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  it('$default (banner tap) → releaseLock + onBannerTap 호출', async () => {
    const onBannerTap = jest.fn();
    await handleResponse(
      Notifications.DEFAULT_ACTION_IDENTIFIER,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps({ onBannerTap }),
    );
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
    expect(onBannerTap).toHaveBeenCalledTimes(1);
  });

  it('알 수 없는 action → dismiss path 진입', async () => {
    await handleResponse(
      'UNKNOWN_ACTION',
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(positionUpload.dismissBoardingPrompt).toHaveBeenCalledWith('tok-hop');
    expect(releaseLockMock).not.toHaveBeenCalled();
  });

  // #2278 — 건대입구 7→2 환승 실기기 RCA. HOP_END_PAYLOAD.nextLine='K'는 유효한 LineNumber가
  // 아니므로(테스트 placeholder) 위 케이스들에서는 stampLegAdvance가 호출되지 않는다 — 유효한
  // nextLine('2')을 가진 payload로 stamp 발사를 별도 검증한다.
  const HOP_END_PAYLOAD_VALID_NEXT_LINE = {
    ...HOP_END_PAYLOAD,
    nextLine: '2',
  };

  it('[하차함] (DISEMBARKED action) + 유효한 nextLine → useLegAdvanceStore.stampLegAdvance(nextLine) 호출', async () => {
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      HOP_END_PAYLOAD_VALID_NEXT_LINE,
      makeHandleResponseDeps(),
    );
    expect(stampLegAdvanceMock).toHaveBeenCalledTimes(1);
    expect(stampLegAdvanceMock).toHaveBeenCalledWith('2');
  });

  it('[하차함] (DISEMBARKED action) + 유효하지 않은 nextLine("K") → stampLegAdvance 호출 안 함 (기존 동작 유지)', async () => {
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(stampLegAdvanceMock).not.toHaveBeenCalled();
  });

  // #2410 — push nextLine 무효(구버전 backend 등) 시 로컬 route에서 다음 leg 노선을 도출해
  // stampLegAdvance한다. 하차 등록이 push 데이터 부재로 통째로 무효화되던 회귀 fix.
  describe('#2410 — nextLine 무효 시 route derive fallback', () => {
    // route derive가 성공하는 공통 setup — station lookup, 환승 route, waypoint mock을
    // 동일하게 구성한 뒤 handleResponse를 호출한다. 아래 두 테스트가 결과 assertion만 다르게 검증.
    async function invokeDisembarkWithSuccessfulRouteDerive(): Promise<void> {
      findStationByNameAndLine.mockReturnValue({ id: 'S-성수-2', line: '2', name: '성수' });
      readWidgetRefreshContextMock.mockResolvedValueOnce({
        destination: { id: 'D1', line: 'gyeongui', name: '왕십리' },
        route: makeTransferRoute({
          transferName: '성수',
          fromLine: '2',
          toLine: 'gyeongui',
          stopsToTransfer: 0,
          stopsFromTransfer: 3,
        }),
        bgContext: null,
      });
      findLocklessTransferWaypointMock.mockReturnValueOnce({
        transferStationInToLine: { id: 'S-성수-K', line: 'gyeongui', name: '성수' },
        nextLine: '5',
      });

      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeHandleResponseDeps(),
      );
    }

    it('nextLine 무효 + route derive 성공 → 도출된 line으로 stampLegAdvance 호출', async () => {
      await invokeDisembarkWithSuccessfulRouteDerive();

      expect(findLocklessTransferWaypointMock).toHaveBeenCalledTimes(1);
      expect(stampLegAdvanceMock).toHaveBeenCalledTimes(1);
      expect(stampLegAdvanceMock).toHaveBeenCalledWith('5');
    });

    it('nextLine 무효 + route/destination storage 부재 → stampLegAdvance 호출 안 함 (graceful skip)', async () => {
      findStationByNameAndLine.mockReturnValue({ id: 'S-성수-2', line: '2', name: '성수' });
      readWidgetRefreshContextMock.mockResolvedValueOnce({
        destination: null,
        route: null,
        bgContext: null,
      });

      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeHandleResponseDeps(),
      );

      expect(findLocklessTransferWaypointMock).not.toHaveBeenCalled();
      expect(stampLegAdvanceMock).not.toHaveBeenCalled();
    });

    it('nextLine 무효 + originStation station lookup 실패 → stampLegAdvance 호출 안 함 (graceful skip)', async () => {
      findStationByNameAndLine.mockReturnValue(undefined);

      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeHandleResponseDeps(),
      );

      expect(readWidgetRefreshContextMock).not.toHaveBeenCalled();
      expect(stampLegAdvanceMock).not.toHaveBeenCalled();
    });

    it('nextLine 무효 + route derive 매칭 실패(findLocklessTransferWaypoint null) → stampLegAdvance 호출 안 함', async () => {
      findStationByNameAndLine.mockReturnValue({ id: 'S-성수-2', line: '2', name: '성수' });
      readWidgetRefreshContextMock.mockResolvedValueOnce({
        destination: { id: 'D1', line: 'gyeongui', name: '왕십리' },
        route: makeTransferRoute({
          transferName: '성수',
          fromLine: '2',
          toLine: 'gyeongui',
          stopsToTransfer: 0,
          stopsFromTransfer: 3,
        }),
        bgContext: null,
      });
      findLocklessTransferWaypointMock.mockReturnValueOnce(null);

      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeHandleResponseDeps(),
      );

      expect(stampLegAdvanceMock).not.toHaveBeenCalled();
    });

    it('nextLine 무효 + route derive 성공해도 releaseLock은 그대로 1회 호출됨 (기존 흐름 무변경)', async () => {
      await invokeDisembarkWithSuccessfulRouteDerive();

      expect(releaseLockMock).toHaveBeenCalledTimes(1);
      expect(releaseLockMock).toHaveBeenCalledWith('user');
    });

    it('nextLine 무효 + payload.line도 유효하지 않음 → station lookup 시도 없이 stampLegAdvance 호출 안 함', async () => {
      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        { ...HOP_END_PAYLOAD, line: 'not-a-line' },
        makeHandleResponseDeps(),
      );

      expect(findStationByNameAndLine).not.toHaveBeenCalled();
      expect(readWidgetRefreshContextMock).not.toHaveBeenCalled();
      expect(stampLegAdvanceMock).not.toHaveBeenCalled();
    });

    it('nextLine 유효 → route derive 경로 진입 안 함 (findLocklessTransferWaypoint 미호출, 기존 회귀 없음)', async () => {
      await handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD_VALID_NEXT_LINE,
        makeHandleResponseDeps(),
      );

      expect(readWidgetRefreshContextMock).not.toHaveBeenCalled();
      expect(findLocklessTransferWaypointMock).not.toHaveBeenCalled();
      expect(stampLegAdvanceMock).toHaveBeenCalledWith('2');
    });
  });

  it('[아직] (NOT_YET action) → stampLegAdvance 호출 안 함', async () => {
    await handleResponse(
      DISEMBARK_ACTION_NOT_YET,
      HOP_END_PAYLOAD_VALID_NEXT_LINE,
      makeHandleResponseDeps(),
    );
    expect(stampLegAdvanceMock).not.toHaveBeenCalled();
  });

  it('breadcrumb "boarding_prompt_interactive_tap" 에 hopEndKind=disembark 스탬프', async () => {
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'boarding_prompt_interactive_tap',
      { action: DISEMBARK_ACTION_DISEMBARKED, line: '2', hopEndKind: 'disembark' },
    );
  });

  it('breadcrumb "hop_end_prompt_confirmed" ([하차함] 시)', async () => {
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'hop_end_prompt_confirmed',
      { line: '2', nextLine: 'K' },
    );
  });

  it('breadcrumb "hop_end_prompt_dismissed" ([아직] 시)', async () => {
    await handleResponse(
      DISEMBARK_ACTION_NOT_YET,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'hop_end_prompt_dismissed',
      { line: '2' },
    );
  });

  it('releaseLock 실패해도 응답 처리 계속 진행 (graceful)', async () => {
    releaseLockMock.mockImplementationOnce(() => Promise.reject(new Error('release failed')));
    await expect(
      handleResponse(
        DISEMBARK_ACTION_DISEMBARKED,
        HOP_END_PAYLOAD,
        makeHandleResponseDeps(),
      ),
    ).resolves.not.toThrow();
    expect(logBoardingPromptResponded).toHaveBeenCalledWith({ outcome: 'boarded' });
  });

  it('nextLine 없음 → breadcrumb 에 nextLine="" 로 stamp (undefined 회피)', async () => {
    const payloadNoNext = { ...HOP_END_PAYLOAD, nextLine: undefined };
    await handleResponse(
      DISEMBARK_ACTION_DISEMBARKED,
      payloadNoNext,
      makeHandleResponseDeps(),
    );
    expect(addDomainBreadcrumb).toHaveBeenCalledWith(
      'boarding',
      'hop_end_prompt_confirmed',
      { line: '2', nextLine: '' },
    );
  });

  // #2282 리뷰 P1 — 구 backend(DISEMBARK 카테고리 배포 전)는 hop-end를 BOARDING_PROMPT
  // 카테고리 + 구 BOARDED 식별자로 쏜다. payload.hopEndKind가 이미 hop-end로 분류하므로
  // 과도기 호환으로 구 식별자도 하차 확정으로 인식해야 한다(배포 순서 종속 회귀 차단).
  it('구 BOARDING_PROMPT_ACTION_BOARDED 도 하차 확정으로 인식된다 (과도기 호환)', async () => {
    await handleResponse(
      BOARDING_PROMPT_ACTION_BOARDED,
      HOP_END_PAYLOAD,
      makeHandleResponseDeps(),
    );
    expect(releaseLockMock).toHaveBeenCalled();
    expect(positionUpload.dismissBoardingPrompt).not.toHaveBeenCalled();
  });
});
