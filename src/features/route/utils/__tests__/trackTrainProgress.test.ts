import type { CandidateTrain } from '../../../../shared/types/position';
import type { LineNumber, Station } from '../../../../shared/types/station';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
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

  it.each<{
    name: string;
    pairs: Array<[string, string]>;
    opts: Omit<TrackTrainProgressInput, 'candidates'>;
    expected: string;
  }>([
    {
      name: 'lastConfirmedTrainNo not in candidates → GPS',
      pairs: [['A', '시청'], ['B', '을지로3가']],
      opts: { lastConfirmedTrainNo: 'Z', userLocation: NEAR_EULJIRO_3GA },
      expected: 'B',
    },
    {
      name: 'sticky candidate fails station resolution → GPS',
      pairs: [['A', '시청'], ['STICKY', '없는역'], ['C', '을지로3가']],
      opts: { lastConfirmedTrainNo: 'STICKY', userLocation: NEAR_EULJIRO_3GA },
      expected: 'C',
    },
    {
      name: 'picks closest by haversine',
      pairs: [['A', '을지로4가'], ['B', '시청']],
      opts: { userLocation: NEAR_SICHEONG },
      expected: 'B',
    },
    {
      name: 'tie-break by trainNo ascending (later wins)',
      pairs: [['Z', '시청'], ['A', '시청']],
      opts: { userLocation: NEAR_SICHEONG },
      expected: 'A',
    },
    {
      name: 'keeps closer when later is farther (or worse tie-break)',
      pairs: [['A', '시청'], ['B', '을지로4가'], ['Z', '시청']],
      opts: { userLocation: NEAR_SICHEONG },
      expected: 'A',
    },
  ])('gps-disambiguated: $name', ({ pairs, opts, expected }) => {
    const result = pick(pairs, opts);
    expect(result?.trainNo).toBe(expected);
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

// 2호선 순방향 segment: 시청(2-001) → 을지로입구(2-002) → 을지로3가(2-003) → 을지로4가(2-004)
function stationOf(name: string): Station {
  const s = findStationByNameAndLine(name, LINE);
  if (!s) throw new Error(`test fixture: station not found: ${name}`);
  return s;
}

const SEGMENT_2_3 = [
  stationOf('시청'),
  stationOf('을지로입구'),
  stationOf('을지로3가'),
  stationOf('을지로4가'),
];

describe('trackTrainProgress — forward-only guard (#1017)', () => {
  it('does not filter when segmentStations is omitted', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
    });
    expect(result?.trainNo).toBe('A');
  });

  it('keeps candidate at boarding station (boardingIdx === stationIdx)', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('시청').id,
    });
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('single');
  });

  it('keeps candidate ahead of boarding station', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '을지로3가' })],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('시청').id,
    });
    expect(result?.trainNo).toBe('A');
  });

  it('drops backward candidate (RC4 차단): single candidate before boardingIdx — fallback to resolved', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('을지로3가').id,
    });
    expect(result).not.toBeNull();
  });

  it('drops backward candidate when multiple candidates exist — backward excluded from disambiguation', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로4가' }),
      ],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('을지로3가').id,
      userLocation: NEAR_SICHEONG,
    });
    expect(result?.trainNo).toBe('B');
    expect(result?.confidence).toBe('single');
  });

  it('fallback to all resolved when ALL candidates are backward (no forward survivor)', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '시청' }),
        makeCandidate({ trainNo: 'B', currentStationName: '을지로입구' }),
      ],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('을지로3가').id,
      userLocation: NEAR_SICHEONG,
    });
    expect(result).not.toBeNull();
  });

  it('does not filter when boardingStationId is absent', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
      segmentStations: SEGMENT_2_3,
    });
    expect(result?.trainNo).toBe('A');
  });

  it('does not filter when segmentStations is empty', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
      segmentStations: [],
      boardingStationId: stationOf('을지로3가').id,
    });
    expect(result?.trainNo).toBe('A');
  });

  it('does not filter when boardingStationId is not found in segmentStations', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', currentStationName: '시청' })],
      segmentStations: SEGMENT_2_3,
      boardingStationId: 'nonexistent-id',
    });
    expect(result?.trainNo).toBe('A');
  });

  it('passes through candidate whose station is outside segmentStations (idx === -1)', () => {
    const result = trackTrainProgress({
      candidates: [makeCandidate({ trainNo: 'A', line: '2', currentStationName: '시청' })],
      segmentStations: [stationOf('을지로3가'), stationOf('을지로4가')],
      boardingStationId: stationOf('을지로3가').id,
    });
    expect(result?.trainNo).toBe('A');
  });

  it('backward sticky candidate is excluded from filtered — fallthrough to GPS', () => {
    const result = trackTrainProgress({
      candidates: [
        makeCandidate({ trainNo: 'A', currentStationName: '을지로3가' }),
        makeCandidate({ trainNo: 'STICKY', currentStationName: '시청' }),
      ],
      segmentStations: SEGMENT_2_3,
      boardingStationId: stationOf('을지로3가').id,
      lastConfirmedTrainNo: 'STICKY',
      userLocation: NEAR_EULJIRO_3GA,
    });
    expect(result?.trainNo).toBe('A');
    expect(result?.confidence).toBe('single');
  });
});
