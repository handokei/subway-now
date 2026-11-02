/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트 — 대상 훅과 동일 사유로 옵트인.
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #3055 PR-1 — 재진입 가드 · native 응답 분기 · 재시도 (plan v6 §3.3, A2 R1/R13/R15).
 * 스펙(plan)만 보고 작성. 기존 `useLiveActivityIntentBridge.test.ts`는 무변경.
 */
import { renderHook } from '@testing-library/react-native';

const mockReadPendingBoardingIntent = jest.fn();
const mockClearPendingBoardingIntent = jest.fn();
jest.mock('live-activity', () => ({
  readPendingBoardingIntent: (...args: unknown[]) => mockReadPendingBoardingIntent(...args),
  clearPendingBoardingIntent: (...args: unknown[]) => mockClearPendingBoardingIntent(...args),
}));

const mockEndBoardingActivity = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/boardingActivityChannel', () => ({
  endBoardingActivity: (...args: unknown[]) => mockEndBoardingActivity(...args),
}));

const mockApplyLaNativeResolution = jest.fn();
jest.mock('../../utils/applyLaNativeResolution', () => ({
  applyLaNativeResolution: (...args: unknown[]) => mockApplyLaNativeResolution(...args),
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

const mockCreateLock = jest.fn();
jest.mock('../../store/useBoardingLockStore', () => {
  const selectorFn = Object.assign(
    (selector: (state: { createLock: jest.Mock; lock: unknown }) => unknown) =>
      selector({ createLock: mockCreateLock, lock: null }),
    { getState: () => ({ createLock: mockCreateLock, lock: null }) },
  );
  return { useBoardingLockStore: selectorFn };
});

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import {
  parsePendingBoardingIntent,
  useLiveActivityIntentBridge,
} from '../useLiveActivityIntentBridge';
import { DISEMBARK_ACTION_DISEMBARKED } from '../../utils/notificationCategory';
import {
  LIVE_ACTIVITY_INTENT_STALE_MS,
  NATIVE_CONFIRM_WAIT_MS,
} from '../../../../shared/constants/boardingLock';

const baseDeps = {
  fetchArrivalsForStation: jest.fn(),
  destinationId: 'dest-1',
  expectedDurationMs: 30 * 60_000,
};

const TAP_AT = 1_000_000;
const CANDIDATE = { trainCode: '7320', issuedAtMs: TAP_AT - 12_000 };
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const boardedRaw = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'tok-1000000',
    tripToken: 'tok',
    action: 'BOARDING_BOARDED',
    originStation: '건대입구',
    line: '7',
    atMs: TAP_AT,
    ...extra,
  });
const disembarkRaw = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'tok-d-1000000',
    tripToken: 'tok',
    action: 'DISEMBARK_DISEMBARKED',
    originStation: '건대입구',
    line: '7',
    atMs: TAP_AT,
    ...extra,
  });
const nowAt = (offsetMs: number) => () => TAP_AT + offsetMs;

describe('useLiveActivityIntentBridge — #3055 PR-1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedPollCallback = null;
    mockHandleResponse.mockResolvedValue({ posted: true, status: 200 });
    mockApplyLaNativeResolution.mockResolvedValue('created');
    mockClearPendingBoardingIntent.mockReturnValue(undefined);
  });

  describe('parsePendingBoardingIntent — 신규 optional 필드', () => {
    it('laCandidate·nativePost(in-flight / 결과 객체)를 그대로 파싱한다', () => {
      const parsed = parsePendingBoardingIntent(
        boardedRaw({
          laCandidate: CANDIDATE,
          nativePost: { status: 200, resolvedTrainCode: '7320', lockState: 'leg2', atMs: TAP_AT + 100 },
        }),
      );
      expect(parsed?.laCandidate).toEqual(CANDIDATE);
      expect(parsed?.nativePost).toEqual({
        status: 200,
        resolvedTrainCode: '7320',
        lockState: 'leg2',
        atMs: TAP_AT + 100,
      });
      expect(parsePendingBoardingIntent(boardedRaw({ nativePost: 'in-flight' }))?.nativePost).toBe('in-flight');
    });

    it('필드 부재(구 native)면 키 자체가 없다 — 현행 파싱 결과 그대로', () => {
      const parsed = parsePendingBoardingIntent(boardedRaw());
      expect(parsed).not.toHaveProperty('laCandidate');
      expect(parsed).not.toHaveProperty('nativePost');
    });

    it.each([
      ['laCandidate.trainCode 빈 문자열', { laCandidate: { trainCode: '', issuedAtMs: 1 } }],
      ['laCandidate.issuedAtMs 비숫자', { laCandidate: { trainCode: '7320', issuedAtMs: 'x' } }],
      ['laCandidate 비객체', { laCandidate: 'A' }],
      ['nativePost 미지의 문자열', { nativePost: 'done' }],
      ['nativePost.status 비숫자', { nativePost: { status: 'ok', atMs: 1 } }],
      ['nativePost.atMs 부재', { nativePost: { status: 200 } }],
      ['nativePost null', { nativePost: null }],
    ])('[거부] 형식 불량 %s → 무시(intent는 유효, 현행 경로)', (_label, extra) => {
      const parsed = parsePendingBoardingIntent(boardedRaw(extra));
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty('laCandidate');
      expect(parsed).not.toHaveProperty('nativePost');
    });

    it('nativePost.resolvedTrainCode·lockState 형식 불량은 해당 키만 버린다', () => {
      const parsed = parsePendingBoardingIntent(
        boardedRaw({ nativePost: { status: 200, resolvedTrainCode: 5, lockState: 7, atMs: 1 } }),
      );
      expect(parsed?.nativePost).toEqual({ status: 200, atMs: 1 });
    });
  });

  describe('재진입 가드 (R1)', () => {
    it('POST가 도는 동안 같은 intent의 재실행(리렌더·active 전환·폴링)은 handleResponse를 다시 부르지 않는다', async () => {
      let release!: (v: unknown) => void;
      mockHandleResponse.mockReturnValue(
        new Promise((r) => {
          release = r;
        }),
      );
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw({ laCandidate: CANDIDATE }));
      const { rerender } = renderHook(({ d }: { d: typeof baseDeps }) => useLiveActivityIntentBridge(d, nowAt(3_000)), {
        initialProps: { d: { ...baseDeps } },
      });
      await flush();
      rerender({ d: { ...baseDeps } });
      capturedPollCallback!();
      capturedPollCallback!();
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();

      release({ posted: true, status: 200 });
      await flush();
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledTimes(1);
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-1000000');
    });

    it('처리 중 예외가 나도 in-flight가 해제돼 다음 실행이 다시 처리한다(finally)', async () => {
      mockHandleResponse
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ posted: true, status: 200 });
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw());
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(3_000)));
      await flush();
      capturedPollCallback!();
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(2);
    });
  });

  describe('BOARDING 브릿지 fallback payload (R1)', () => {
    it('native 실패(status 0) → handleResponse 1회, laCandidate+source=la-bridge, 방향·trainCode 없음', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(
        boardedRaw({ laCandidate: CANDIDATE, nativePost: { status: 0, atMs: TAP_AT + 10_000 } }),
      );
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(11_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      const [, payload] = mockHandleResponse.mock.calls[0];
      expect(payload).toEqual(
        expect.objectContaining({
          laCandidate: CANDIDATE,
          source: 'la-bridge',
          originStation: '건대입구',
          line: '7',
        }),
      );
      expect(payload.trainCode).toBeUndefined();
      expect(payload.destinationDirection).toBeUndefined();
      expect(mockApplyLaNativeResolution).not.toHaveBeenCalled();
    });

    it('laCandidate가 없으면(구 native) payload에도 없다 — 현행 경로', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw());
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      const [, payload] = mockHandleResponse.mock.calls[0];
      expect(payload.laCandidate).toBeUndefined();
      expect(payload.source).toBe('la-bridge');
    });

    it('native 2xx지만 응답에 열차가 없으면(backend lock 미성립) 브릿지가 fallback POST', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw({ nativePost: { status: 200, atMs: TAP_AT + 300 } }));
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      expect(mockApplyLaNativeResolution).not.toHaveBeenCalled();
    });

    it('native 비2xx(500)이면 fallback POST — resolvedTrainCode가 있어도 신뢰하지 않는다', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(
        boardedRaw({ nativePost: { status: 500, resolvedTrainCode: '7320', atMs: TAP_AT + 300 } }),
      );
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      expect(mockApplyLaNativeResolution).not.toHaveBeenCalled();
    });
  });

  describe('native 응답 사용 (R10 분기)', () => {
    it('BOARDING + nativePost 2xx + resolvedTrainCode → applyLaNativeResolution, POST·handleResponse 없음, clear', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(
        boardedRaw({ nativePost: { status: 200, resolvedTrainCode: '7320', lockState: 'leg2', atMs: TAP_AT + 300 } }),
      );
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      expect(mockApplyLaNativeResolution).toHaveBeenCalledTimes(1);
      const [intentArg, trainCodeArg, depsArg] = mockApplyLaNativeResolution.mock.calls[0];
      expect(intentArg).toEqual(expect.objectContaining({ originStation: '건대입구', line: '7' }));
      expect(trainCodeArg).toBe('7320');
      expect(depsArg).toEqual(expect.objectContaining({ destinationId: 'dest-1' }));
      expect(mockHandleResponse).not.toHaveBeenCalled();
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-1000000');
      expect(mockEndBoardingActivity).toHaveBeenCalledWith('intent-response');
    });
  });

  describe('native in-flight 대기 + 예산 (R15)', () => {
    it.each([
      ['BOARDING', boardedRaw],
      ['DISEMBARK', disembarkRaw],
    ])('%s: in-flight이고 예산 이내 → 보류(handleResponse·clear 없음)', async (_label, raw) => {
      mockReadPendingBoardingIntent.mockReturnValue(raw({ nativePost: 'in-flight' }));
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(NATIVE_CONFIRM_WAIT_MS)));
      await flush();
      expect(mockHandleResponse).not.toHaveBeenCalled();
      expect(mockApplyLaNativeResolution).not.toHaveBeenCalled();
      expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
    });

    it('예산 경과 후에는 native가 아직 in-flight여도 fallback POST로 진행한다', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw({ nativePost: 'in-flight', laCandidate: CANDIDATE }));
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(NATIVE_CONFIRM_WAIT_MS + 1)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-1000000');
    });

    it('in-flight 보류는 NOT_BOARDED 같은 비-confirm action에는 적용하지 않는다', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(
        JSON.stringify({ ...JSON.parse(boardedRaw({ nativePost: 'in-flight' })), action: 'BOARDING_NOT_BOARDED' }),
      );
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
    });
  });

  describe('DISEMBARK native 응답 (R13)', () => {
    it('nativePost 2xx → 로컬 하차 처리 1회 + backend forward 생략(skipBackendForward)', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(disembarkRaw({ nativePost: { status: 200, atMs: TAP_AT + 300 } }));
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(1_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      const [action, payload] = mockHandleResponse.mock.calls[0];
      expect(action).toBe(DISEMBARK_ACTION_DISEMBARKED);
      expect(payload).toEqual(expect.objectContaining({ hopEndKind: 'disembark', skipBackendForward: true }));
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-d-1000000');
    });

    it.each([
      ['native 실패(status 0)', { nativePost: { status: 0, atMs: TAP_AT + 10_000 } }],
      ['native 결과 없음(구 native)', {}],
    ])('[거부] %s → forward 생략하지 않는다', async (_label, extra) => {
      mockReadPendingBoardingIntent.mockReturnValue(disembarkRaw(extra));
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(11_000)));
      await flush();
      const [, payload] = mockHandleResponse.mock.calls[0];
      expect(payload.skipBackendForward).toBeUndefined();
    });
  });

  describe('재시도 (R1)', () => {
    it('POST가 네트워크 실패(posted && status 없음)면 clear하지 않고 다음 실행에서 재시도, 성공 시 clear', async () => {
      mockHandleResponse
        .mockResolvedValueOnce({ posted: true })
        .mockResolvedValueOnce({ posted: true, status: 200, resolvedTrainCode: '7320' });
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw());
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(3_000)));
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(1);
      expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();

      capturedPollCallback!();
      await flush();
      expect(mockHandleResponse).toHaveBeenCalledTimes(2);
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledTimes(1);
    });

    it('5분(stale) 경과하면 재시도 대신 폐기(clear)한다', async () => {
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw());
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(LIVE_ACTIVITY_INTENT_STALE_MS + 1)));
      await flush();
      expect(mockHandleResponse).not.toHaveBeenCalled();
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-1000000');
    });

    it.each([
      ['서버 5xx(status 있음)', { posted: true, status: 500 }],
      ['POST 안 나감(URL 미설정 등)', { posted: false }],
    ])('%s → 재시도하지 않고 clear', async (_label, outcome) => {
      mockHandleResponse.mockResolvedValue(outcome);
      mockReadPendingBoardingIntent.mockReturnValue(boardedRaw());
      renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(3_000)));
      await flush();
      expect(mockClearPendingBoardingIntent).toHaveBeenCalledTimes(1);
    });
  });
});
