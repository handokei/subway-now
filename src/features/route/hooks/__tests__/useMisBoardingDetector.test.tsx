import { renderHook, act, type RenderHookResult } from '@testing-library/react-native';
import {
  useMisBoardingDetector,
  MIS_BOARDING_GRACE_MS,
  MIS_BOARDING_MISS_THRESHOLD,
} from '../useMisBoardingDetector';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { LinePositions, TrainPosition } from '../../../../shared/types/position';
import type { Route } from '../../../../shared/utils/stationRoute';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

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

// 반대 방향 탑승 감지 (#2455, Phase B). route/destinationName 전달 시에만 활성화되므로
// 실제 stations.json 데이터(뚝섬→신당, 2호선)로 direction 판정을 재현한다.
describe('useMisBoardingDetector — wrongDirectionDetected (#2455)', () => {
  const ddukseom = findStationByNameAndLine(canonicalStationName('뚝섬', '2'), '2')!;
  const sindangName = canonicalStationName('신당', '2');
  const directRoute: Route = { type: 'direct', stops: 4, line: '2', travelSeconds: 240 };
  const directionLock: BoardingLock = {
    destinationId: 'd',
    trainCode: 'T-LOCK',
    boardingStationId: ddukseom.id,
    boardingLine: '2',
    boardedAt: 1_000_000,
    expectedDurationMs: 1_800_000,
  };
  const afterDirectionGraceNow = () => directionLock.boardedAt + MIS_BOARDING_GRACE_MS + 1;

  function positionsAt(statnNm: string): LinePositions {
    return { line: '2', trains: [{ ...train('T-LOCK'), statnNm }] };
  }

  const wrongDirectionPositions = positionsAt('성수');
  const correctDirectionPositions = positionsAt('한양대');

  function mountDirection(initial: Partial<Props> = {}): RenderHookResult<Result, Props> {
    return renderHook((props: Props) => useMisBoardingDetector(props), {
      initialProps: {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
        ...initial,
      },
    });
  }

  it('route/destinationName 미전달 시 wrong-direction 관측이어도 wrongDirectionDetected 항상 false (기존 absent 동작 불변)', () => {
    const { result, rerender } = renderHook((props: Props) => useMisBoardingDetector(props), {
      initialProps: {
        lock: directionLock,
        positions: wrongDirectionPositions,
        now: afterDirectionGraceNow,
      },
    });
    rerenderTimes(
      rerender,
      { lock: directionLock, positions: wrongDirectionPositions, now: afterDirectionGraceNow },
      MIS_BOARDING_MISS_THRESHOLD + 5,
    );
    expect(result.current.wrongDirectionDetected).toBe(false);
    // route 없이는 detectMisBoarding이 항상 'present'(trainNo 매칭됨) → absent 카운터도 안 오른다.
    expect(result.current.detected).toBe(false);
  });

  it('grace 이후 wrong-direction threshold회 누적되면 wrongDirectionDetected=true', () => {
    const { result, rerender } = mountDirection();
    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.wrongDirectionDetected).toBe(true);
    // wrong-direction과 absent(=detected)는 배타적 — 동시에 true가 될 수 없다.
    expect(result.current.detected).toBe(false);
  });

  it('grace 내 wrong-direction은 카운터 미증가', () => {
    const inGraceNow = () => directionLock.boardedAt + 100;
    const { result, rerender } = mountDirection({ now: inGraceNow });
    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: inGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD + 5,
    );
    expect(result.current.wrongDirectionDetected).toBe(false);
  });

  it('정방향(한양대) 관측이 들어오면 wrongDirectionDetected reset', () => {
    const { result, rerender } = mountDirection();
    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.wrongDirectionDetected).toBe(true);

    act(() =>
      rerender({
        lock: directionLock,
        positions: correctDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      }),
    );
    expect(result.current.wrongDirectionDetected).toBe(false);
  });

  it('absent(다른 trainCode)가 들어오면 wrongDirectionDetected reset되고 detected 카운터가 누적된다', () => {
    const { result, rerender } = mountDirection();
    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.wrongDirectionDetected).toBe(true);

    const absentDirectionPositions: LinePositions = { line: '2', trains: [train('T-OTHER')] };
    act(() =>
      rerender({
        lock: directionLock,
        positions: absentDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      }),
    );
    expect(result.current.wrongDirectionDetected).toBe(false);
    expect(result.current.detected).toBe(false); // 1회차라 threshold 미도달

    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: absentDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.detected).toBe(true);
  });

  it('lock → null이면 wrongDirectionDetected도 reset', () => {
    const { result, rerender } = mountDirection();
    rerenderTimes(
      rerender,
      {
        lock: directionLock,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      },
      MIS_BOARDING_MISS_THRESHOLD - 1,
    );
    expect(result.current.wrongDirectionDetected).toBe(true);

    act(() =>
      rerender({
        lock: null,
        positions: wrongDirectionPositions,
        route: directRoute,
        destinationName: sindangName,
        now: afterDirectionGraceNow,
      }),
    );
    expect(result.current.wrongDirectionDetected).toBe(false);
  });
});
