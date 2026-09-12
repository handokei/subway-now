import type { LinePositions, TrainPosition } from '../../../../shared/types/position';
import type { LineNumber } from '../../../../shared/types/station';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';
import { pickCandidateTrains, CANDIDATE_DISTANCE_THRESHOLD_KM } from '../pickCandidateTrains';

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
          makeTrain({ trainNo: 'B', statnNm: '강변(동서울터미널)' }),
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
          makeTrain({ trainNo: '002', statnNm: '왕십리(성동구청)' }), // |Δ|=0
        ]),
      ],
      line: LINE,
      anchorStationName: '왕십리(성동구청)',
      windowStations: 5,
    });
    expect(result.map((t) => t.trainNo)).toEqual(['002', '001', '003']);
  });

  it('sorts by trainNo only when anchor is undefined', () => {
    const result = pickCandidateTrains({
      positions: [
        makeLine([
          makeTrain({ trainNo: 'C', statnNm: '시청' }),
          makeTrain({ trainNo: 'A', statnNm: '강변(동서울터미널)' }),
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

  // #1616 (R12-a) — candidate별 GPS 거리 hard gate.
  // helper: 시청 좌표 근처 + 강변 좌표 trains 동시 운영해 거리 기반 reject 검증.
  describe('candidate distance hard gate (R12-a)', () => {
    // 시청 좌표 (37.563588, 126.975411), 강변(동서울터미널) 좌표 (37.535095, 127.094681)
    // 두 역 사이 직선거리 약 11.2km — threshold 3km 보다 크므로 reject 대상.
    const SICHEONG = { lat: 37.5636, lng: 126.9754 };
    function makeCoords(): Map<string, { lat: number; lng: number }> {
      return new Map([
        ['시청', { lat: 37.563588, lng: 126.975411 }],
        ['을지로입구', { lat: 37.566014, lng: 126.982618 }],
        // 강변 — 시청으로부터 약 11.2km (>3km threshold)
        ['강변(동서울터미널)', { lat: 37.535095, lng: 127.094681 }],
      ]);
    }

    function runDistanceGate(
      trains: Array<{ trainNo: string; statnNm: string }>,
      opts: {
        userLocation?: { lat: number; lng: number } | null;
        stationCoordinates?: Map<string, { lat: number; lng: number }> | undefined;
        onReject?: jest.Mock;
      },
    ): ReturnType<typeof pickCandidateTrains> {
      return pickCandidateTrains({
        positions: [makeLine(trains.map((t) => makeTrain(t)))],
        line: LINE,
        userLocation: opts.userLocation,
        stationCoordinates: opts.stationCoordinates,
        onCandidateDistanceReject: opts.onReject,
      });
    }

    it.each<{
      label: string;
      userLocation: { lat: number; lng: number } | null | undefined;
      stationCoordinates: Map<string, { lat: number; lng: number }> | undefined;
    }>([
      { label: 'userLocation null → graceful (gate skip)', userLocation: null, stationCoordinates: makeCoords() },
      { label: 'userLocation undefined → graceful (gate skip)', userLocation: undefined, stationCoordinates: makeCoords() },
      { label: 'stationCoordinates undefined → graceful (gate skip)', userLocation: SICHEONG, stationCoordinates: undefined },
    ])('$label — far candidate not rejected', ({ userLocation, stationCoordinates }) => {
      const onReject = jest.fn();
      const result = runDistanceGate(
        [{ trainNo: 'NEAR', statnNm: '시청' }, { trainNo: 'FAR', statnNm: '강변(동서울터미널)' }],
        { userLocation, stationCoordinates, onReject },
      );
      expect(result.map((t) => t.trainNo).sort((a, b) => a.localeCompare(b))).toEqual(['FAR', 'NEAR']);
      expect(onReject).not.toHaveBeenCalled();
    });

    it('rejects candidates whose station distance > threshold (R12-a)', () => {
      const onReject = jest.fn();
      const result = runDistanceGate(
        [{ trainNo: 'NEAR', statnNm: '시청' }, { trainNo: 'FAR', statnNm: '강변(동서울터미널)' }],
        { userLocation: SICHEONG, stationCoordinates: makeCoords(), onReject },
      );
      expect(result.map((t) => t.trainNo)).toEqual(['NEAR']);
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onReject).toHaveBeenCalledWith({
        trainNo: 'FAR',
        line: LINE,
        stationName: '강변(동서울터미널)',
        distanceKm: expect.any(Number),
      });
      const callDistanceKm = onReject.mock.calls[0][0].distanceKm as number;
      expect(callDistanceKm).toBeGreaterThan(CANDIDATE_DISTANCE_THRESHOLD_KM);
    });

    it('keeps candidates whose station distance ≤ threshold (R12-a)', () => {
      const onReject = jest.fn();
      const result = runDistanceGate(
        [{ trainNo: 'A', statnNm: '시청' }, { trainNo: 'B', statnNm: '을지로입구' }],
        { userLocation: SICHEONG, stationCoordinates: makeCoords(), onReject },
      );
      expect(result.map((t) => t.trainNo).sort((a, b) => a.localeCompare(b))).toEqual(['A', 'B']);
      expect(onReject).not.toHaveBeenCalled();
    });

    it('graceful pass when stationCoordinates missing key — no reject, no throw', () => {
      // coords map에 statnNm이 없는 경우(노선 데이터 부분 lookup)는 거리 검사 생략.
      const partialCoords = new Map([
        ['시청', { lat: 37.563588, lng: 126.975411 }],
      ]);
      const onReject = jest.fn();
      const result = runDistanceGate(
        [{ trainNo: 'NEAR', statnNm: '시청' }, { trainNo: 'UNKNOWN', statnNm: '강변(동서울터미널)' }],
        { userLocation: SICHEONG, stationCoordinates: partialCoords, onReject },
      );
      expect(result.map((t) => t.trainNo).sort((a, b) => a.localeCompare(b))).toEqual(['NEAR', 'UNKNOWN']);
      expect(onReject).not.toHaveBeenCalled();
    });

    it('reject works when onCandidateDistanceReject is undefined — no throw, candidate still removed', () => {
      const result = pickCandidateTrains({
        positions: [makeLine([
          makeTrain({ trainNo: 'NEAR', statnNm: '시청' }),
          makeTrain({ trainNo: 'FAR', statnNm: '강변(동서울터미널)' }),
        ])],
        line: LINE,
        userLocation: SICHEONG,
        stationCoordinates: makeCoords(),
        // onCandidateDistanceReject omitted
      });
      expect(result.map((t) => t.trainNo)).toEqual(['NEAR']);
    });

    it('rejects candidate exceeding threshold even when anchor window kept it', () => {
      // anchor=시청(idx 0), windowStations=15 → 강변(idx 14)도 index window 통과.
      // 그러나 GPS 거리 11.2km > 3km → distance gate가 reject.
      const onReject = jest.fn();
      const result = pickCandidateTrains({
        positions: [makeLine([
          makeTrain({ trainNo: 'NEAR', statnNm: '시청' }),
          makeTrain({ trainNo: 'FAR', statnNm: '강변(동서울터미널)' }),
        ])],
        line: LINE,
        anchorStationName: '시청',
        windowStations: 15,
        userLocation: SICHEONG,
        stationCoordinates: makeCoords(),
        onCandidateDistanceReject: onReject,
      });
      expect(result.map((t) => t.trainNo)).toEqual(['NEAR']);
      expect(onReject).toHaveBeenCalledTimes(1);
    });
  });

  describe('2호선 본선 wraparound (#1722)', () => {
    // 본선 closed loop: 시청(2-001, idx 0) ↔ 충정로(2-043) 인접.
    // 직선 Math.abs로는 시청 → 합정(2-038) 거리가 37이라 window=10이면 reject.
    // wraparound aware로는 6 hop (시청→충정로→...→합정)이라 keep.
    const LINE2: LineNumber = '2';
    const line2 = getStationsOnLine(LINE2);
    const sicheongName = line2.find((s) => s.id === '2-001')!.name;
    const hapjeongName = line2.find((s) => s.id === '2-038')!.name;

    it('keeps wraparound-near train within window (직선 Math.abs로는 reject)', () => {
      const result = pickCandidateTrains({
        positions: [
          {
            line: LINE2,
            trains: [makeTrain({ trainNo: 'WRAP', statnNm: hapjeongName })],
          },
        ],
        line: LINE2,
        anchorStationName: sicheongName,
        windowStations: 10,
      });
      expect(result.map((t) => t.trainNo)).toEqual(['WRAP']);
    });

    it('rejects train beyond wraparound-aware window', () => {
      // 시청 idx 0, 사당(2-026) idx 25 — wraparound도 18 hop. window=10이면 양쪽 다 X.
      const sadangName = line2.find((s) => s.id === '2-026')!.name;
      const result = pickCandidateTrains({
        positions: [
          {
            line: LINE2,
            trains: [makeTrain({ trainNo: 'FAR', statnNm: sadangName })],
          },
        ],
        line: LINE2,
        anchorStationName: sicheongName,
        windowStations: 10,
      });
      expect(result).toEqual([]);
    });

    it('sortKey uses wraparound-aware hops, not |Δidx|', () => {
      // anchor=시청. 합정(wraparound 6 hop)이 을지로입구(직선 1 hop)보다 멀어야 정상.
      const euljiroName = line2.find((s) => s.id === '2-002')!.name;
      const result = pickCandidateTrains({
        positions: [
          {
            line: LINE2,
            trains: [
              makeTrain({ trainNo: 'WRAP', statnNm: hapjeongName }),
              makeTrain({ trainNo: 'NEAR', statnNm: euljiroName }),
            ],
          },
        ],
        line: LINE2,
        anchorStationName: sicheongName,
        windowStations: 10,
      });
      expect(result.map((t) => t.trainNo)).toEqual(['NEAR', 'WRAP']);
    });
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
