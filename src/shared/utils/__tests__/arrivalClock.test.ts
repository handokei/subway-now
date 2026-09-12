import { arrivalAt } from '../arrivalClock';

describe('arrivalAt', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('현재 시각 + arrivalSeconds*1000 ms 반환', () => {
    const fixed = new Date(2026, 0, 1, 9, 0, 0).getTime();
    jest.useFakeTimers().setSystemTime(fixed);
    expect(arrivalAt({ arrivalSeconds: 180 })).toBe(fixed + 180_000);
    expect(arrivalAt({ arrivalSeconds: 0 })).toBe(fixed);
  });

  it('Seam A 동기화: useArrivalCountdown tick과 함께 arrivalSeconds가 줄어들면 anchor는 stable (시계가 흐른 만큼 보정)', () => {
    const t0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
    jest.useFakeTimers().setSystemTime(t0);
    const initialEta = 180;
    const a0 = arrivalAt({ arrivalSeconds: initialEta });
    // 60초 흘렀고, useArrivalCountdown tick으로 arrivalSeconds도 60 줄었다.
    jest.setSystemTime(t0 + 60_000);
    const a1 = arrivalAt({ arrivalSeconds: initialEta - 60 });
    expect(a1).toBe(a0);
  });

  it('clock anchor — 같은 폴링 cycle 내 동일 arrivalSeconds 두 호출은 같은 결과(시계 동결 가정)', () => {
    const fixed = 1_700_000_000_000;
    jest.useFakeTimers().setSystemTime(fixed);
    expect(arrivalAt({ arrivalSeconds: 134 })).toBe(arrivalAt({ arrivalSeconds: 134 }));
  });

  it('Acceptance #897: BoardingTrainList anchor와 journeyAdapter anchor가 60s tick 후에도 동일', () => {
    // BoardingTrainList의 formatArrivalClock(=arrivalAt)과 journeyAdapter.arrivalInfoToArrivalTrain의
    // arrivalAtMs(=arrivalAt)는 같은 input을 받으면 같은 시각을 반환해야 한다.
    const t0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
    jest.useFakeTimers().setSystemTime(t0);
    const initialSeconds = 180;
    const boardingListAnchor = arrivalAt({ arrivalSeconds: initialSeconds });
    const arrivalRowAnchor = arrivalAt({ arrivalSeconds: initialSeconds });
    expect(boardingListAnchor).toBe(arrivalRowAnchor);

    // 60초 tick: useArrivalCountdown은 arrivalSeconds를 60 줄이고, useCountdown의 절대 시각은 그대로.
    // 두 surface가 보는 anchor는 여전히 같다.
    jest.setSystemTime(t0 + 60_000);
    const tickedBoardingList = arrivalAt({ arrivalSeconds: initialSeconds - 60 });
    // arrivalRow는 polling 사이 절대 시각 그대로 유지.
    expect(tickedBoardingList).toBe(arrivalRowAnchor);
  });
});
