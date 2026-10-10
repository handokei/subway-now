import { surfaceSSOTConsensus } from '../surfaceSSotConsensus';
import { MOCK_STATIONS, makeArrivalInfo, makeNearestResult } from '../../../../testUtils/fixtures';
import type { StationArrival } from '../../../../shared/types/arrival';

function makeArrival(rows: ReturnType<typeof makeArrivalInfo>[]): StationArrival {
  return { up: rows, down: [], source: 'realtime' };
}

describe('surfaceSSOTConsensus', () => {
  const gpsResult = makeNearestResult('gangnam', 0.05);

  it('GPS 신선 + Arrival arvlCd=1(도착) 합의 시 SSOT 반환', () => {
    const arrival = makeArrival([
      makeArrivalInfo({
        destination: '교대',
        arrivalSeconds: 0,
        trainCode: '2001',
        line: '2',
        arrivalCode: 1,
      }),
    ]);
    const result = surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 14, arrival });
    expect(result).toEqual({ station: gpsResult.station, trainCode: '2001' });
  });

  it.each([2, 3, 5])('arvlCd=%i(정착 코드)에서 합의', (arvlCd) => {
    const arrival = makeArrival([
      makeArrivalInfo({
        destination: '교대',
        arrivalSeconds: 0,
        trainCode: '2002',
        line: '2',
        arrivalCode: arvlCd,
      }),
    ]);
    const result = surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 10, arrival });
    expect(result?.trainCode).toBe('2002');
  });

  it.each([0, 4, 99, -1])('arvlCd=%i(비정착)는 합의 미성립', (arvlCd) => {
    const arrival = makeArrival([
      makeArrivalInfo({
        destination: '교대',
        arrivalSeconds: 0,
        line: '2',
        arrivalCode: arvlCd,
      }),
    ]);
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 10, arrival })).toBeNull();
  });

  it('gpsResult null이면 합의 미성립', () => {
    const arrival = makeArrival([makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1 })]);
    expect(surfaceSSOTConsensus({ gpsResult: null, gpsAccuracy: 10, arrival })).toBeNull();
  });

  it('gpsAccuracy null이면 합의 미성립', () => {
    const arrival = makeArrival([makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1 })]);
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: null, arrival })).toBeNull();
  });

  it('gpsAccuracy > 30m면 합의 미성립 (지하 fallback 가능성)', () => {
    const arrival = makeArrival([makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1 })]);
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 50, arrival })).toBeNull();
  });

  it('arrival null이면 합의 미성립', () => {
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 10, arrival: null })).toBeNull();
  });

  it('arrival row의 line이 gpsResult.line과 다르면 합의 미성립 (환승역)', () => {
    const arrival = makeArrival([
      makeArrivalInfo({
        destination: '',
        arrivalSeconds: 0,
        line: '3',
        arrivalCode: 1,
      }),
    ]);
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 10, arrival })).toBeNull();
  });

  it('down 슬롯의 arrival도 합의 인식', () => {
    const arrival: StationArrival = {
      up: [],
      down: [
        makeArrivalInfo({
          destination: '',
          arrivalSeconds: 0,
          trainCode: '2003',
          line: '2',
          arrivalCode: 2,
        }),
      ],
      source: 'realtime',
    };
    const result = surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 10, arrival });
    expect(result?.trainCode).toBe('2003');
  });

  it('gpsAccuracy 경계값 30m는 통과', () => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1, trainCode: 'X' }),
    ]);
    expect(surfaceSSOTConsensus({ gpsResult, gpsAccuracy: 30, arrival })?.trainCode).toBe('X');
  });
});
