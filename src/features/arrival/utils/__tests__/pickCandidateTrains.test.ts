import type { LinePositions, TrainPosition } from '../../../nearest-station/api/positionApi';
import type { LineNumber } from '../../../../shared/types/station';
import { pickCandidateTrains } from '../pickCandidateTrains';

const LINE: LineNumber = '2';

// 노선 2 정렬 순서: 시청, 을지로입구, 을지로3가, 을지로4가, 동대문역사문화공원, 신당, 상왕십리, 왕십리, 한양대, 뚝섬, 성수, 건대입구, 구의, 강변, 잠실나루
function makeTrain(overrides: Partial<TrainPosition>): TrainPosition {
  return {
    statnId: 'X',
    statnNm: '시청',
    trainNo: '0001',
    trainStatus: 1,
    updnLine: 0,
    terminalStationId: 'X',
    terminalStationName: '성수',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_000,
    ...overrides,
  };
}

function makeLine(trains: TrainPosition[], line: LineNumber = LINE): LinePositions {
  return { line, trains };
}

describe('pickCandidateTrains', () => {
  it('returns [] when no positions match the requested line', () => {
    const result = pickCandidateTrains({
      positions: [makeLine([makeTrain({})], '1')],
      line: LINE,
    });
    expect(result).toEqual([]);
  });

  it('returns [] for empty positions', () => {
    expect(pickCandidateTrains({ positions: [], line: LINE })).toEqual([]);
  });

  it('rejects trains with unknown updnLine sentinel (-1 or other non-{0,1})', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'A', updnLine: -1 }),
          makeTrain({ trainNo: 'B', updnLine: 2 }),
          makeTrain({ trainNo: 'OK', updnLine: 0 }),
        ]),
      ],
      line: LINE,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['OK']);
  });

  it('rejects stale trains (receivedAtMs <= 0)', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'A', receivedAtMs: 0 }),
          makeTrain({ trainNo: 'B', receivedAtMs: -1 }),
          makeTrain({ trainNo: 'C', receivedAtMs: 100 }),
        ]),
      ],
      line: LINE,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['C']);
  });

  it('filters by direction when specified', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'UP', updnLine: 0 }),
          makeTrain({ trainNo: 'DN', updnLine: 1 }),
        ]),
      ],
      line: LINE,
      direction: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ trainNo: 'DN', direction: 1 });
  });

  it('passes both directions through when direction is undefined', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'UP', updnLine: 0, statnNm: '시청' }),
          makeTrain({ trainNo: 'DN', updnLine: 1, statnNm: '을지로입구' }),
        ]),
      ],
      line: LINE,
    });
    expect(result.map((t) => `${t.trainNo}:${t.direction}`)).toEqual(['DN:1', 'UP:0']);
  });

  it('keeps only trains within ±windowStations of anchor', () => {
    // anchor=신당(idx 5), window=2 → idx 3..7
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'IN', statnNm: '동대문역사문화공원' }), // idx 4
          makeTrain({ trainNo: 'EDGE', statnNm: '상왕십리' }), // idx 6
          makeTrain({ trainNo: 'OUT', statnNm: '시청' }), // idx 0
        ]),
      ],
      line: LINE,
      anchorStationName: '신당',
      windowStations: 2,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['EDGE', 'IN']);
  });

  it('skips window filter when anchor station is not on the line', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'A', statnNm: '시청' }),
          makeTrain({ trainNo: 'B', statnNm: '강변' }),
        ]),
      ],
      line: LINE,
      anchorStationName: '없는역',
      windowStations: 1,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['A', 'B']);
  });

  it('excludes trains whose statnNm is not on the line', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'GOOD', statnNm: '시청' }),
          makeTrain({ trainNo: 'BAD', statnNm: '없는역' }),
        ]),
      ],
      line: LINE,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['GOOD']);
  });

  it('sorts by |Δindex| from anchor with trainNo tie-break', () => {
    // anchor=왕십리(idx 7)
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: '003', statnNm: '한양대' }), // |Δ|=1
          makeTrain({ trainNo: '001', statnNm: '한양대' }), // |Δ|=1
          makeTrain({ trainNo: '002', statnNm: '왕십리' }), // |Δ|=0
        ]),
      ],
      line: LINE,
      anchorStationName: '왕십리',
      windowStations: 5,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['002', '001', '003']);
  });

  it('sorts by trainNo only when anchor is undefined', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'C', statnNm: '시청' }),
          makeTrain({ trainNo: 'A', statnNm: '강변' }),
          makeTrain({ trainNo: 'B', statnNm: '뚝섬' }),
        ]),
      ],
      line: LINE,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['A', 'B', 'C']);
  });

  it('windowStations: 0 keeps only trains at the anchor station', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'AT', statnNm: '신당' }),
          makeTrain({ trainNo: 'NEXT', statnNm: '상왕십리' }),
        ]),
      ],
      line: LINE,
      anchorStationName: '신당',
      windowStations: 0,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['AT']);
  });

  it('clamps negative windowStations to 0', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'AT', statnNm: '신당' }),
          makeTrain({ trainNo: 'NEAR', statnNm: '상왕십리' }),
        ]),
      ],
      line: LINE,
      anchorStationName: '신당',
      windowStations: -1,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['AT']);
  });

  it('maps fields correctly (trainNo/line/direction/currentStationName/trainStatus/receivedAtMs)', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({
            trainNo: '1234',
            updnLine: 1,
            statnNm: '뚝섬',
            trainStatus: 2,
            receivedAtMs: 9_999,
          }),
        ]),
      ],
      line: LINE,
    });
    expect(result).toEqual([
      {
        trainNo: '1234',
        line: LINE,
        direction: 1,
        currentStationName: '뚝섬',
        trainStatus: 2,
        receivedAtMs: 9_999,
      },
    ]);
  });
});
