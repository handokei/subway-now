import { findTrainCoordinates, buildStationIndex } from '../findTrainCoordinates';
import type { LinePositions, TrainPosition } from '../../api/positionApi';
import {
  TRAIN_MARKER_OFFSET_DEG,
  UPDN_DOWN_OUTER,
  UPDN_UP_INNER,
} from '../../constants/trainMarkerOffset';
import type { Station } from '../../types/station';

const NOW = 1_700_000_000_000;

const stations: Station[] = [
  { id: 'A', name: '강남', line: '2', lineColor: '#33A23D', lat: 37.498, lng: 127.028 },
  { id: 'B', name: '역삼', line: '2', lineColor: '#33A23D', lat: 37.500, lng: 127.036 },
  { id: 'C', name: '충무로', line: '3', lineColor: '#EF7C1C', lat: 37.561, lng: 126.994 },
];

function train(statnNm: string, status: number, overrides?: Partial<TrainPosition>): TrainPosition {
  return {
    statnId: '',
    statnNm,
    trainNo: 'T1',
    trainStatus: status,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: NOW,
    ...overrides,
  };
}

describe('findTrainCoordinates', () => {
  it('빈 입력 → 빈 배열', () => {
    expect(findTrainCoordinates([], buildStationIndex(stations))).toEqual([]);
    expect(findTrainCoordinates([null], buildStationIndex(stations))).toEqual([]);
  });

  it('LinePositions의 train을 (line, statnNm) 매칭으로 좌표 부여 (상행 → 서쪽 오프셋)', () => {
    const lp: LinePositions = { line: '2', trains: [train('강남', 1, { trainNo: 'X' })] };
    const result = findTrainCoordinates([lp], buildStationIndex(stations));
    expect(result).toHaveLength(1);
    expect(result[0].lat).toBe(37.498);
    expect(result[0].lng).toBeCloseTo(127.028 - TRAIN_MARKER_OFFSET_DEG, 10);
    expect(result[0].lineColor).toBe('#33A23D');
    expect(result[0].trainNo).toBe('X');
    expect(result[0].trainStatus).toBe(1);
  });

  it('같은 역에 상행+하행 동시 매칭 → 경도 오프셋으로 좌우 분리', () => {
    const lp: LinePositions = {
      line: '2',
      trains: [
        train('강남', 1, { trainNo: 'UP', updnLine: UPDN_UP_INNER }),
        train('강남', 1, { trainNo: 'DOWN', updnLine: UPDN_DOWN_OUTER }),
      ],
    };
    const result = findTrainCoordinates([lp], buildStationIndex(stations));
    const up = result.find((t) => t.trainNo === 'UP')!;
    const down = result.find((t) => t.trainNo === 'DOWN')!;
    expect(up.lat).toBe(37.498);
    expect(down.lat).toBe(37.498);
    expect(up.lng).toBeCloseTo(127.028 - TRAIN_MARKER_OFFSET_DEG, 10);
    expect(down.lng).toBeCloseTo(127.028 + TRAIN_MARKER_OFFSET_DEG, 10);
    expect(down.lng - up.lng).toBeCloseTo(2 * TRAIN_MARKER_OFFSET_DEG, 10);
  });

  it('updnLine이 매핑에 없는 값(예: 2) → 오프셋 0', () => {
    const lp: LinePositions = { line: '2', trains: [train('강남', 1, { updnLine: 2 })] };
    const result = findTrainCoordinates([lp], buildStationIndex(stations));
    expect(result[0].lat).toBe(37.498);
    expect(result[0].lng).toBe(127.028);
  });

  it('mock LinePositions는 통째로 무시', () => {
    const lp: LinePositions = { line: '2', trains: [train('강남', 1)], isMock: true };
    expect(findTrainCoordinates([lp], buildStationIndex(stations))).toEqual([]);
  });

  it('stale(receivedAtMs<=0) 트레인 제외', () => {
    const lp: LinePositions = {
      line: '2',
      trains: [train('강남', 1, { receivedAtMs: 0 }), train('역삼', 1)],
    };
    const result = findTrainCoordinates([lp], buildStationIndex(stations));
    expect(result.map((t) => t.statnNm)).toEqual(['역삼']);
  });

  it('역명 매칭 실패(unknown) 트레인 제외', () => {
    const lp: LinePositions = {
      line: '2',
      trains: [train('강남', 1), train('없는역', 1)],
    };
    const result = findTrainCoordinates([lp], buildStationIndex(stations));
    expect(result).toHaveLength(1);
    expect(result[0].statnNm).toBe('강남');
  });

  it('호선 인덱스에 없는 LinePositions 제외 (안전장치)', () => {
    const lp: LinePositions = { line: 'airport', trains: [train('강남', 1)] };
    expect(findTrainCoordinates([lp], buildStationIndex(stations))).toEqual([]);
  });

  it('동일 line+name 중복 station은 첫 번째만 인덱싱 (변형 안정성)', () => {
    const dup = [
      ...stations,
      { id: 'A2', name: '강남', line: '2' as const, lineColor: '#33A23D', lat: 0, lng: 0 },
    ];
    const lp: LinePositions = { line: '2', trains: [train('강남', 1)] };
    const result = findTrainCoordinates([lp], buildStationIndex(dup));
    expect(result[0].lat).toBe(37.498); // 첫 번째 stations[0] 우선
  });

  it('여러 호선 동시 처리', () => {
    const lps: LinePositions[] = [
      { line: '2', trains: [train('강남', 1)] },
      { line: '3', trains: [train('충무로', 0)] },
    ];
    const result = findTrainCoordinates(lps, buildStationIndex(stations));
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.statnNm).sort((a, b) => a.localeCompare(b))).toEqual(['강남', '충무로']);
  });
});
