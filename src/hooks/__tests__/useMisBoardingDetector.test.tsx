import { renderHook, act } from '@testing-library/react-native';
import {
  useMisBoardingDetector,
  MIS_BOARDING_GRACE_MS,
  MIS_BOARDING_MISS_THRESHOLD,
} from '../useMisBoardingDetector';
import type { BoardingLock } from '../../types/boardingLock';
import type { LinePositions, TrainPosition } from '../../api/positionApi';

const baseLock: BoardingLock = {
  destinationId: 'd',
  trainCode: 'T-LOCK',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 1_800_000,
};

function train(trainNo: string): TrainPosition {
  return {
    statnId: '',
    statnNm: '',
    trainNo,
    trainStatus: 0,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
  };
}

const absentPositions: LinePositions = { line: '2', trains: [train('T-OTHER')] };
const presentPositions: LinePositions = { line: '2', trains: [train('T-LOCK')] };

type Props = Parameters<typeof useMisBoardingDetector>[0];

describe('useMisBoardingDetector', () => {
  it('lock=null이면 항상 detected=false', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result } = renderHook(() =>
      useMisBoardingDetector({ lock: null, positions: absentPositions, now }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('grace 기간 내 absent는 카운터 미증가 (detected=false 유지)', () => {
    const now = () => baseLock.boardedAt + 100;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD + 5; i++) {
      rerender({ lock: baseLock, positions: { ...absentPositions }, now });
    }
    expect(result.current.detected).toBe(false);
  });

  it('grace 이후 absent 관측이 threshold회 누적되면 detected=true', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    // 첫 번째 mount = 1회 관측. threshold-1번 더 rerender.
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => {
        rerender({ lock: baseLock, positions: { ...absentPositions }, now });
      });
    }
    expect(result.current.detected).toBe(true);
  });

  it('present 관측이 들어오면 카운터 reset + detected=false', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);

    act(() => rerender({ lock: baseLock, positions: presentPositions, now }));
    expect(result.current.detected).toBe(false);
  });

  it('lock.trainCode가 바뀌면 카운터/detected reset', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);

    const newLock = { ...baseLock, trainCode: 'T-NEW' };
    act(() => rerender({ lock: newLock, positions: absentPositions, now }));
    expect(result.current.detected).toBe(false);
  });

  it('lock → null이면 detected reset', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);

    act(() => rerender({ lock: null, positions: absentPositions, now }));
    expect(result.current.detected).toBe(false);
  });

  it('positions.isMock=true는 no-signal로 처리되어 카운터 미증가', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const mockPositions: LinePositions = { ...absentPositions, isMock: true };
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: mockPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD + 5; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...mockPositions }, now }));
    }
    expect(result.current.detected).toBe(false);
  });

  it('positions=null이면 카운터 미증가', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: null, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD + 5; i++) {
      act(() => rerender({ lock: baseLock, positions: null, now }));
    }
    expect(result.current.detected).toBe(false);
  });

  it('now 기본값(Date.now) 사용 — boardedAt이 과거라면 grace 통과', () => {
    const longAgoLock = { ...baseLock, boardedAt: 0 }; // 1970
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: longAgoLock, positions: absentPositions } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: longAgoLock, positions: { ...absentPositions } }));
    }
    expect(result.current.detected).toBe(true);
  });

  it('동일 trainCode + 다른 boardedAt(=새 lock) → 카운터/감지 reset + grace 재적용', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);

    // 같은 trainCode를 다시 탭한 시뮬레이션 — boardedAt 갱신
    const refreshedLock = { ...baseLock, boardedAt: baseLock.boardedAt + 10_000 };
    const stillInGraceNow = () => refreshedLock.boardedAt + 100;
    act(() =>
      rerender({ lock: refreshedLock, positions: absentPositions, now: stillInGraceNow }),
    );
    // 새 lock → detected reset + grace 안이라 누적도 안 됨
    expect(result.current.detected).toBe(false);
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD + 2; i++) {
      act(() =>
        rerender({ lock: refreshedLock, positions: { ...absentPositions }, now: stillInGraceNow }),
      );
    }
    expect(result.current.detected).toBe(false);
  });

  it('detected=true 상태에서 present 후 absent threshold 재누적 시 다시 true', () => {
    const now = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: baseLock, positions: absentPositions, now } },
    );
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD - 1; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);

    act(() => rerender({ lock: baseLock, positions: presentPositions, now }));
    expect(result.current.detected).toBe(false);

    // 다시 absent 누적
    for (let i = 0; i < MIS_BOARDING_MISS_THRESHOLD; i++) {
      act(() => rerender({ lock: baseLock, positions: { ...absentPositions }, now }));
    }
    expect(result.current.detected).toBe(true);
  });
});
