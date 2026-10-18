import { promotePendingLockFromConfirm } from '../promotePendingLockFromConfirm';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockLogInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: (...a: unknown[]) => mockLogInfo(...a), warn: jest.fn(), error: jest.fn() }),
}));

const BASE: BoardingLock = {
  destinationId: 'dst',
  trainCode: PENDING_TRAIN_CODE,
  boardingStationId: 'S1',
  boardingLine: '2',
  boardedAt: 1_000,
  expectedDurationMs: 600_000,
};

describe('promotePendingLockFromConfirm (#3055 C)', () => {
  beforeEach(() => {
    useBoardingLockStore.setState({ lock: null });
  });

  it('boardingEvidence가 없는 레거시 PENDING lock도 evidence=false로 교체한다', async () => {
    useBoardingLockStore.setState({ lock: BASE });
    const createLock = jest.fn(async () => undefined);
    const promoted = await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock);
    expect(promoted).toBe(true);
    expect(createLock).toHaveBeenCalledWith(
      expect.objectContaining({ trainCode: '7325', boardedAt: 1_000 }),
      false,
      'boarding-confirm-response',
      undefined,
    );
  });

  it('PENDING lock의 boardingEvidence=true는 그대로 전달한다', async () => {
    useBoardingLockStore.setState({ lock: { ...BASE, boardingEvidence: true } });
    const createLock = jest.fn(async () => undefined);
    await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock);
    expect(createLock).toHaveBeenCalledWith(expect.anything(), true, 'boarding-confirm-response', undefined);
  });

  it('resolveTier는 lock 입력이 아니라 4번째 인자(telemetry)로만 전달한다', async () => {
    useBoardingLockStore.setState({ lock: BASE });
    const createLock = jest.fn(async () => undefined);
    await promotePendingLockFromConfirm(
      { resolvedTrainCode: '7325', resolveTier: 'assertion-departed' },
      createLock,
    );
    const [lockInput, , source, tier] = createLock.mock.calls[0] as unknown[];
    expect(lockInput).not.toHaveProperty('resolveTier');
    expect(source).toBe('boarding-confirm-response');
    expect(tier).toBe('assertion-departed');
  });

  it('[거부] 실 lock과 응답 열차가 다르면 교체하지 않되 불일치 관측 로그를 남긴다', async () => {
    useBoardingLockStore.setState({ lock: { ...BASE, trainCode: 'T1' } });
    const createLock = jest.fn(async () => undefined);
    expect(await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock)).toBe(false);
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('local=T1 backend=7325'));
    mockLogInfo.mockClear();
    // 같은 열차면 조용히 무시
    expect(await promotePendingLockFromConfirm({ resolvedTrainCode: 'T1' }, createLock)).toBe(false);
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('[거부] 실 lock / lock 없음 / 응답 없음 → createLock 미호출', async () => {
    const createLock = jest.fn(async () => undefined);
    useBoardingLockStore.setState({ lock: { ...BASE, trainCode: 'T1' } });
    expect(await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock)).toBe(false);
    useBoardingLockStore.setState({ lock: null });
    expect(await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock)).toBe(false);
    useBoardingLockStore.setState({ lock: BASE });
    expect(await promotePendingLockFromConfirm(undefined, createLock)).toBe(false);
    expect(await promotePendingLockFromConfirm({}, createLock)).toBe(false);
    expect(createLock).not.toHaveBeenCalled();
  });
});
