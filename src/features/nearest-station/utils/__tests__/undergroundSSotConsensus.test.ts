/**
 * #1418 — 원형 (WiFi+Arrival / Position-Train+Arrival) 단일 pair 합의.
 * #1574 (ADR-017 T11) — 4-signal 2-of-N 합의로 확장:
 *   station pair: wifi+arrival, position+arrival
 *   env vote: barometer-stop, cellular-underground
 *   - station pair ≥ 1 + (station pair + env vote) ≥ 2 통과 시 채택
 *   - cellular surface vote → reject (환경 확정 모순)
 *   - station 우선순위: position > wifi
 */

import { undergroundSSOTConsensus } from '../undergroundSSotConsensus';
import { MOCK_STATIONS, makeArrivalInfo, makeNearestResult } from '../../../../testUtils/fixtures';
import type { StationArrival } from '../../../../shared/types/arrival';

function makeArrival(rows: ReturnType<typeof makeArrivalInfo>[]): StationArrival {
  return { up: rows, down: [], source: 'realtime' };
}

const arrivalLine2 = makeArrival([
  makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 1, trainCode: 'T1' }),
]);
const arrivalLine3 = makeArrival([
  makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '3', arrivalCode: 2, trainCode: 'P1' }),
]);

describe('undergroundSSOTConsensus — base behavior (#1418)', () => {
  it('WiFi + Position 둘 다 매칭 시 2-of-N pass, position-train station 우선', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const positionTrain = makeNearestResult('gangnam', 0.05); // line=2 (same line for both to match arrival)
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('WiFi만 매칭, position 호선 불일치 → 1-of-N → null (보강 필요)', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3, arrival은 line=2
    expect(
      undergroundSSOTConsensus({
        wifiStation: wifi,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
      }),
    ).toBeNull();
  });

  it('Position-Train만 (WiFi nil — BG 시나리오) → 1-of-N → null (env vote 보강 필요)', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
      }),
    ).toBeNull();
  });

  it('둘 다 null이면 합의 미성립', () => {
    expect(
      undergroundSSOTConsensus({ wifiStation: null, positionTrainResult: null, arrival: arrivalLine2 }),
    ).toBeNull();
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

  it.each([0, 4, 99, -1])('비정착 arvlCd=%i는 합의 미성립 (station pair 0)', (arvlCd) => {
    const arrivalMoving = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: arvlCd }),
    ]);
    expect(
      undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: makeNearestResult('gangnam', 0.05),
        arrival: arrivalMoving,
        barometerStop: true,
        cellularEnvironmentVote: 'underground',
      }),
    ).toBeNull();
  });

  it('down 슬롯 arrival도 합의 인식', () => {
    const arrivalDown: StationArrival = {
      up: [],
      down: [makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 5, trainCode: 'D1' })],
      source: 'realtime',
    };
    const result = undergroundSSOTConsensus({
      wifiStation: MOCK_STATIONS.gangnam,
      positionTrainResult: makeNearestResult('gangnam', 0.05),
      arrival: arrivalDown,
    });
    expect(result?.trainCode).toBe('D1');
  });
});

describe('undergroundSSOTConsensus — 4-signal 2-of-N (#1574 ADR-017 T11)', () => {
  it('Position + barometer-stop (BG WiFi nil) → 2-of-N pass', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null, // BG에서 NEHotspotNetwork.fetchCurrent nil
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('Position + cellular-underground (BG) → 2-of-N pass', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      cellularEnvironmentVote: 'underground',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });

  it('WiFi + barometer-stop → 2-of-N pass', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: null,
      arrival: arrivalLine2,
      barometerStop: true,
    });
    expect(result?.station.id).toBe(wifi.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('Cellular surface → underground SSOT reject (환경 확정 모순)', () => {
    expect(
      undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: makeNearestResult('gangnam', 0.05),
        arrival: arrivalLine2,
        barometerStop: true,
        cellularEnvironmentVote: 'surface',
      }),
    ).toBeNull();
  });

  it('FG 4-of-4 (wifi + position + barometer + cellular-underground) → pass, position 우선', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
      cellularEnvironmentVote: 'underground',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });

  it('barometer + cellular only (station pair 0) → null (env vote만으로는 station 채택 불가)', () => {
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: null,
        arrival: arrivalLine2,
        barometerStop: true,
        cellularEnvironmentVote: 'underground',
      }),
    ).toBeNull();
  });

  it('barometer-stop=false → vote 미투표 (1-of-N)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        barometerStop: false,
      }),
    ).toBeNull();
  });

  it('cellular unknown → vote 미투표 (1-of-N)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'unknown',
      }),
    ).toBeNull();
  });

  it('barometer/cellular undefined (warmup/미지원) → fallback to 2-station-pair mode', () => {
    // wifi + position 둘 다 매칭 → 2-of-N pass (env vote 없이도)
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
    });
    expect(result?.trainCode).toBe('T1');
  });

  it('Position 호선 매칭, barometer-stop=true → 2-of-N pass (cellular unknown 무관)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
      cellularEnvironmentVote: 'unknown',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });
});
