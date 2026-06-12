/* eslint-disable import/no-restricted-paths --
 * Cross-feature SSOT 회귀 게이트. BoardingTrainList(arrival surface)와 EditorialArrivalRow
 * 의 anchor가 같은 `arrivalAt(item)`에 수렴함을 증명하려면 route 슬라이스의 journeyAdapter
 * (ArrivalRow가 실제로 거치는 어댑터)를 직접 import해야 한다. test-only.
 */
/**
 * D7 (#1213) — BoardingTrainList ETA vs Arrival 표시 ETA provider 일관성.
 *
 * 사용자 보고: 같은 시점에 BoardingTrainList의 ETA와 정상 Arrival 표시(EditorialArrivalRow)의
 * ETA가 다른 값으로 보일 가능성. 분석 결과 두 surface는 같은 source(useArrivalInfo → useArrivalCountdown)
 * 를 공유하며, 절대 도착 시각 anchor도 `arrivalAt(item) = Date.now() + arrivalSeconds * 1000`로 통일
 * (#897 Seam A). 본 테스트는 그 SSOT 계약을 회귀 게이트로 못 박는다.
 *
 * 정의:
 *   - BoardingTrainList 표시 시각:
 *       formatClockTime(arrivalAt(item))   ← src/features/alarm/components/BoardingTrainList.tsx
 *   - EditorialArrivalRow 표시 시각의 anchor:
 *       arrivalInfoToArrivalTrain(items, ...).arrivalAtMs = arrivalAt(item)
 *                                          ← src/features/route/utils/journeyAdapter.ts
 *
 * 두 식이 같은 `arrivalAt(item)` 호출에 수렴해야 두 표시가 같은 시각을 가리킨다.
 */

import { arrivalAt } from '../../../shared/utils/arrivalClock';
import { formatClockTime } from '../../../shared/utils/formatTime';
import { arrivalInfoToArrivalTrain } from '../../route/utils/journeyAdapter';
import { makeArrivalInfo } from '../../../testUtils/fixtures';

// SonarCloud dup 회피 — outer scope helper. nested function 선언 금지 룰 준수.
const FIXED_T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();

function setNow(t: number) {
  jest.useFakeTimers().setSystemTime(t);
}

function boardingTrainListClock(item: { arrivalSeconds: number }): string {
  return formatClockTime(arrivalAt(item));
}

function arrivalRowAnchor(item: { arrivalSeconds: number }): number {
  // EditorialArrivalRow는 train.arrivalAtMs를 useCountdown에 전달 — arrivalAtMs = arrivalAt(item).
  const [train] = arrivalInfoToArrivalTrain(
    [makeArrivalInfo({ destination: '봉화산행', arrivalSeconds: item.arrivalSeconds })],
    '상행',
    '6',
  );
  return train.arrivalAtMs;
}

describe('D7 #1213 ETA provider consistency', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([0, 60, 134, 271, 600])(
    'arrivalSeconds=%d: BoardingTrainList anchor === ArrivalRow anchor',
    (arrivalSeconds) => {
      setNow(FIXED_T0);
      const item = { arrivalSeconds };
      expect(arrivalAt(item)).toBe(arrivalRowAnchor(item));
    },
  );

  it.each([
    [0, 60],
    [30, 60],
    [60, 180],
    [120, 180],
    [180, 180],
  ])(
    'tick elapsed=%ds (initial=%ds) — useArrivalCountdown 차감 후 두 surface anchor stable + 동일',
    (elapsedSeconds, initialSeconds) => {
      // useArrivalCountdown이 매초 arrivalSeconds를 1씩 차감하면서 시계도 1초씩 흐른다.
      // arrivalAt = Date.now() + arrivalSeconds*1000은 양쪽 변화가 상쇄되어 stable.
      setNow(FIXED_T0);
      const boardingAnchor = arrivalAt({ arrivalSeconds: initialSeconds });
      const rowAnchor = arrivalRowAnchor({ arrivalSeconds: initialSeconds });
      expect(boardingAnchor).toBe(rowAnchor);

      setNow(FIXED_T0 + elapsedSeconds * 1000);
      const remaining = initialSeconds - elapsedSeconds;
      const boardingTicked = arrivalAt({ arrivalSeconds: remaining });
      const rowTicked = arrivalRowAnchor({ arrivalSeconds: remaining });

      // 양 surface가 동일 anchor를 본다 (SSOT 계약).
      expect(boardingTicked).toBe(rowTicked);
      // 초기 anchor 대비 stable (시계 + 차감 상쇄 → 0 drift).
      expect(boardingTicked).toBe(boardingAnchor);
    },
  );

  it('formatClockTime 출력이 두 surface에서 동일 (BoardingTrainList 표기 형식 검증)', () => {
    setNow(FIXED_T0);
    const item = { arrivalSeconds: 180 };
    const fromBoardingList = boardingTrainListClock(item);
    const fromRow = formatClockTime(arrivalRowAnchor(item));
    expect(fromBoardingList).toBe(fromRow);
  });

  it('동일 ArrivalInfo가 directionalArrivals와 arrival.up에 동시에 있을 때 두 표시 동일', () => {
    // 현재역 BoardingTrainList는 useBoardingLockController가 arrival.up/down을 그대로 필터해
    // directionalArrivals로 노출 — 새 source가 아니다. 같은 reference의 ArrivalInfo는 두 surface
    // 모두에서 같은 arrivalAt(item) 결과를 가진다.
    setNow(FIXED_T0);
    const shared = makeArrivalInfo({ destination: '봉화산행', arrivalSeconds: 134 });
    // BoardingTrainList path
    const boardingMs = arrivalAt(shared);
    // EditorialArrivalRow path
    const [train] = arrivalInfoToArrivalTrain([shared], '상행', '6');
    expect(train.arrivalAtMs).toBe(boardingMs);
  });
});
