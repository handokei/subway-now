import type { CandidateTrain } from '../pickCandidateTrains';
import type { LineNumber } from '../../types/station';
import { trackTrainProgress } from '../trackTrainProgress';

const LINE: LineNumber = '2';

function makeCandidate(overrides: Partial<CandidateTrain>): CandidateTrain {
  return {
    trainNo: '0001',
    line: LINE,
    direction: 0,
    currentStationName: '시청',
    trainStatus: 1,
    receivedAtMs: 1_000,
    ...overrides,
  };
}

// 시청(37.563588, 126.975411), 을지로입구(37.566014, 126.982618),
// 을지로3가(37.566306, 126.991696), 을지로4가(37.566595, 126.997817)
const NEAR_SICHEONG = { lat: 37.5636, lng: 126.9754 };
const NEAR_EULJIRO_3GA = { lat: 37.5663, lng: 126.9917 };

describe('trackTrainProgress', () => {
  it('returns null for empty candidates', () => {
    expect(trackTrainProgress({ candidates: [] })).toBeNull();
  });

  it('returns single confidence when exactly one candidate maps to a station', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청', trainStatus: 2 })],
    });
    expect(result).toEqual({
      trainNo: 'A',
      currentStation: expect.objectContaining({ name: '시청', line: '2' }),
      trainStatus: 2,
      confidence: 'single',
    });
  });

  it('returns null when single candidate station name is not on the line', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ currentStationName: '없는역' })],
    });
    expect(result).toBeNull();
  });

  it('returns null when all multiple candidates fail station resolution', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '없는역1' }),
        makeCandidate({ trainNo: 'B', currentStationName: '없는역2' }),
      ],
    });
    expect(result).toBeNull();
  });

  it('drops to single when only one of many candidates resolves to a station', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '없는역' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로입구' }),
      ],
    });
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('single');
  });

  it('picks sticky when lastConfirmedTrainNo matches a resolved candidate', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로입구' }),
      ],
      lastConfirmedTrainNo: 'B',
      userLocation: NEAR_SICHEONG,
    });
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('sticky');
  });

  it('falls through to GPS when lastConfirmedTrainNo is not in candidates', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로3가' }),
      ],
      lastConfirmedTrainNo: 'Z',
      userLocation: NEAR_EULJIRO_3GA,
    });
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('falls through to GPS when sticky candidate fails station resolution', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'STICKY', currentStationName: '없는역' }),
        makeCandidate({ trainNo: 'C', currentStationName: '을지로3가' }),
      ],
      lastConfirmedTrainNo: 'STICKY',
      userLocation: NEAR_EULJIRO_3GA,
    });
    expect(result?.trainNo).toBe('C');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('picks closest candidate by haversine when only GPS is available', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '을지로4가' }),
        makeCandidate({ trainNo: 'B', currentStationName: '시청' }),
      ],
      userLocation: NEAR_SICHEONG,
    });
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('breaks GPS ties by trainNo ascending (later candidate wins)', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'Z', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
      ],
      userLocation: NEAR_SICHEONG,
    });
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('keeps closer candidate when later candidate is farther (or worse tie-break)', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로4가' }),
        makeCandidate({ trainNo: 'Z', currentStationName: '시청' }),
      ],
      userLocation: NEAR_SICHEONG,
    });
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('returns null when multiple candidates remain and no sticky/GPS hint exists', () => {
    expect(
      trackTrainProgress({
        candidates: [
          makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
          makeCandidate({ trainNo: 'B', currentStationName: '을지로입구' }),
        ],
      }),
    ).toBeNull();
  });

  it('treats userLocation === null the same as undefined', () => {
    expect(
      trackTrainProgress({
        candidates: [
          makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
          makeCandidate({ trainNo: 'B', currentStationName: '을지로입구' }),
        ],
        userLocation: null,
      }),
    ).toBeNull();
  });
});
