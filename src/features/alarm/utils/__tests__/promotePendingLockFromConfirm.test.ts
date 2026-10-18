import { promotePendingLockFromConfirm } from '../promotePendingLockFromConfirm';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

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
      'boarding-prompt-response',
    );
  });

  it('PENDING lock의 boardingEvidence=true는 그대로 전달한다', async () => {
    useBoardingLockStore.setState({ lock: { ...BASE, boardingEvidence: true } });
    const createLock = jest.fn(async () => undefined);
    await promotePendingLockFromConfirm({ resolvedTrainCode: '7325' }, createLock);
    expect(createLock).toHaveBeenCalledWith(expect.anything(), true, 'boarding-prompt-response');
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
