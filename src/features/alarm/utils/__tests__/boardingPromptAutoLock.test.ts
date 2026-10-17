import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import { pickAutoTrainCodeFromArrivals, type BoardableCandidateContext } from '../boardingPromptAutoLock';

function arr(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '',
    arrivalMinutes: 0,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

const CTX: BoardableCandidateContext = { line: '2', direction: 'up', nextTargetStationName: null };

describe('pickAutoTrainCodeFromArrivals (#819 arvlCd 우선순위, #2696 술어 단일화)', () => {
  it('빈 배열 → null', () => {
    expect(pickAutoTrainCodeFromArrivals([], CTX)).toBeNull();
  });

  it('priority 1: arvlCd=2 (출발) 단독 → 채택', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 0 }),
      arr({ trainCode: 'B', arrivalCode: 2 }),
      arr({ trainCode: 'C', arrivalCode: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)?.trainCode).toBe('B');
  });

  it('priority 2: arvlCd=1 (도착) — arvlCd=2 없을 때', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 0 }),
      arr({ trainCode: 'B', arrivalCode: ARRIVAL_CODE.ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)?.trainCode).toBe('B');
  });

  it('priority 3: arvlCd=0 (진입) — 2/1 없을 때', () => {
    const list = [arr({ trainCode: 'A', arrivalCode: 0 })];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)?.trainCode).toBe('A');
  });

  // #2696 — 2026-09-16 용마산 evidence: arvlCd=99(운행중, 아직 오지 않은 열차)만 있는데
  // 구 코드는 "priority 4 fallback: 그 외 코드 → 첫 후보"로 7039를 그대로 채택했다(RED).
  // 수정 후에는 isBoardableCandidate 상태 게이트(0/1/2만 통과)가 배제해 null(GREEN).
  it('#2696 (2026-09-16 evidence) — arvlCd=99만 존재(아직 오지 않은 열차) → null (구 arrivals[0] fallback 제거)', () => {
    const list = [
      arr({ trainCode: '7039', arrivalCode: 99 }),
      arr({ trainCode: 'B', arrivalCode: ARRIVAL_CODE.PREV_ARRIVED }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)).toBeNull();
  });

  it('ambiguity: 같은 우선순위 후보 2+ → null', () => {
    const list = [
      arr({ trainCode: 'A', arrivalCode: 2 }),
      arr({ trainCode: 'B', arrivalCode: 2 }),
    ];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)).toBeNull();
  });

  it('trainCode 빈 문자열 단독 → null', () => {
    const list = [arr({ trainCode: '', arrivalCode: 2 })];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)).toBeNull();
  });
});

describe('pickAutoTrainCodeFromArrivals — #2696 공유 술어(isBoardableCandidate) 위임', () => {
  it('direction===null → 항상 null (양방향 병합 금지)', () => {
    const list = [arr({ trainCode: 'A', arrivalCode: 2 })];
    expect(
      pickAutoTrainCodeFromArrivals(list, { line: '2', direction: null, nextTargetStationName: null }),
    ).toBeNull();
  });

  it('노선 불일치 → null', () => {
    const list = [arr({ trainCode: 'A', arrivalCode: 2, line: '9' })];
    expect(pickAutoTrainCodeFromArrivals(list, CTX)).toBeNull();
  });

  // #2696 — 2026-09-17 저녁 evidence: 뚝섬→건대입구 trip에서 성수 arrival의 8387(외선,
  // 종착역=성수)이 후보에 올랐다. 술어 적용 후에는 조기 종착(종착역이 다음 목표역에
  // 도달 못 함)으로 배제되어야 한다.
  it('#2696 (2026-09-17 evidence) — 종착역이 다음 목표역(성수) 이전(=조회 대상 역 자체)이면 배제', () => {
    const list = [
      arr({ trainCode: '8387', arrivalCode: 2, line: '2', terminalStation: '성수' }),
    ];
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(pickAutoTrainCodeFromArrivals(list, ctx)).toBeNull();
  });

  it('#2696 — 종착역이 다음 목표역 이후(정상)이면 후보 유지', () => {
    const list = [
      arr({ trainCode: '9999', arrivalCode: 2, line: '2', terminalStation: '잠실나루' }),
    ];
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'down',
      nextTargetStationName: '건대입구',
    };
    expect(pickAutoTrainCodeFromArrivals(list, ctx)?.trainCode).toBe('9999');
  });

  it('terminalStation 미파싱(undefined) → 조기종착 판정 skip, 정상 채택(그레이스풀)', () => {
    const list = [arr({ trainCode: 'A', arrivalCode: 2 })];
    const ctx: BoardableCandidateContext = {
      line: '2',
      direction: 'up',
      nextTargetStationName: '아무역',
    };
    expect(pickAutoTrainCodeFromArrivals(list, ctx)?.trainCode).toBe('A');
  });
});
