import { undergroundSSOTConsensus } from '../undergroundSSotConsensus';
import { MOCK_STATIONS, makeArrivalInfo, makeNearestResult } from '../../../../testUtils/fixtures';
import type { StationArrival } from '../../../../shared/types/arrival';

function makeArrival(rows: ReturnType<typeof makeArrivalInfo>[]): StationArrival {
  return { up: rows, down: [], source: 'realtime' };
}

describe('undergroundSSOTConsensus', () => {
  it('WiFi + Arrival arvlCd 정착 합의 시 WiFi 우선 채택', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1, trainCode: 'W1' }),
    ]);
    const result = undergroundSSOTConsensus({ wifiStation: wifi, positionTrainResult: positionTrain, arrival });
    expect(result).toEqual({ station: wifi, trainCode: 'W1' });
  });

  it('WiFi 없고 Position-Train + Arrival 합의', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '3', arrivalCode: 2, trainCode: 'P1' }),
    ]);
    const result = undergroundSSOTConsensus({ wifiStation: null, positionTrainResult: positionTrain, arrival });
    expect(result).toEqual({ station: positionTrain.station, trainCode: 'P1' });
  });

  it('WiFi 있지만 line 매칭 arrival 없음 → Position-Train으로 fallback', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '3', arrivalCode: 1, trainCode: 'P2' }),
    ]);
    const result = undergroundSSOTConsensus({ wifiStation: wifi, positionTrainResult: positionTrain, arrival });
    expect(result?.trainCode).toBe('P2');
    expect(result?.station).toEqual(positionTrain.station);
  });

  it('둘 다 null이면 합의 미성립', () => {
    const arrival = makeArrival([makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1 })]);
    expect(undergroundSSOTConsensus({ wifiStation: null, positionTrainResult: null, arrival })).toBeNull();
  });

  it('arrival null이면 합의 미성립', () => {
    expect(
      undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: null,
        arrival: null,
      }),
    ).toBeNull();
  });

  it.each([0, 4, 99, -1])('비정착 arvlCd=%i는 합의 미성립', (arvlCd) => {
    const arrival = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: arvlCd }),
    ]);
    expect(
      undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: null,
        arrival,
      }),
    ).toBeNull();
  });

  it('down 슬롯 arrival도 합의 인식', () => {
    const arrival: StationArrival = {
      up: [],
      down: [makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 5, trainCode: 'D1' })],
      source: 'realtime',
    };
    const result = undergroundSSOTConsensus({
      wifiStation: MOCK_STATIONS.gangnam,
      positionTrainResult: null,
      arrival,
    });
    expect(result?.trainCode).toBe('D1');
  });
});
