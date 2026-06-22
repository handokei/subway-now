import { renderHook, act, type RenderHookResult } from '@testing-library/react-native';
import {
  useTrainCodeMismatchDetector,
  TRAIN_CODE_MISMATCH_GRACE_MS,
  TRAIN_CODE_MISMATCH_THRESHOLD,
} from '../useTrainCodeMismatchDetector';
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

/** lock.trainCode 있음 — 정상 탑승 */
const presentPositions: LinePositions = { line: '2', trains: [train('T-LOCK')] };
/** lock.trainCode 없고 다른 trainCode 존재 — mismatch */
const mismatchPositions: LinePositions = { line: '2', trains: [train('T-OTHER')] };
/** trains 빈 배열 — Seoul API stale */
const emptyPositions: LinePositions = { line: '2', trains: [] };

type Props = Parameters<typeof useTrainCodeMismatchDetector>[0];
type Result = ReturnType<typeof useTrainCodeMismatchDetector>;

const afterGraceNow = () => baseLock.boardedAt + TRAIN_CODE_MISMATCH_GRACE_MS + 1;

function mount(initial: Partial<Props> = {}): RenderHookResult<Result, Props> {
  return renderHook((props: Props) => useTrainCodeMismatchDetector(props), {
    initialProps: {
      lock: baseLock,
      positions: mismatchPositions,
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

describe('useTrainCodeMismatchDetector', () => {
  // 시나리오 1: mismatch 90s 후 detected=true
  it('lock.trainCode 없고 다른 train 존재 시 threshold 누적 후 detected=true', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);
  });

  // 시나리오 2: Seoul API stale (빈 배열 = no-signal → false invalidate 차단)
  it('trains 빈 배열(Seoul API stale)은 no-signal로 처리해 카운터 미증가', () => {
    const { result, rerender } = mount({ positions: emptyPositions });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: emptyPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  // 시나리오 3: lockless trip (lock=null → skip)
  it('lock=null이면 항상 detected=false', () => {
    const { result } = mount({ lock: null });
    expect(result.current.detected).toBe(false);
  });

  // 시나리오 4: 환승 leg 전환 (새 lock → reset)
  it('lock.boardedAt 변경(환승 leg 전환) 시 카운터/detected reset', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    const transferLock: BoardingLock = {
      ...baseLock,
      trainCode: 'T-TRANSFER',
      boardingLine: '3',
      boardedAt: baseLock.boardedAt + 10_000,
    };
    const afterTransferGrace = () => transferLock.boardedAt + TRAIN_CODE_MISMATCH_GRACE_MS + 1;
    act(() =>
      rerender({
        lock: transferLock,
        positions: { line: '3', trains: [train('T-OTHER-3')] },
        now: afterTransferGrace,
      }),
    );
    expect(result.current.detected).toBe(false);
  });

  // 시나리오 5: lock 부착 직후 grace 내 mismatch → detected=false
  it('grace 기간 내 mismatch는 카운터 미증가', () => {
    const inGraceNow = () => baseLock.boardedAt + 100;
    const { result, rerender } = mount({ now: inGraceNow });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: inGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('lock.trainCode가 present로 바뀌면 카운터 reset + detected=false', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: baseLock, positions: presentPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('present 후 mismatch 재누적 시 다시 true', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: baseLock, positions: presentPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);

    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD,
    );
    expect(result.current.detected).toBe(true);
  });

  it('positions=null이면 카운터 미증가', () => {
    const { result, rerender } = mount({ positions: null });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: null, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('positions.isMock=true는 no-signal로 처리해 카운터 미증가', () => {
    const mockPositions: LinePositions = { ...mismatchPositions, isMock: true };
    const { result, rerender } = mount({ positions: mockPositions });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mockPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('positions.line이 lock.boardingLine과 다르면 no-signal', () => {
    const otherLinePositions: LinePositions = { line: '5', trains: [train('T-OTHER')] };
    const { result, rerender } = mount({ positions: otherLinePositions });
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: otherLinePositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD + 5,
    );
    expect(result.current.detected).toBe(false);
  });

  it('lock → null이면 detected reset', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    act(() =>
      rerender({ lock: null, positions: mismatchPositions, now: afterGraceNow }),
    );
    expect(result.current.detected).toBe(false);
  });

  it('동일 trainCode + 다른 boardedAt(새 lock) → grace 재적용', () => {
    const { result, rerender } = mount();
    rerenderTimes(
      rerender,
      { lock: baseLock, positions: mismatchPositions, now: afterGraceNow },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);

    const refreshedLock: BoardingLock = { ...baseLock, boardedAt: baseLock.boardedAt + 10_000 };
    const stillInGrace = () => refreshedLock.boardedAt + 100;
    act(() =>
      rerender({ lock: refreshedLock, positions: mismatchPositions, now: stillInGrace }),
    );
    expect(result.current.detected).toBe(false);

    rerenderTimes(
      rerender,
      { lock: refreshedLock, positions: mismatchPositions, now: stillInGrace },
      TRAIN_CODE_MISMATCH_THRESHOLD + 2,
    );
    expect(result.current.detected).toBe(false);
  });

  it('now 기본값(Date.now) 사용 — boardedAt 과거면 grace 통과', () => {
    const longAgoLock: BoardingLock = { ...baseLock, boardedAt: 0 };
    const { result, rerender } = renderHook(
      (props: Props) => useTrainCodeMismatchDetector(props),
      { initialProps: { lock: longAgoLock, positions: mismatchPositions } },
    );
    rerenderTimes(
      rerender,
      { lock: longAgoLock, positions: mismatchPositions },
      TRAIN_CODE_MISMATCH_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);
  });
});
