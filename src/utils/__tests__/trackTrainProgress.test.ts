import type { CandidateTrain } from '../pickCandidateTrains';
import type { LineNumber } from '../../types/station';
import { trackTrainProgress, type TrackTrainProgressInput } from '../trackTrainProgress';

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

function pick(
  pairs: Array<[string, string]>,
  opts: Omit<TrackTrainProgressInput, 'candidates'> = {},
) {
  return trackTrainProgress({
    candidates: pairs.map(([trainNo, currentStationName]) =>
      makeCandidate({ trainNo, currentStationName }),
    ),
    ...opts,
  });
}

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
    expect(pick([['A', '없는역']])).toBeNull();
  });

  it('returns null when all multiple candidates fail station resolution', () => {
    expect(pick([['A', '없는역1'], ['B', '없는역2']])).toBeNull();
  });

  it('drops to single when only one of many candidates resolves to a station', () => {
    const result = pick([['A', '없는역'], ['B', '을지로입구']]);
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('single');
  });

  it('picks sticky when lastConfirmedTrainNo matches a resolved candidate', () => {
    const result = pick(
      [['A', '시청'], ['B', '을지로입구']],
      { lastConfirmedTrainNo: 'B', userLocation: NEAR_SICHEONG },
    );
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('sticky');
  });

  it('falls through to GPS when lastConfirmedTrainNo is not in candidates', () => {
    const result = pick(
      [['A', '시청'], ['B', '을지로3가']],
      { lastConfirmedTrainNo: 'Z', userLocation: NEAR_EULJIRO_3GA },
    );
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('falls through to GPS when sticky candidate fails station resolution', () => {
    const result = pick(
      [['A', '시청'], ['STICKY', '없는역'], ['C', '을지로3가']],
      { lastConfirmedTrainNo: 'STICKY', userLocation: NEAR_EULJIRO_3GA },
    );
    expect(result?.trainNo).toBe('C');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('picks closest candidate by haversine when only GPS is available', () => {
    const result = pick(
      [['A', '을지로4가'], ['B', '시청']],
      { userLocation: NEAR_SICHEONG },
    );
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('breaks GPS ties by trainNo ascending (later candidate wins)', () => {
    const result = pick(
      [['Z', '시청'], ['A', '시청']],
      { userLocation: NEAR_SICHEONG },
    );
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('keeps closer candidate when later candidate is farther (or worse tie-break)', () => {
    const result = pick(
      [['A', '시청'], ['B', '을지로4가'], ['Z', '시청']],
      { userLocation: NEAR_SICHEONG },
    );
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('gps-disambiguated');
  });

  it('returns null when multiple candidates remain and no sticky/GPS hint exists', () => {
    expect(pick([['A', '시청'], ['B', '을지로입구']])).toBeNull();
  });

  it('treats userLocation === null the same as undefined', () => {
    expect(
      pick([['A', '시청'], ['B', '을지로입구']], { userLocation: null }),
    ).toBeNull();
  });
});
