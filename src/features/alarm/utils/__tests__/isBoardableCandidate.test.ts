import { isBoardableCandidate, type BoardableCandidateContext } from '../isBoardableCandidate';
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
