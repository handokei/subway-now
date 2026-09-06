import { act } from '@testing-library/react-native';
import { useBoardingLockStore } from '../useBoardingLockStore';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import {
  clearLockLifecycleEntries,
  getLockLifecycleEntries,
} from '../../utils/boardingLockLifecycleBuffer';

const mockGetBoardingLock = jest.fn();
const mockSetBoardingLock = jest.fn();
const mockClearBoardingLock = jest.fn();
const mockClearDismissSilence = jest.fn();
const mockAddDomainBreadcrumb = jest.fn();

jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
  setBoardingLock: (...args: unknown[]) => mockSetBoardingLock(...args),
  clearBoardingLock: (...args: unknown[]) => mockClearBoardingLock(...args),
}));

jest.mock('../../utils/dismissSilenceStorage', () => ({
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

const sample: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 600_000,
};

describe('useBoardingLockStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetBoardingLock.mockResolvedValue(undefined);
    mockClearBoardingLock.mockResolvedValue(undefined);
    mockClearDismissSilence.mockResolvedValue(undefined);
    useBoardingLockStore.setState({ lock: null });
    clearLockLifecycleEntries();
  });

  it('초기 상태는 lock=null', () => {
    expect(useBoardingLockStore.getState().lock).toBeNull();
  });

  describe('createLock', () => {
    it('state + storage 양쪽 갱신', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false);
      });
      // #2290 P1 — createLock이 evidence 인자를 lock.boardingEvidence로 합성해 저장한다.
      expect(useBoardingLockStore.getState().lock).toEqual({ ...sample, boardingEvidence: false });
      expect(mockSetBoardingLock).toHaveBeenCalledWith({ ...sample, boardingEvidence: false });
    });

    it('기존 Lock을 새 Lock으로 교체 (multi-transfer 전환 대비)', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false);
      });
      const next: BoardingLock = { ...sample, trainCode: 'T-200', boardingLine: '7' };
      await act(async () => {
        await useBoardingLockStore.getState().createLock(next, true);
      });
      // evidence=true로 생성 — boardingEvidence:true가 합성돼야 한다.
      expect(useBoardingLockStore.getState().lock).toEqual({ ...next, boardingEvidence: true });
      expect(mockSetBoardingLock).toHaveBeenLastCalledWith({ ...next, boardingEvidence: true });
    });

    it('#746 — createLock은 dismissSilence storage를 즉시 클리어', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false);
      });
      expect(mockClearDismissSilence).toHaveBeenCalledTimes(1);
    });

    it('#2152 — source 미전달 시 lifecycle buffer에 create 엔트리 source=other로 적재', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false);
      });
      const entries = getLockLifecycleEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'boarding-lock-lifecycle',
        event: 'create',
        source: 'other',
        trainCode: sample.trainCode,
        line: sample.boardingLine,
        stationId: sample.boardingStationId,
      });
    });

    it('#2152 — source 전달 시 lifecycle buffer에 그대로 stamp', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false, 'user-tap');
      });
      const entries = getLockLifecycleEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ event: 'create', source: 'user-tap' });
    });
  });

  describe('releaseLock', () => {
    it('state=null + storage 정리', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(useBoardingLockStore.getState().lock).toBeNull();
      expect(mockClearBoardingLock).toHaveBeenCalled();
    });

    it('release breadcrumb는 직전 lock이 있을 때만 추가 (default reason=user)', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-release', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
        reason: 'user',
      });
    });

    it('lock이 없으면 release breadcrumb skip (noise 방지)', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });

    it('#2152 — lock이 있을 때만 lifecycle buffer에 release 엔트리 적재 (reason 포함)', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock('transfer');
      });
      const entries = getLockLifecycleEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'boarding-lock-lifecycle',
        event: 'release',
        reason: 'transfer',
        trainCode: sample.trainCode,
        line: sample.boardingLine,
      });
    });

    it('#2152 — lock이 없으면 lifecycle buffer에도 적재 안 됨', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(getLockLifecycleEntries()).toHaveLength(0);
    });

    it('#1438 (E5) — reason 인자가 breadcrumb 메타에 stamp된다 (transfer)', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock('transfer');
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-release', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
        reason: 'transfer',
      });
    });

    it('#1438 (E5) — reason=vanish도 breadcrumb에 forward', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock('vanish');
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-release', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
        reason: 'vanish',
      });
    });
  });

  describe('breadcrumb', () => {
    it('createLock 시 lock-create breadcrumb 추가', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample, false);
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-create', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
      });
    });
  });

  describe('loadLock', () => {
    it('storage 값 hydrate', async () => {
      mockGetBoardingLock.mockResolvedValueOnce(sample);
      await act(async () => {
        await useBoardingLockStore.getState().loadLock();
      });
      expect(useBoardingLockStore.getState().lock).toEqual(sample);
    });

    it('storage가 비어있으면 lock=null 유지', async () => {
      mockGetBoardingLock.mockResolvedValueOnce(null);
      await act(async () => {
        await useBoardingLockStore.getState().loadLock();
      });
      expect(useBoardingLockStore.getState().lock).toBeNull();
    });
  });

  describe('checkExpiry', () => {
    it('lock 없으면 false (no-op)', async () => {
      const expired = await useBoardingLockStore.getState().checkExpiry();
      expect(expired).toBe(false);
      expect(mockClearBoardingLock).not.toHaveBeenCalled();
    });

    it('미만료면 false + 상태 유지', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const expired = await useBoardingLockStore
        .getState()
        .checkExpiry(sample.boardedAt + sample.expectedDurationMs);
      expect(expired).toBe(false);
      expect(useBoardingLockStore.getState().lock).toEqual(sample);
    });

    it('만료 시 true 반환 + state/storage 정리', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const wayAfter = sample.boardedAt + sample.expectedDurationMs * 2;
      let expired = false;
      await act(async () => {
        expired = await useBoardingLockStore.getState().checkExpiry(wayAfter);
      });
      expect(expired).toBe(true);
      expect(useBoardingLockStore.getState().lock).toBeNull();
      expect(mockClearBoardingLock).toHaveBeenCalled();
    });

    it('now 미전달 시 Date.now() 사용', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const expired = await useBoardingLockStore.getState().checkExpiry();
      // sample.boardedAt=1_000_000은 1970년대 초 — 현재 시각이면 항상 만료.
      expect(expired).toBe(true);
    });
  });

  /**
   * Phase 1-7 (#1996, ADR-022 A4) — boardingStationId 불변 정책.
   *
   * `isSimpleArchEnabled()` flag OFF (default): 어떤 createLock이든 기존 lock 교체 (기존 동작).
   * `isSimpleArchEnabled()` flag ON: 동일 destination/trainCode/boardingLine인데 boardingStationId만
   *   다른 createLock은 auto-swap 시도로 간주 → skip. 정당한 route 재등록(trainCode/boardingLine 변경)은 통과.
   */
  describe('#1996 — boardingStationId 불변 (arch flag)', () => {
    // real `isSimpleArchEnabled()` wire — env var로 flag 게이트.
    const ENV_KEY = 'EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH';
    const originalEnv = process.env[ENV_KEY];
    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
    });

    describe('flag OFF (기존 동작 보존)', () => {
      beforeEach(() => {
        delete process.env[ENV_KEY];
      });

      it('boardingStationId만 다른 createLock도 기존 lock을 교체한다', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        const swapped: BoardingLock = { ...sample, boardingStationId: 'stn-DIFFERENT' };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(swapped, false);
        });
        // flag OFF → 기존 동작 (교체 발생).
        expect(useBoardingLockStore.getState().lock).toEqual({ ...swapped, boardingEvidence: false });
        expect(mockSetBoardingLock).toHaveBeenLastCalledWith({ ...swapped, boardingEvidence: false });
      });
    });

    describe('flag ON (immutability guard)', () => {
      beforeEach(() => {
        process.env[ENV_KEY] = 'true';
      });

      it('동일 destination/trainCode/boardingLine에서 boardingStationId만 다른 createLock은 skip한다', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        mockSetBoardingLock.mockClear();
        mockAddDomainBreadcrumb.mockClear();

        const attemptedSwap: BoardingLock = { ...sample, boardingStationId: 'stn-DIFFERENT' };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(attemptedSwap, false);
        });

        // 기존 lock은 그대로 유지, storage write 없음.
        expect(useBoardingLockStore.getState().lock).toEqual({ ...sample, boardingEvidence: false });
        expect(useBoardingLockStore.getState().lock?.boardingStationId).toBe('stn-A');
        expect(mockSetBoardingLock).not.toHaveBeenCalled();

        // skip 이벤트 breadcrumb stamp.
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-create-skip-immutable', {
          trainCode: sample.trainCode,
          line: sample.boardingLine,
          prevBoardingStationId: 'stn-A',
          attemptedBoardingStationId: 'stn-DIFFERENT',
        });
      });

      it('trainCode 변경(정당한 환승 leg)은 boardingStationId 변경을 허용한다', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        const legitimateTransfer: BoardingLock = {
          ...sample,
          trainCode: 'T-999', // 새 열차 = 정당한 route 재등록.
          boardingStationId: 'stn-TRANSFER',
        };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(legitimateTransfer, false);
        });
        expect(useBoardingLockStore.getState().lock).toEqual({ ...legitimateTransfer, boardingEvidence: false });
      });

      it('boardingLine 변경(다른 노선 leg)은 boardingStationId 변경을 허용한다', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        const transferLeg: BoardingLock = {
          ...sample,
          boardingLine: '7', // sample.boardingLine === '2' → 노선 변경.
          boardingStationId: 'stn-TRANSFER',
        };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(transferLeg, false);
        });
        expect(useBoardingLockStore.getState().lock).toEqual({ ...transferLeg, boardingEvidence: false });
      });

      it('destinationId 변경(다른 trip)은 boardingStationId 변경을 허용한다', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        const differentTrip: BoardingLock = {
          ...sample,
          destinationId: 'dest-DIFFERENT',
          boardingStationId: 'stn-DIFFERENT',
        };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(differentTrip, false);
        });
        expect(useBoardingLockStore.getState().lock).toEqual({ ...differentTrip, boardingEvidence: false });
      });

      it('boardingStationId가 동일하면 다른 필드 갱신 시 정상 교체', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        // 같은 leg 안에서 expectedDurationMs 등 다른 필드 갱신은 정당한 use case.
        const sameStationUpdate: BoardingLock = { ...sample, expectedDurationMs: 999_999 };
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sameStationUpdate, false);
        });
        expect(useBoardingLockStore.getState().lock).toEqual({ ...sameStationUpdate, boardingEvidence: false });
      });

      it('첫 lock 생성(기존 lock 없음)은 정상 처리', async () => {
        // lock=null 상태에서 createLock — 비교 대상이 없으므로 정책 우회 + 정상 생성.
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        expect(useBoardingLockStore.getState().lock).toEqual({ ...sample, boardingEvidence: false });
      });

      it('다수 tick 동안 auto-swap 시도해도 boardingStationId 변경 시도 0건', async () => {
        await act(async () => {
          await useBoardingLockStore.getState().createLock(sample, false);
        });
        mockSetBoardingLock.mockClear();

        // 여러 사이클에서 auto-swap 시도 (같은 leg + 다른 boardingStationId).
        const swapAttempts = ['stn-X1', 'stn-X2', 'stn-X3', 'stn-X4', 'stn-X5'];
        for (const stnId of swapAttempts) {
          await act(async () => {
            await useBoardingLockStore
              .getState()
              .createLock({ ...sample, boardingStationId: stnId }, false);
          });
        }

        // 원본 유지 + storage write 0건.
        expect(useBoardingLockStore.getState().lock?.boardingStationId).toBe('stn-A');
        expect(mockSetBoardingLock).not.toHaveBeenCalled();
      });
    });
  });
});
