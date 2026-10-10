import {
  isBoardableCandidate,
  isCandidateInBoardingScope,
  type BoardableCandidateContext,
} from '../isBoardableCandidate';
import type { ArrivalInfo } from '../../../../shared/types/arrival';

function arr(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '',
    arrivalMinutes: 0,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: 2,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

const CTX: BoardableCandidateContext = { line: '2', direction: 'up', nextTargetStationName: null };

describe('isBoardableCandidate (#2696 — 탑승 후보 판정 단일 술어)', () => {
  it('direction===null → 항상 false (방향 미해결은 후보 없음)', () => {
    expect(isBoardableCandidate(arr({}), { ...CTX, direction: null })).toBe(false);
  });

  it('노선 불일치 → false', () => {
    expect(isBoardableCandidate(arr({ line: '9' }), CTX)).toBe(false);
  });

  it.each([0, 1, 2])('arrivalCode=%d(진입/도착/출발) → true', (code) => {
    expect(isBoardableCandidate(arr({ arrivalCode: code }), CTX)).toBe(true);
  });

  it.each([-1, 3, 4, 5, 99])('arrivalCode=%d(그 외/아직 오지 않음) → false', (code) => {
    expect(isBoardableCandidate(arr({ arrivalCode: code }), CTX)).toBe(false);
  });

  it('nextTargetStationName 없음 → 조기종착 판정 skip, 통과', () => {
    expect(
      isBoardableCandidate(arr({ terminalStation: '아무데나' }), { ...CTX, nextTargetStationName: null }),
    ).toBe(true);
  });

  it('terminalStation 없음(파싱 실패/누락) → 조기종착 판정 skip, 통과', () => {
    expect(
      isBoardableCandidate(arr({ terminalStation: undefined }), {
        ...CTX,
        nextTargetStationName: '아무역',
      }),
    ).toBe(true);
  });

  // 2호선 실역명(뚝섬/성수/건대입구)으로 조기종착 판정 위임 확인 — 2026-09-17 8387 evidence.
  it('종착역이 다음 목표역 이전(조기종착) → false', () => {
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(isBoardableCandidate(arr({ terminalStation: '성수' }), ctx)).toBe(false);
  });

  it('종착역이 다음 목표역 이후(정상) → true', () => {
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(isBoardableCandidate(arr({ terminalStation: '잠실나루' }), ctx)).toBe(true);
  });
});

describe('isCandidateInBoardingScope (#2886 — 상태 게이트 없는 scope 술어, boardingListArrivals 전용)', () => {
  // #2886 — BoardingTrainList는 "곧 올 열차"를 전향적으로 제시하는 용도라, 아직 오지 않은
  // 열차(arvlCd=99)도 노출돼야 한다. isBoardableCandidate의 상태 게이트(출발/도착/진입만)는
  // 회고적 선택(usePrevTrainCandidate/boardingPromptAutoLock) 전용 — scope 술어는 그 게이트를
  // 적용하지 않는다: direction/노선일치/조기종착만 본다.
  it('direction===null → 항상 false (양방향 병합 금지, isBoardableCandidate와 동일 불변식)', () => {
    expect(isCandidateInBoardingScope(arr({}), { ...CTX, direction: null })).toBe(false);
  });

  it('노선 불일치 → false', () => {
    expect(isCandidateInBoardingScope(arr({ line: '9' }), CTX)).toBe(false);
  });

  it.each([0, 1, 2, 99])('arrivalCode=%d — 상태 게이트 없음, 노선/방향/종착만 통과하면 true', (code) => {
    expect(isCandidateInBoardingScope(arr({ arrivalCode: code }), CTX)).toBe(true);
  });

  it('종착역이 다음 목표역 이전(조기종착) → false (arvlCd=99여도)', () => {
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(
      isCandidateInBoardingScope(arr({ arrivalCode: 99, terminalStation: '성수' }), ctx),
    ).toBe(false);
  });

  it('종착역이 다음 목표역 이후(정상) + arvlCd=99 → true', () => {
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(
      isCandidateInBoardingScope(arr({ arrivalCode: 99, terminalStation: '잠실나루' }), ctx),
    ).toBe(true);
  });

  it('isBoardableCandidate = isCandidateInBoardingScope && 상태게이트 — 단일 출처 합성 확인', () => {
    const scopeOkButNotBoardable = arr({ arrivalCode: 99 });
    expect(isCandidateInBoardingScope(scopeOkButNotBoardable, CTX)).toBe(true);
    expect(isBoardableCandidate(scopeOkButNotBoardable, CTX)).toBe(false);
  });
});
