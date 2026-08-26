import { buildCandidateTrainsFromArrival } from '../buildCandidateTrainsFromArrival';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

function makeArrivalInfo(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
  return {
    destination: '강남행',
    arrivalMinutes: 1,
    arrivalSeconds: 60,
    statusMessage: '',
    trainCode: 'T1',
    line: '2',
    receivedAtMs: 1000,
    arrivalCode: 1, // ARRIVED
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('buildCandidateTrainsFromArrival', () => {
  it('trainCode가 일치하는 up row를 direction 0 CandidateTrain으로 변환한다', () => {
    const arrival: StationArrival = { up: [makeArrivalInfo()], down: [] };

    const result = buildCandidateTrainsFromArrival(arrival, '다음역', 'T1');

    expect(result).toEqual([
      {
        trainNo: 'T1',
        line: '2',
        direction: 0,
        currentStationName: '다음역',
        trainStatus: 1,
        receivedAtMs: 1000,
      },
    ]);
  });

  it('trainCode가 일치하는 down row를 direction 1 CandidateTrain으로 변환한다', () => {
    const arrival: StationArrival = { up: [], down: [makeArrivalInfo({ trainCode: 'T2' })] };

    const result = buildCandidateTrainsFromArrival(arrival, '다음역', 'T2');

    expect(result).toEqual([
      expect.objectContaining({ trainNo: 'T2', direction: 1 }),
    ]);
  });

  it('trainCode가 일치하지 않는 row는 제외한다', () => {
    const arrival: StationArrival = { up: [makeArrivalInfo({ trainCode: 'OTHER' })], down: [] };

    expect(buildCandidateTrainsFromArrival(arrival, '다음역', 'T1')).toEqual([]);
  });

  it('arrivalCode가 "현재 위치 신호로 부적합"(우선순위 0)이면 제외한다 — 예: 99(운행중)', () => {
    const arrival: StationArrival = { up: [makeArrivalInfo({ arrivalCode: 99 })], down: [] };

    expect(buildCandidateTrainsFromArrival(arrival, '다음역', 'T1')).toEqual([]);
  });

  it('arrivalCode가 2(출발)이면 제외한다', () => {
    const arrival: StationArrival = { up: [makeArrivalInfo({ arrivalCode: 2 })], down: [] };

    expect(buildCandidateTrainsFromArrival(arrival, '다음역', 'T1')).toEqual([]);
  });

  it('up/down 둘 다에 매칭 row가 있으면 둘 다 반환한다', () => {
    const arrival: StationArrival = {
      up: [makeArrivalInfo({ trainCode: 'T1' })],
      down: [makeArrivalInfo({ trainCode: 'T1' })],
    };

    expect(buildCandidateTrainsFromArrival(arrival, '다음역', 'T1')).toHaveLength(2);
  });
});
