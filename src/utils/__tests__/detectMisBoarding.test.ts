import { detectMisBoarding } from '../detectMisBoarding';
import type { BoardingLock } from '../../types/boardingLock';
import type { LinePositions, TrainPosition } from '../../api/positionApi';

const lock: BoardingLock = {
  destinationId: 'd',
  trainCode: 'T-LOCK',
  boardingStationId: 's',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 1_800_000,
};

function train(overrides: Partial<TrainPosition>): TrainPosition {
  return {
    statnId: '',
    statnNm: '',
    trainNo: 'T-X',
    trainStatus: 0,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function positions(overrides: Partial<LinePositions>): LinePositions {
  return { line: '2', trains: [], ...overrides };
}

describe('detectMisBoarding', () => {
  it('lock=null → no-signal', () => {
    expect(detectMisBoarding(null, positions({}))).toBe('no-signal');
  });

  it('positions=null → no-signal', () => {
    expect(detectMisBoarding(lock, null)).toBe('no-signal');
  });

  it('positions.isMock=true → no-signal (실측 아님)', () => {
    expect(detectMisBoarding(lock, positions({ isMock: true }))).toBe('no-signal');
  });

  it('positions.line이 lock.boardingLine과 다르면 no-signal', () => {
    expect(detectMisBoarding(lock, positions({ line: '3' }))).toBe('no-signal');
  });

  it('positions에 trainNo=lock.trainCode 존재 → present', () => {
    expect(
      detectMisBoarding(lock, positions({ trains: [train({ trainNo: 'T-LOCK' })] })),
    ).toBe('present');
  });

  it('positions에 trainNo 부재 → absent', () => {
    expect(
      detectMisBoarding(lock, positions({ trains: [train({ trainNo: 'T-OTHER' })] })),
    ).toBe('absent');
  });

  it('positions에 trains 빈 배열 → absent (관측은 됐지만 lock train 없음)', () => {
    expect(detectMisBoarding(lock, positions({ trains: [] }))).toBe('absent');
  });
});
