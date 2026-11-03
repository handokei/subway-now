/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration 테스트 — 대상 훅과 동일 사유로 옵트인.
 */
/**
 * #3007 PR-2 — 종료 질문 [계속] pending 마커(`END_PROMPT_CONTINUE`) 재전송.
 * native ContinueGuidanceIntent가 POST에 실패하면(status 0 등) FG 진입 시 브릿지가 재전송한다(5분 stale 상한).
 * 탑승/하차 lock 로직(handleResponse·createLock)은 이 마커와 무관하다.
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

const mockPostEndPromptContinue = jest.fn();
jest.mock('../../api/alarmBackend', () => ({
  postEndPromptContinue: (...args: unknown[]) => mockPostEndPromptContinue(...args),
}));

const mockHandleResponse = jest.fn();
jest.mock('../useBoardingPromptResponder', () => ({
  handleResponse: (...args: unknown[]) => mockHandleResponse(...args),
}));

jest.mock('../../../../shared/hooks/usePolling', () => ({ usePolling: jest.fn() }));

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

import { parsePendingBoardingIntent, useLiveActivityIntentBridge } from '../useLiveActivityIntentBridge';
import {
  LIVE_ACTIVITY_INTENT_STALE_MS,
  NATIVE_CONFIRM_WAIT_MS,
} from '../../../../shared/constants/boardingLock';

const baseDeps = { fetchArrivalsForStation: jest.fn(), destinationId: 'dest-1', expectedDurationMs: 30 * 60_000 };
const TAP_AT = 2_000_000;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const nowAt = (offsetMs: number) => () => TAP_AT + offsetMs;
const continueRaw = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'tok-2000000',
    tripToken: 'tok',
    action: 'END_PROMPT_CONTINUE',
    originStation: '',
    line: '',
    atMs: TAP_AT,
    ...extra,
  });

async function runBridge(raw: string, offsetMs = 1_000): Promise<void> {
  mockReadPendingBoardingIntent.mockReturnValue(raw);
  renderHook(() => useLiveActivityIntentBridge(baseDeps, nowAt(offsetMs)));
  await flush();
}

describe('useLiveActivityIntentBridge — #3007 PR-2 END_PROMPT_CONTINUE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostEndPromptContinue.mockResolvedValue({ ok: true, status: 200 });
  });

  it('parse: origin/line이 비어도 END_PROMPT_CONTINUE는 유효하다 (종료 질문에는 역·노선이 없다)', () => {
    expect(parsePendingBoardingIntent(continueRaw())).toMatchObject({
      id: 'tok-2000000',
      tripToken: 'tok',
      action: 'END_PROMPT_CONTINUE',
      atMs: TAP_AT,
    });
  });

  it('[거부] 다른 action은 여전히 origin/line이 비면 null', () => {
    const raw = JSON.stringify({ ...JSON.parse(continueRaw()), action: 'BOARDING_BOARDED' });
    expect(parsePendingBoardingIntent(raw)).toBeNull();
  });

  it('native POST 성공(2xx) -> 재전송 없이 마커만 clear', async () => {
    await runBridge(continueRaw({ nativePost: { status: 200, atMs: TAP_AT + 100 } }));
    expect(mockPostEndPromptContinue).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it('native POST 4xx(trip 없음 등 재시도 무의미) -> 재전송 없이 clear', async () => {
    await runBridge(continueRaw({ nativePost: { status: 404, atMs: TAP_AT + 100 } }));
    expect(mockPostEndPromptContinue).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it.each([
    ['status 0 (네트워크 실패/마감)', { nativePost: { status: 0, atMs: TAP_AT + 100 } }],
    ['5xx', { nativePost: { status: 503, atMs: TAP_AT + 100 } }],
    ['nativePost 부재 (native가 POST 전에 죽음)', {}],
  ])('%s -> JS가 재전송하고 성공하면 clear', async (_l, extra) => {
    await runBridge(continueRaw(extra));
    expect(mockPostEndPromptContinue).toHaveBeenCalledTimes(1);
    expect(mockPostEndPromptContinue).toHaveBeenCalledWith('tok');
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it('재전송도 실패(응답 없음)하면 clear하지 않는다 -> 다음 FG 진입에서 재시도', async () => {
    mockPostEndPromptContinue.mockResolvedValue({ ok: false });
    await runBridge(continueRaw({ nativePost: { status: 0, atMs: TAP_AT + 100 } }));
    expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
  });

  it('재전송이 5xx여도 clear하지 않는다', async () => {
    mockPostEndPromptContinue.mockResolvedValue({ ok: false, status: 500 });
    await runBridge(continueRaw());
    expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
  });

  it('재전송이 404면 재시도 무의미 -> clear', async () => {
    mockPostEndPromptContinue.mockResolvedValue({ ok: false, status: 404 });
    await runBridge(continueRaw());
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it('in-flight + 대기 예산 내 -> 보류(재전송·clear 없음)', async () => {
    await runBridge(continueRaw({ nativePost: 'in-flight' }), NATIVE_CONFIRM_WAIT_MS);
    expect(mockPostEndPromptContinue).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).not.toHaveBeenCalled();
  });

  it('in-flight + 대기 예산 경과 -> 재전송', async () => {
    await runBridge(continueRaw({ nativePost: 'in-flight' }), NATIVE_CONFIRM_WAIT_MS + 1);
    expect(mockPostEndPromptContinue).toHaveBeenCalledWith('tok');
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it('5분 stale 상한 초과 -> 재전송 없이 폐기', async () => {
    await runBridge(continueRaw(), LIVE_ACTIVITY_INTENT_STALE_MS + 1);
    expect(mockPostEndPromptContinue).not.toHaveBeenCalled();
    expect(mockClearPendingBoardingIntent).toHaveBeenCalledWith('tok-2000000');
  });

  it('lock 경로를 건드리지 않는다 (handleResponse·createLock·탑승 LA 종료 없음)', async () => {
    await runBridge(continueRaw());
    expect(mockHandleResponse).not.toHaveBeenCalled();
    expect(mockCreateLock).not.toHaveBeenCalled();
    expect(mockEndBoardingActivity).not.toHaveBeenCalled();
  });
});
