import { renderHook, act, type RenderHookResult } from '@testing-library/react-native';
import {
  useMisBoardingDetector,
  MIS_BOARDING_GRACE_MS,
  MIS_BOARDING_MISS_THRESHOLD,
} from '../useMisBoardingDetector';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { LinePositions, TrainPosition } from '../../../../shared/types/position';

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
type Result = ReturnType<typeof useMisBoardingDetector>;

const afterGraceNow = () => baseLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;

/** 표준 mount: lock=baseLock, positions=absent, now=afterGrace 기본값. override로 변형. */
function mount(initial: Partial<Props> = {}): RenderHookResult<Result, Props> {
  return renderHook((props: Props) => useMisBoardingDetector(props), {
    initialProps: {
      lock: baseLock,
      positions: absentPositions,
      now: afterGraceNow,
      ...initial,
    },
  });
}

/** rerender를 N회 — 매번 새 positions 객체로 effect 강제 발화. */
function rerenderTimes(
  rerender: (p: Props) => void,
  props: Props,
  times: number,
): void {
  for (let i = 0; i < times; i++) {
    act(() => rerender({ ...props, positions: props.positions ? { ...props.positions } : null }));
  }
}

describe('useMisBoardingDetector', () => {
  it('lock=null이면 항상 detected=false', () => {
    const { result } = mount({ lock: null });
    expect(result.current.detected).toBe(false);
  });

  it('grace 기간 내 absent는 카운터 미증가', () => {
    const inGraceNow = () => baseLock.boardedAt + 100;
    const { result, rerender } = mount({ now: inGraceNow });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: inGraceNow },
      MIS_BOARDING_MISS_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('grace 이후 absent threshold회 누적되면 detected=true', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);
  });

  it('present 관측이 들어오면 카운터 reset + detected=false', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: baseLock, positions: presentPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('lock.trainCode가 바뀌면 카운터/detected reset', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({
        lock: { ...baseLock, trainCode: 'T-NEW' },
        positions: absentPositions,
        now: afterGraceNow,
      }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('lock → null이면 detected reset', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: null, positions: absentPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('positions.isMock=true는 no-signal로 처리되어 카운터 미증가', () => {
    const mockPositions: LinePositions = { ...absentPositions, isMock: true };
    const { result, rerender } = mount({ positions: mockPositions });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mockPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('positions=null이면 카운터 미증가', () => {
    const { result, rerender } = mount({ positions: null });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: null, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('now 기본값(Date.now) 사용 — boardedAt 과거면 grace 통과', () => {
    const longAgoLock = { ...baseLock, boardedAt: 0 };
    const { result, rerender } = renderHook(
      (props: Props) => useMisBoardingDetector(props),
      { initialProps: { lock: longAgoLock, positions: absentPositions } },
    );
    rerenderTimes(
      rerender,
      { lock: longAgoLock, positions: absentPositions },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);
  });

  it('동일 trainCode + 다른 boardedAt(=새 lock) → reset + grace 재적용', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    const refreshedLock = { ...baseLock, boardedAt: baseLock.boardedAt + 10_000 };
    const stillInGrace = () => refreshedLock.boardedAt + 100;
    act(() =>
      rerender({ lock: refreshedLock, positions: absentPositions, now: stillInGrace }),
    );
    expect(result.current.detected).toBe(false);
    rerenderTimes(
      rerender,
      { lock: refreshedLock, positions: absentPositions, now: stillInGrace },
      MIS_BOARDING_MISS_THRESHOLD + 2,
    );
    expect(result.current.detected).toBe(false);
  });

  it('detected=true 상태에서 present 후 absent 재누적 시 다시 true', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: baseLock, positions: presentPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);

    rerenderTimes(
      rerender,
      { lock: baseLock, positions: absentPositions, now: afterGraceNow },
      MIS_BOARDING_MISS_THRESHOLD,
    );
    expect(result.current.detected).toBe(true);
  });
});
