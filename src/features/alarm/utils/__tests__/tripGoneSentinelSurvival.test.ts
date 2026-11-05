/* eslint-disable import/no-restricted-paths --
 * 종료 시퀀스(route destination store)와 sentinel 판정을 함께 검증하는 cross-feature 테스트.
 */
/**
 * PR-2 #2114 — backend-gone 자가 종료가 쓴 sentinel 이, 그 직후 시작된 **새 트립**을 지우지 않는다.
 * (2026-08-03 건대 RCA: 밤샘 트립 sentinel 이 새 트립을 FG 재진입 때 삭제.) 실제 sentinel 저장/판정을 쓴다.
 */
import { cleanupBackendGoneTrip } from '../tripEndedCleanupSequence';
import {
  getTripEndedSentinel,
  resolveTripEndedSentinelVerdict,
} from '../tripEndedSentinel';

jest.mock('../triggerTripEndRecall', () => ({ triggerTripEndRecall: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../store/tripBoundCleanups', () => ({ runTripBoundCleanups: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
  addLogBreadcrumb: jest.fn(),
}));
const mockGetCorrId = jest.fn<string | null, []>();
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCorrId(),
}));

const ENDED_AT = 1_700_000_000_000;

describe('#2114 — backend-gone sentinel 과 새 트립', () => {
  beforeEach(() => mockGetCorrId.mockReturnValue('corr-old'));

  it('종료된 트립의 sentinel 은 corrId 를 담는다', async () => {
    await cleanupBackendGoneTrip(ENDED_AT);
    await expect(getTripEndedSentinel()).resolves.toEqual({ endedAt: ENDED_AT, corrId: 'corr-old' });
  });

  it('새 트립(다른 corrId)은 이 sentinel 에 대해 stale 판정 -> rehydration 이 새 트립을 reset 하지 않는다', async () => {
    await cleanupBackendGoneTrip(ENDED_AT);
    const sentinel = await getTripEndedSentinel();
    // 새 트립은 sentinel 보다 나중에 시작했고 새 corrId 를 가진다.
    expect(resolveTripEndedSentinelVerdict(sentinel!, ENDED_AT + 60_000, 'corr-new')).toBe('stale');
  });

  it('같은 트립(같은 corrId)이면 fresh — 소비해 메모리 reset 한다(거부 대조군)', async () => {
    await cleanupBackendGoneTrip(ENDED_AT);
    const sentinel = await getTripEndedSentinel();
    expect(resolveTripEndedSentinelVerdict(sentinel!, ENDED_AT - 60_000, 'corr-old')).toBe('fresh');
  });
});
