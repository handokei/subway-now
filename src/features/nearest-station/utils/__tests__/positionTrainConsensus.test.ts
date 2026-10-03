import {
  checkStationProgression,
  requiresPositionTrainConsensus,
  type PositionTrainConsensusSignals,
} from '../positionTrainConsensus';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { NearestStationResult, Station } from '../../../../shared/types/station';

function makeStation(id: string): Station {
  return { id, name: id, line: '2', lineColor: '#000', lat: 37.5, lng: 127.0 };
}

function makeResult(id: string): NearestStationResult {
  return { station: makeStation(id), distanceKm: 0.05 };
}

function makeLock(): BoardingLock {
  return {
    destinationId: 'dest',
    trainCode: '2001',
    boardingStationId: 'A',
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 30 * 60_000,
  };
}

const BASE_SIGNALS: PositionTrainConsensusSignals = {
  barometerSubsurface: false,
  accelerometerPattern: 'automotive',
  cellularEnvironmentVote: 'surface',
};

describe('requiresPositionTrainConsensus', () => {
  describe('boardingLock active (사용자 명시 의향)', () => {
    it('lock active + 모든 신호 미달이어도 true (기존 path 보존)', () => {
      const lock = makeLock();
      const signals: PositionTrainConsensusSignals = {
        barometerSubsurface: true,
        accelerometerPattern: 'walking',
        cellularEnvironmentVote: 'underground',
      };
      expect(requiresPositionTrainConsensus(signals, lock)).toBe(true);
    });

    it('lock active + 모든 신호 null이어도 true', () => {
      const lock = makeLock();
      const signals: PositionTrainConsensusSignals = {
        barometerSubsurface: null,
        accelerometerPattern: null,
        cellularEnvironmentVote: null,
      };
      expect(requiresPositionTrainConsensus(signals, lock)).toBe(true);
    });
  });

  describe('lockless 4-signal consensus', () => {
    it('지하(barometerSubsurface=true) → reject (GPS dead zone)', () => {
      const signals: PositionTrainConsensusSignals = {
        ...BASE_SIGNALS,
        barometerSubsurface: true,
      };
      expect(requiresPositionTrainConsensus(signals, null)).toBe(false);
    });

    it.each(['walking', 'stationary', 'unknown'] as const)(
      'accelerometerPattern=%s (non-automotive) → reject',
      (pattern) => {
        const signals: PositionTrainConsensusSignals = {
          ...BASE_SIGNALS,
          accelerometerPattern: pattern,
        };
        expect(requiresPositionTrainConsensus(signals, null)).toBe(false);
      },
    );

    it('accelerometerPattern=null → reject', () => {
      const signals: PositionTrainConsensusSignals = {
        ...BASE_SIGNALS,
        accelerometerPattern: null,
      };
      expect(requiresPositionTrainConsensus(signals, null)).toBe(false);
    });

    it('automotive + barometer false + cellular surface → accept', () => {
      expect(requiresPositionTrainConsensus(BASE_SIGNALS, null)).toBe(true);
    });

    it.each(['surface-weak', 'underground', 'unknown'] as const)(
      'cellularEnvironmentVote=%s (non-surface) → reject',
      (vote) => {
        const signals: PositionTrainConsensusSignals = {
          ...BASE_SIGNALS,
          cellularEnvironmentVote: vote,
        };
        expect(requiresPositionTrainConsensus(signals, null)).toBe(false);
      },
    );

    it('cellularEnvironmentVote=null → reject', () => {
      const signals: PositionTrainConsensusSignals = {
        ...BASE_SIGNALS,
        cellularEnvironmentVote: null,
      };
      expect(requiresPositionTrainConsensus(signals, null)).toBe(false);
    });

    it('barometerSubsurface=undefined (warmup) + 다른 신호 통과 → accept', () => {
      const signals: PositionTrainConsensusSignals = {
        ...BASE_SIGNALS,
        barometerSubsurface: undefined,
      };
      expect(requiresPositionTrainConsensus(signals, null)).toBe(true);
    });

    it('barometerSubsurface=null + 다른 신호 통과 → accept', () => {
      const signals: PositionTrainConsensusSignals = {
        ...BASE_SIGNALS,
        barometerSubsurface: null,
      };
      expect(requiresPositionTrainConsensus(signals, null)).toBe(true);
    });
  });
});

describe('checkStationProgression', () => {
  const arc: Station[] = [
    makeStation('S0'),
    makeStation('S1'),
    makeStation('S2'),
    makeStation('S3'),
    makeStation('S4'),
  ];

  it('prevCascadeResult=null → true (첫 cycle 면제)', () => {
    expect(checkStationProgression('S2', null, arc)).toBe(true);
  });

  it('같은 station (0 hop) → true', () => {
    expect(checkStationProgression('S2', makeResult('S2'), arc)).toBe(true);
  });

  it('+1 hop → true', () => {
    expect(checkStationProgression('S2', makeResult('S1'), arc)).toBe(true);
  });

  it('-1 hop → true (backward 정상 case)', () => {
    expect(checkStationProgression('S1', makeResult('S2'), arc)).toBe(true);
  });

  it('+2 hop jump → false', () => {
    expect(checkStationProgression('S3', makeResult('S1'), arc)).toBe(false);
  });

  it('-2 hop jump → false', () => {
    expect(checkStationProgression('S1', makeResult('S3'), arc)).toBe(false);
  });

  it('prev station이 arc 밖 → true (cross-line 면제)', () => {
    expect(checkStationProgression('S2', makeResult('OTHER'), arc)).toBe(true);
  });

  it('candidate station이 arc 밖 → true (cross-line 면제)', () => {
    expect(checkStationProgression('OTHER', makeResult('S2'), arc)).toBe(true);
  });

  it('arc 빈 배열 → true', () => {
    expect(checkStationProgression('S2', makeResult('S1'), [])).toBe(true);
  });
});
