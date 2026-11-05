/* eslint-disable import/no-restricted-paths --
 * handleTripGone은 destination store(route 슬라이스)를 읽는 cross-feature orchestrator.
 */
/**
 * PR-2 (plan 2026-10-21 §2.5/§2.7) — `handleTripGone`: gone(404/410) 판정 -> claim -> 통지 -> 정본 종료 시퀀스.
 * launch 와 FG tick 이 공유한다.
 */
import { DEFAULT_TRIP_TTL_MS } from '../../api/alarmBackend';
import { TRIP_GONE_GRACE_MS } from '../../../../shared/constants/realtime';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import { handleTripGone } from '../tripGoneSelfEnd';
import { __resetTripEndClaimsForTests__, claimTripEnd } from '../tripEndClaim';

const mockGetTripStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../tripStartStorage', () => ({ getTripStartedAt: () => mockGetTripStartedAt() }));
const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({ getBoardingLock: () => mockGetBoardingLock() }));
const mockHasFutureAlarm = jest.fn<Promise<boolean>, [string]>();
jest.mock('../tripGone', () => ({
  ...jest.requireActual('../tripGone'),
  hasFutureTripArrivalAlarm: (t: string) => mockHasFutureAlarm(t),
}));
const mockNotify = jest.fn();
jest.mock('../tripEndedNotification', () => ({ notifyTripEnded: (...a: unknown[]) => mockNotify(...a) }));
const mockCleanupGone = jest.fn();
jest.mock('../tripEndedCleanupSequence', () => ({
  cleanupBackendGoneTrip: (...a: unknown[]) => mockCleanupGone(...a),
}));
const mockAppendAlarmLog = jest.fn();
jest.mock('../alarmLog', () => ({ appendAlarmLog: (e: unknown) => mockAppendAlarmLog(e) }));
const mockGetCorrId = jest.fn<string | null, []>();
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCorrId(),
}));
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const START = 1_700_000_000_000;
const PAST_BOUND = START + DEFAULT_TRIP_TTL_MS + TRIP_GONE_GRACE_MS + 1;
const GONE = { status: 'gone', code: 404 } as const;
const ARGS = { result: GONE, tripToken: 'tk', site: 'launch' } as const;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(PAST_BOUND);
  mockGetTripStartedAt.mockResolvedValue(START);
  mockGetBoardingLock.mockResolvedValue(null);
  mockHasFutureAlarm.mockResolvedValue(false);
  mockNotify.mockResolvedValue(undefined);
  mockCleanupGone.mockResolvedValue(undefined);
  mockGetCorrId.mockReturnValue('corr-1');
  __resetTripEndClaimsForTests__();
  useDestinationStore.setState({ destination: MOCK_STATIONS.gangnam });
});
afterEach(() => jest.restoreAllMocks());

const logged = (reason: string) =>
  mockAppendAlarmLog.mock.calls.some(([e]) => (e as { reason?: string }).reason === reason);

describe('handleTripGone — 종료', () => {
  it("모든 guard 통과 -> 'ended': 통지(backend-gone) -> 정본 종료 시퀀스, 순서 고정", async () => {
    await expect(handleTripGone(ARGS)).resolves.toBe('ended');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      destination: MOCK_STATIONS.gangnam,
      reason: 'backend-gone',
    });
    expect(mockCleanupGone).toHaveBeenCalledTimes(1);
    expect(mockCleanupGone).toHaveBeenCalledWith(PAST_BOUND);
    // corrId·ACTIVE_TRIP_KEY가 cleanup에서 지워지므로 통지가 먼저.
    expect(mockNotify.mock.invocationCallOrder[0]).toBeLessThan(
      mockCleanupGone.mock.invocationCallOrder[0],
    );
    expect(logged('trip-gone-self-end')).toBe(true);
  });

  it('410도 동일하게 종료한다', async () => {
    await expect(handleTripGone({ ...ARGS, result: { status: 'gone', code: 410 } })).resolves.toBe('ended');
  });

  it("만료된 lock은 종료를 막지 못한다 -> 'ended'", async () => {
    mockGetBoardingLock.mockResolvedValue({
      trainCode: '1',
      boardingLine: '2',
      boardedAt: START,
      expectedDurationMs: 60_000,
    });
    await expect(handleTripGone(ARGS)).resolves.toBe('ended');
  });
});

describe('handleTripGone — 유예(종료 안 함, 사유 assert)', () => {
  it.each([
    ['young', () => mockGetTripStartedAt.mockResolvedValue(PAST_BOUND - 60_000), 'young'],
    ['tripStartedAt 부재', () => mockGetTripStartedAt.mockResolvedValue(null), 'young'],
    [
      'lock',
      () =>
        mockGetBoardingLock.mockResolvedValue({
          trainCode: '1',
          boardingLine: '2',
          boardedAt: PAST_BOUND - 60_000,
          expectedDurationMs: 60 * 60_000,
        }),
      'deferred',
    ],
    ['alarm', () => mockHasFutureAlarm.mockResolvedValue(true), 'deferred'],
  ])('%s -> %s: 통지·cleanup 0회, defer 사유 기록', async (name, arrange, outcome) => {
    arrange();
    await expect(handleTripGone(ARGS)).resolves.toBe(outcome);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockCleanupGone).not.toHaveBeenCalled();
    const reason = name === 'tripStartedAt 부재' ? 'young' : name;
    expect(logged(`trip-gone-defer-${reason}`)).toBe(true);
    expect(logged('trip-gone-self-end')).toBe(false);
  });

  it("gone이 아니면 'not-gone' — 아무것도 하지 않는다", async () => {
    await expect(
      handleTripGone({ ...ARGS, result: { status: 'active', endedAt: null, endReason: null } }),
    ).resolves.toBe('not-gone');
    expect(mockCleanupGone).not.toHaveBeenCalled();
    expect(mockAppendAlarmLog).not.toHaveBeenCalled();
  });
});

describe('handleTripGone — 동시 종료 경쟁(claim)', () => {
  it("다른 경로(9h 등)가 같은 종료를 먼저 선점했으면 'skipped' — 통지·cleanup 0회", async () => {
    expect(claimTripEnd('end:corr-1')).toBe(true);
    await expect(handleTripGone(ARGS)).resolves.toBe('skipped');
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockCleanupGone).not.toHaveBeenCalled();
  });

  it('동시에 두 번 호출해도 종료 효과·통지는 1회', async () => {
    const [a, b] = await Promise.all([handleTripGone(ARGS), handleTripGone(ARGS)]);
    expect([a, b].sort()).toEqual(['ended', 'skipped']);
    expect(mockCleanupGone).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('cleanup이 실패하면 claim을 풀어 다음 시도가 재시도할 수 있게 하고 오류를 전파한다', async () => {
    mockCleanupGone.mockRejectedValueOnce(new Error('io'));
    await expect(handleTripGone(ARGS)).rejects.toThrow('io');
    await expect(handleTripGone(ARGS)).resolves.toBe('ended');
  });
});
