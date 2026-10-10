/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: `useBoardingPromptResponder`(alarm) 응답 경로를 그대로 구동하는
 * wire replay라 여러 features의 store/util을 조합한다 — 그 orchestrator 파일 자체와 동일한 근거로
 * file-level disable(ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5, #890).
 */
/**
 * #2655 — leg-2 trainCode embed(#2820, 이미 머지)의 backend→device wire 계약 replay.
 *
 * 짝(backend 발신 검증)은
 * `backend/alarm-worker/src/__tests__/wire_20260928_boarding_prompt_traincode.test.ts`.
 * 두 파일이 같은 공유 fixture(`src/shared/types/__fixtures__/boardingPromptTrainCodeWireFixture.ts`)
 * 를 import한다 — 기존 replay는 backend-only(apns.test.ts #2819) / device-only
 * (useBoardingPromptResponder.test.ts #2819)로 각자 손으로 만든 mock payload만 검증해, 한쪽
 * 필드명/위치가 drift해도 부품 테스트가 green을 유지할 수 있는 갭이 있었다. 이 파일은 backend가
 * 실제로 wire에 실었을 shape(`BOARDING_PROMPT_WIRE_DATA`)을 device `content.data` 입력으로
 * 그대로 사용해 파싱→auto-lock까지 재현한다.
 */
import {
  extractBoardingPromptPayload,
  handleResponse,
} from '../hooks/useBoardingPromptResponder';
import { BOARDING_PROMPT_ACTION_BOARDED } from '../utils/notificationCategory';
import { PENDING_TRAIN_CODE } from '../../../shared/constants/boardingLock';
import type { Station } from '../../../shared/types/station';
import {
  BOARDING_PROMPT_WIRE_DATA,
  BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE,
} from '../../../shared/types/__fixtures__/boardingPromptTrainCodeWireFixture';

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: '$default',
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
}));
jest.mock('../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: jest.fn(),
}));
jest.mock('../utils/alarmLog', () => ({
  logBoardingPromptAutoLock: jest.fn(),
  logBoardingPromptResponded: jest.fn(),
  logBoardingPromptFired: jest.fn(),
}));
jest.mock('../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
}));
jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('../store/useUserIntentStore', () => {
  const mockSetInfoModeEnabled = jest.fn(() => Promise.resolve());
  const mockSetBoardingCommitted = jest.fn(() => Promise.resolve());
  return {
    useUserIntentStore: {
      getState: () => ({
        setInfoModeEnabled: mockSetInfoModeEnabled,
        setBoardingCommitted: mockSetBoardingCommitted,
      }),
    },
  };
});
jest.mock('../../route/store/useNavigationStore', () => ({
  useNavigationStore: { getState: () => ({ startNavigation: jest.fn() }) },
}));
jest.mock('../utils/widgetRefreshContext', () => ({
  readWidgetRefreshContext: jest.fn(async () => ({
    destination: null,
    route: null,
    bgContext: null,
  })),
}));

const { findStationByNameAndLine } = jest.requireMock('../../../shared/utils/stationLookup');

// backend가 wire에 싣는 originStation/line 그대로 device 쪽에서 조회 성공하는 station.
// tryEmbeddedTrainCodeLock/createPendingFallbackLock 둘 다 findStationByNameAndLine(originStation,
// line)의 반환값만 사용(`.id`)하므로 최소 필드만 채운다.
const WIRE_STATION: Station = {
  id: 'stn-wire-2655',
  name: BOARDING_PROMPT_WIRE_DATA.originStation,
  line: BOARDING_PROMPT_WIRE_DATA.line as Station['line'],
  lineColor: '#00A84D',
  lat: 0,
  lng: 0,
};

function makeDeps(createLock: jest.Mock) {
  return {
    fetchArrivalsForStation: jest.fn(async () => null),
    destinationId: 'wire-fx-2655-dest',
    expectedDurationMs: 600_000,
    createLock,
  };
}

describe('#2655 — boarding-prompt trainCode wire 계약 (device 소비 측)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (findStationByNameAndLine as jest.Mock).mockReturnValue(WIRE_STATION);
  });

  it('extractBoardingPromptPayload — backend가 wire에 싣는 shape을 그대로 파싱해 trainCode를 보존한다', () => {
    const payload = extractBoardingPromptPayload(BOARDING_PROMPT_WIRE_DATA);
    expect(payload).not.toBeNull();
    expect(payload?.trainCode).toBe(BOARDING_PROMPT_WIRE_DATA.trainCode);
    expect(payload?.originStation).toBe(BOARDING_PROMPT_WIRE_DATA.originStation);
    expect(payload?.line).toBe(BOARDING_PROMPT_WIRE_DATA.line);
    expect(payload?.tripToken).toBe(BOARDING_PROMPT_WIRE_DATA.tripToken);
  });

  it('BOARDED 응답 + on-tap 재조회 실패(arrivals null) → wire trainCode로 실 lock 생성 (PENDING 아님)', async () => {
    const payload = extractBoardingPromptPayload(BOARDING_PROMPT_WIRE_DATA);
    expect(payload).not.toBeNull();
    const createLock = jest.fn();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, payload!, makeDeps(createLock));

    expect(createLock).toHaveBeenCalledTimes(1);
    expect(createLock).toHaveBeenCalledWith(
      expect.objectContaining({
        trainCode: BOARDING_PROMPT_WIRE_DATA.trainCode,
        boardingStationId: WIRE_STATION.id,
        boardingLine: BOARDING_PROMPT_WIRE_DATA.line,
      }),
      true,
      'boarding-prompt-response',
    );
  });

  it('extractBoardingPromptPayload — trainCode 미지정 wire shape은 undefined로 파싱된다', () => {
    const payload = extractBoardingPromptPayload(BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE);
    expect(payload).not.toBeNull();
    expect(payload?.trainCode).toBeUndefined();
  });

  it('BOARDED 응답 + trainCode 미지정 wire + 재조회 실패 → 회귀 없음: 여전히 PENDING fallback lock', async () => {
    const payload = extractBoardingPromptPayload(BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE);
    expect(payload).not.toBeNull();
    const createLock = jest.fn();
    await handleResponse(BOARDING_PROMPT_ACTION_BOARDED, payload!, makeDeps(createLock));

    expect(createLock).toHaveBeenCalledTimes(1);
    expect(createLock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: PENDING_TRAIN_CODE }),
      false,
      'boarding-prompt-response',
    );
  });
});
