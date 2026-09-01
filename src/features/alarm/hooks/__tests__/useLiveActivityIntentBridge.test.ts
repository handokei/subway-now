/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트 — 대상 훅과 동일 사유로 옵트인.
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { renderHook } from '@testing-library/react-native';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockReadPendingBoardingIntent = jest.fn();
const mockClearPendingBoardingIntent = jest.fn();
jest.mock('live-activity', () => ({
  readPendingBoardingIntent: (...args: unknown[]) =>
    mockReadPendingBoardingIntent(...args),
  clearPendingBoardingIntent: (...args: unknown[]) =>
    mockClearPendingBoardingIntent(...args),
}));

const mockHandleResponse = jest.fn();
jest.mock('../useBoardingPromptResponder', () => ({
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

let capturedPollCallback: (() => void) | null = null;
jest.mock('../../../../shared/hooks/usePolling', () => ({
  usePolling: (cb: () => void) => {
    capturedPollCallback = cb;
  },
}));

const mockFindStationByNameAndLine = jest.fn();
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) =>
    mockFindStationByNameAndLine(...args),
}));

const mockCreateLock = jest.fn();
let mockLock: BoardingLock | null = null;
jest.mock('../../store/useBoardingLockStore', () => {
  const selectorFn = Object.assign(
    (selector: (state: { createLock: jest.Mock; lock: unknown }) => unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock 캡처 변수 접근
      selector({ createLock: mockCreateLock, lock: (globalThis as any).__mockLock ?? null }),
    {
      getState: () => ({
        createLock: mockCreateLock,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lock: (globalThis as any).__mockLock ?? null,
      }),
    },
  );
  return { useBoardingLockStore: selectorFn };
});

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  parsePendingBoardingIntent,
  useLiveActivityIntentBridge,
} from '../useLiveActivityIntentBridge';
import {
  BOARDING_PROMPT_ACTION_BOARDED,
  BOARDING_PROMPT_ACTION_NOT_BOARDED,
  DISEMBARK_ACTION_DISEMBARKED,
  DISEMBARK_ACTION_NOT_YET,
} from '../../utils/notificationCategory';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

function setMockLock(lock: BoardingLock | null): void {
  mockLock = lock;
  g.__mockLock = lock;
}

const baseDeps = {
  fetchArrivalsForStation: jest.fn(),
  destinationId: 'dest-1',
  expectedDurationMs: 30 * 60_000,
};

const validBoardedRaw = JSON.stringify({
  id: 'trip-1-100',
  tripToken: 'trip-1',
  action: 'BOARDING_BOARDED',
  originStation: '군자',
  line: '5',
  atMs: 100,
});

const validDisembarkRaw = JSON.stringify({
  id: 'trip-1-200',
  tripToken: 'trip-1',
  action: 'DISEMBARK_DISEMBARKED',
  originStation: '군자',
  line: '5',
  atMs: 200,
});

const validNotBoardedRaw = JSON.stringify({
  id: 'trip-1-300',
  tripToken: 'trip-1',
  action: 'BOARDING_NOT_BOARDED',
  originStation: '군자',
  line: '5',
  atMs: 300,
});

const validDisembarkNotYetRaw = JSON.stringify({
  id: 'trip-1-400',
  tripToken: 'trip-1',
  action: 'DISEMBARK_NOT_YET',
  originStation: '군자',
  line: '5',
  atMs: 400,
});

describe('parsePendingBoardingIntent', () => {
  it('유효한 JSON을 파싱한다', () => {
    expect(parsePendingBoardingIntent(validBoardedRaw)).toEqual({
      id: 'trip-1-100',
      tripToken: 'trip-1',
      action: 'BOARDING_BOARDED',
      originStation: '군자',
      line: '5',
      atMs: 100,
    });
  });

  it('malformed JSON → null', () => {
    expect(parsePendingBoardingIntent('not-json{')).toBeNull();
  });

  it('BOARDING_NOT_BOARDED action을 파싱한다', () => {
    expect(parsePendingBoardingIntent(validNotBoardedRaw)).toEqual({
      id: 'trip-1-300',
      tripToken: 'trip-1',
      action: 'BOARDING_NOT_BOARDED',
      originStation: '군자',
      line: '5',
      atMs: 300,
    });
  });

  it('DISEMBARK_NOT_YET action을 파싱한다', () => {
    expect(parsePendingBoardingIntent(validDisembarkNotYetRaw)).toEqual({
      id: 'trip-1-400',
      tripToken: 'trip-1',
      action: 'DISEMBARK_NOT_YET',
      originStation: '군자',
      line: '5',
      atMs: 400,
    });
  });

  it('object가 아님 → null', () => {
    expect(parsePendingBoardingIntent('123')).toBeNull();
  });

  it.each([
    ['id', { ...JSON.parse(validBoardedRaw), id: '' }],
    ['tripToken', { ...JSON.parse(validBoardedRaw), tripToken: undefined }],
    ['action', { ...JSON.parse(validBoardedRaw), action: 'UNKNOWN' }],
    ['originStation', { ...JSON.parse(validBoardedRaw), originStation: 1 }],
    ['line', { ...JSON.parse(validBoardedRaw), line: null }],
    ['atMs', { ...JSON.parse(validBoardedRaw), atMs: 'not-a-number' }],
  ])('필드 %s 누락/타입불일치 → null', (_field, payload) => {
    expect(parsePendingBoardingIntent(JSON.stringify(payload))).toBeNull();
  });
});

describe('useLiveActivityIntentBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedPollCallback = null;
    setMockLock(null);
    mockCreateLock.mockReset();
    mockFindStationByNameAndLine.mockReset();
    mockHandleResponse.mockResolvedValue(undefined);
    mockClearPendingBoardingIntent.mockReturnValue(undefined);
  });

  it('마운트 시 pending intent를 1회 확인한다', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(null);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    expect(mockReadPendingBoardingIntent).toHaveBeenCalledTimes(1);
  });

  it('pending 없음(null) → handleResponse/clear 호출 안 함', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(null);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
  });

  it('malformed pending → handleResponse/clear 호출 안 함', async () => {
    mockReadPendingBoardingIntent.mockReturnValue('not-json{');
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
  });

  it('readPendingBoardingIntent 실패 → throw 없이 흡수', async () => {
    mockReadPendingBoardingIntent.mockImplementation(() => {
      throw new Error('native error');
    });
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).not.toHaveBeenCalled();
  });

  it('lock 없음 + BOARDING_BOARDED → handleResponse(BOARDED) 호출 후 clear', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).toHaveBeenCalledWith(
      BOARDING_PROMPT_ACTION_BOARDED,
      expect.objectContaining({
        kind: 'boarding-prompt',
        originStation: '군자',
        line: '5',
        tripToken: 'trip-1',
        hopEndKind: undefined,
      }),
      expect.objectContaining({ ...baseDeps, createLock: mockCreateLock }),
    );
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('trip-1-100');
  });

  it('DISEMBARK_DISEMBARKED → handleResponse(DISEMBARKED, hopEndKind=disembark) 호출 후 clear', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(validDisembarkRaw);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).toHaveBeenCalledWith(
      DISEMBARK_ACTION_DISEMBARKED,
      expect.objectContaining({ hopEndKind: 'disembark' }),
      expect.anything(),
    );
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('trip-1-200');
  });

  it('BOARDING_NOT_BOARDED → handleResponse(NOT_BOARDED, hopEndKind=undefined) 호출 후 clear', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(validNotBoardedRaw);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).toHaveBeenCalledWith(
      BOARDING_PROMPT_ACTION_NOT_BOARDED,
      expect.objectContaining({
        kind: 'boarding-prompt',
        originStation: '군자',
        line: '5',
        tripToken: 'trip-1',
        hopEndKind: undefined,
      }),
      expect.objectContaining({ ...baseDeps, createLock: mockCreateLock }),
    );
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('trip-1-300');
  });

  it('DISEMBARK_NOT_YET → handleResponse(NOT_YET, hopEndKind=disembark) 호출 후 clear', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(validDisembarkNotYetRaw);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).toHaveBeenCalledWith(
      DISEMBARK_ACTION_NOT_YET,
      expect.objectContaining({ hopEndKind: 'disembark' }),
      expect.anything(),
    );
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('trip-1-400');
  });

  it('clearPendingBoardingIntent 실패 → throw 없이 흡수', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
    mockClearPendingBoardingIntent.mockImplementation(() => {
      throw new Error('clear failed');
    });
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockHandleResponse).toHaveBeenCalledTimes(1);
  });

  describe('⑥ dedup — 동일 origin/line active lock 존재 시 no-op', () => {
    const activeLock: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T1',
      boardingStationId: 'stn-군자-5',
      boardingLine: '5',
      boardedAt: Date.now(),
      expectedDurationMs: 30 * 60_000,
      boardingEvidence: false,
    };

    it('같은 boardingStationId/line → handleResponse skip, clear는 호출', async () => {
      setMockLock(activeLock);
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-군자-5' });
      mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).not.toHaveBeenCalled();
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('trip-1-100');
    });

    it('lock 만료됨 → dedup 미적용, handleResponse 호출', async () => {
      setMockLock({ ...activeLock, boardedAt: Date.now() - 100 * 60_000 });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-군자-5' });
      mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });

    it('line 불일치 → dedup 미적용, handleResponse 호출', async () => {
      setMockLock({ ...activeLock, boardingLine: '2' });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-군자-5' });
      mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });

    it('station 매칭 실패(다른 역) → dedup 미적용, handleResponse 호출', async () => {
      setMockLock(activeLock);
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-다른역-5' });
      mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });

    it('station lookup이 null → dedup 미적용, handleResponse 호출', async () => {
      setMockLock(activeLock);
      mockFindStationByNameAndLine.mockReturnValue(null);
      mockReadPendingBoardingIntent.mockReturnValue(validBoardedRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });

    it('DISEMBARK 액션은 dedup 체크 대상 아님 — lock 있어도 handleResponse 호출', async () => {
      setMockLock(activeLock);
      mockReadPendingBoardingIntent.mockReturnValue(validDisembarkRaw);
      renderHook(() => useLiveActivityIntentBridge(baseDeps));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });
  });

  it('foreground 폴링 콜백이 등록되고 재호출 시 재확인한다', async () => {
    mockReadPendingBoardingIntent.mockReturnValue(null);
    renderHook(() => useLiveActivityIntentBridge(baseDeps));
    await Promise.resolve();
    expect(capturedPollCallback).not.toBeNull();
    mockReadPendingBoardingIntent.mockClear();
    capturedPollCallback!();
    await Promise.resolve();
    expect(mockReadPendingBoardingIntent).toHaveBeenCalledTimes(1);
  });
});
