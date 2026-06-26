/**
 * #1418 — 원형 (WiFi+Arrival / Position-Train+Arrival) 단일 pair 합의.
 * #1574 (ADR-017 T11) — 4-signal 2-of-N 합의로 확장:
 *   station pair: wifi+arrival, position+arrival
 *   env vote: barometer-stop, cellular-underground
 *   - station pair ≥ 1 + (station pair + env vote) ≥ 2 통과 시 채택
 *   - cellular 'surface' (NR SA) vote → reject (환경 확정 모순 — hard-reject)
 *   - cellular 'surface-weak' (LTE/NRNSA) vote → envVotes −1 (soft downgrade, #1876)
 *   - station 우선순위: position > wifi
 * #1821 — warmup quorum 완화:
 *   - trip 시작 후 60s 이내 + station pair 1개 → underground 채택 (quorum=1)
 *   - 60s 이후 + station pair 1개 → null (steady quorum=2)
 *   - 60s 이내 + env vote 1개만 (station pair 0) → null (station pair ≥ 1 필수)
 * #1876 — 'surface-weak' soft downgrade:
 *   - 'surface-weak' 단독: envVotes=−1 → 다른 신호 없으면 quorum 미달
 *   - barometer+accelerometer+surface-weak: 1+1−1=1 → steady quorum=2 미달
 *   - barometer+accelerometer+surface-weak+position pair: 1+1−1=1 → 2-of-N pass (pair 1 + env 1 ≥ 2)
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

  it.each([0, 4, 99, -1])(
    '비정착 arvlCd=%i는 primary 합의 미성립 — #1884 weighted vote fallback로 channel 보강 (partial 0.6 + env 0.8)',
    (arvlCd) => {
      // #1884 이전: 비정착 arvlCd → primary stationPairs=0 + envVotes 누적 → null.
      // #1884 이후: weighted vote fallback에서 positional partial(0.6) + radio(0.5) + time(0.3) = 1.4 ≥ 1.1.
      // station 채택은 가능하지만 trainCode는 빈 문자열 (arrival 미수렴).
      // 비정착 arrival이 발생해도 positional + env 3 신호가 강하면 station 채택 — silent 비용 차단.
      const arrivalMoving = makeArrival([
        makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: arvlCd }),
      ]);
      const result = undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: makeNearestResult('gangnam', 0.05),
        arrival: arrivalMoving,
        barometerStop: true,
        cellularEnvironmentVote: 'underground',
      });
      expect(result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
      expect(result?.trainCode).toBe('');
    },
  );

  it('비정착 arvlCd + env vote 없음 (weighted vote 미달) → primary + fallback 둘 다 reject', () => {
    // env vote 없으면 positional partial 0.6 만 → 0.6 < 1.1 → fallback도 reject.
    const arrivalMoving = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '2', arrivalCode: 0 }),
    ]);
    expect(
      undergroundSSOTConsensus({
        wifiStation: MOCK_STATIONS.gangnam,
        positionTrainResult: makeNearestResult('gangnam', 0.05),
        arrival: arrivalMoving,
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

  it("Cellular 'surface' (NR SA) → underground SSOT hard-reject (환경 확정 모순)", () => {
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

describe('undergroundSSOTConsensus — accelerometer fingerprint (#1542 ADR-016 S9)', () => {
  it('Position + accelerometer automotive (BG WiFi nil, baro/cellular 미수렴) → 2-of-N pass', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      accelerometerPattern: 'automotive',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('WiFi + accelerometer automotive → 2-of-N pass', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: null,
      arrival: arrivalLine2,
      accelerometerPattern: 'automotive',
    });
    expect(result?.station.id).toBe(wifi.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('Position + barometer + accelerometer → 3 env votes 누적, station 채택 (position 우선)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
      cellularEnvironmentVote: 'underground',
      accelerometerPattern: 'automotive',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });

  it.each<'stationary' | 'walking' | 'unknown'>(['stationary', 'walking', 'unknown'])(
    'accelerometer pattern=%s → vote 미투표 (1-of-N)',
    (pattern) => {
      const positionTrain = makeNearestResult('gangnam', 0.05);
      expect(
        undergroundSSOTConsensus({
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
          accelerometerPattern: pattern,
        }),
      ).toBeNull();
    },
  );

  it("accelerometer automotive + cellular 'surface' (NR SA) → reject (환경 확정 모순 우선)", () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        accelerometerPattern: 'automotive',
        cellularEnvironmentVote: 'surface',
      }),
    ).toBeNull();
  });

  it('env vote만 (baro + cellular + accelerometer) station pair 0 → null', () => {
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: null,
        arrival: arrivalLine2,
        barometerStop: true,
        cellularEnvironmentVote: 'underground',
        accelerometerPattern: 'automotive',
      }),
    ).toBeNull();
  });

  it('accelerometer undefined (호출자 미전달) → backward-compat 기존 동작 보존', () => {
    // wifi + position 둘 다 매칭 → 2-of-N station pair 모드 그대로.
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });
});

describe('undergroundSSOTConsensus — warmup quorum (#1821)', () => {
  const NOW = 1_750_000_000_000;
  const WARMUP_START = NOW - 30_000; // trip 시작 30s 전 → 아직 warmup 60s 이내
  const STEADY_START = NOW - 90_000; // trip 시작 90s 전 → steady 모드

  it('warmup 60s 이내 + station pair 1개 → underground 채택 (quorum=1)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus(
      {
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        tripStartedAt: WARMUP_START,
      },
      NOW,
    );
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('warmup 60s 이내 + WiFi station pair 단독 → underground 채택', () => {
    const wifi = MOCK_STATIONS.gangnam;
    const result = undergroundSSOTConsensus(
      {
        wifiStation: wifi,
        positionTrainResult: null,
        arrival: arrivalLine2,
        tripStartedAt: WARMUP_START,
      },
      NOW,
    );
    expect(result?.station.id).toBe(wifi.id);
  });

  it('steady 60s 이후 + station pair 1개 → null (quorum=2 미달)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
          tripStartedAt: STEADY_START,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('warmup 이내 + env vote 1개만 (station pair 0) → null (station pair ≥ 1 필수)', () => {
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: null,
          arrival: arrivalLine2,
          barometerStop: true,
          tripStartedAt: WARMUP_START,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('tripStartedAt undefined (미탑승) → steady quorum=2 적용', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    // station pair 1개만, env vote 0 → steady quorum=2 미달 → null
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it('warmup 경계 정확히 60s → steady 전환 (quorum=2)', () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const exactBoundary = NOW - 60_000; // exactly 60s elapsed → NOT warmup
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
          tripStartedAt: exactBoundary,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("warmup + cellular 'surface' (NR SA) → reject (환경 확정 모순이 warmup보다 우선)", () => {
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
          cellularEnvironmentVote: 'surface',
          tripStartedAt: WARMUP_START,
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("undergroundSSOTConsensus — 'surface-weak' soft downgrade (#1876)", () => {
  // 'surface-weak' (LTE/NRNSA) = envVotes −1. hard-reject 아님.
  // 다른 신호가 충분하면 underground 채택 가능.

  it("'surface-weak' 단독 (position pair 1 + envVotes=−1) → steady quorum=2 미달 → null", () => {
    // position pair: 1. envVotes: 0−1=−1. total: 1+(−1)=0 < 2 → null.
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'surface-weak',
      }),
    ).toBeNull();
  });

  it("position + barometer + 'surface-weak' → 1+1−1=1 → steady quorum=2 미달 → null", () => {
    // barometer+1, surface-weak−1 → envVotes=0. total: pair 1 + env 0 = 1 < 2 → null.
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        barometerStop: true,
        cellularEnvironmentVote: 'surface-weak',
      }),
    ).toBeNull();
  });

  it("position + barometer + accelerometer + 'surface-weak' → pair 1 + (1+1−1)=1 → 2-of-N pass", () => {
    // envVotes: baro+1 + accel+1 + surface-weak−1 = 1. total: pair 1 + env 1 = 2 ≥ 2 → pass.
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
      accelerometerPattern: 'automotive',
      cellularEnvironmentVote: 'surface-weak',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it("wifi + position + 'surface-weak' → pair 2 + env −1 = 1 < 2 → null", () => {
    // station pair 2이지만 env 감산으로 total=1 → quorum=2 미달.
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: wifi,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'surface-weak',
      }),
    ).toBeNull();
  });

  it("wifi + position + barometer + 'surface-weak' → 2+1−1=2 ≥ 2 → pass (position 우선)", () => {
    // pair: 2. envVotes: baro+1 + surface-weak−1 = 0. total: 2+0 = 2 ≥ 2 → pass.
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      barometerStop: true,
      cellularEnvironmentVote: 'surface-weak',
    });
    // position 우선 → positionTrain.station
    expect(result?.station.id).toBe(positionTrain.station.id);
  });

  it("'surface-weak' hard-reject 아님 — 'surface' (NR SA)와 달리 즉시 null 반환 X", () => {
    // 'surface' → 즉시 null. 'surface-weak' → quorum 계산 진행.
    // station pair 0이면 어차피 null이지만 이유는 'hard-reject'가 아닌 'station pair 0'.
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: null,
      arrival: arrivalLine2,
      cellularEnvironmentVote: 'surface-weak',
    });
    expect(result).toBeNull(); // station pair 0 → null (hard-reject X, quorum X)
  });

  it("warmup 60s 이내 + 'surface-weak' → quorum=1, pair=1, envVotes=−1 → total=0 < 1 → null", () => {
    // warmup quorum=1. pair: 1. envVotes: −1. total: 1+(−1)=0 < 1 → null.
    const NOW = 1_750_000_000_000;
    const WARMUP_START = NOW - 30_000;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    expect(
      undergroundSSOTConsensus(
        {
          wifiStation: null,
          positionTrainResult: positionTrain,
          arrival: arrivalLine2,
          cellularEnvironmentVote: 'surface-weak',
          tripStartedAt: WARMUP_START,
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("warmup 60s 이내 + 'surface-weak' + barometer → pair=1, envVotes=1−1=0 → total=1 ≥ quorum=1 → pass", () => {
    // warmup quorum=1. pair: 1. envVotes: baro+1 + surface-weak−1 = 0. total: 1+0=1 ≥ 1 → pass.
    const NOW = 1_750_000_000_000;
    const WARMUP_START = NOW - 30_000;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus(
      {
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2,
        barometerStop: true,
        cellularEnvironmentVote: 'surface-weak',
        tripStartedAt: WARMUP_START,
      },
      NOW,
    );
    expect(result?.station.id).toBe(positionTrain.station.id);
  });
});

describe('undergroundSSOTConsensus — weighted vote fallback (#1884 RC-3)', () => {
  // T3 시나리오 — primary path 미달 시 weighted vote가 station 채택.
  // 'positional partial(0.6) + env vote 합산 ≥ 1.1' 조건.

  it('positional partial(arrival 미매칭) + cellular underground + barometer → fallback accept', () => {
    // T3 stuck 시나리오: position-train (line=3 청대) 있고 arrival은 line=2 (호선 불일치).
    // primary: stationPairs=0 + envVotes=2 → stationPairs.length<1 fail.
    // fallback: positional partial 0.6 + radio 0.5 + time 0.3 = 1.4 ≥ 1.1 → accept.
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // line=2, 호선 불일치
      cellularEnvironmentVote: 'underground',
      barometerStop: true,
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe(''); // arrival 미매칭이라 trainCode 미수렴
  });

  it('positional partial + 환경 vote 1개만(radio) = 1.1 fallback accept', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      cellularEnvironmentVote: 'underground',
    });
    expect(result?.station.id).toBe(positionTrain.station.id);
  });

  it('positional partial + 단일 약 vote (time) = 0.9 → fallback reject (임계 미달)', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2, // mismatch
        barometerStop: true,
      }),
    ).toBeNull();
  });

  it('station 후보 부재 + env vote 누적 → fallback에서도 reject (station 가드 보존)', () => {
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: null,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'underground',
        barometerStop: true,
      }),
    ).toBeNull();
  });

  it('primary path 통과 시 fallback 미진입 (기존 동작 보존)', () => {
    // wifi + position + arrival 매칭 → primary 통과 → fallback 호출 X.
    const wifi = MOCK_STATIONS.gangnam;
    const positionTrain = makeNearestResult('gangnam', 0.05);
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
    });
    // primary stationPairs=2, envVotes=0, quorum=2 → 2+0>=2 pass → stationPairs[0] = position-train
    expect(result?.station.id).toBe(positionTrain.station.id);
    expect(result?.trainCode).toBe('T1');
  });

  it('cellular surface → fallback 진입 전 reject (환경 모순 절대 우선)', () => {
    // weighted vote 함수 자체는 cellular surface를 입력으로 받을 수 있으나, 호출자가 먼저 reject.
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    expect(
      undergroundSSOTConsensus({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2, // partial
        cellularEnvironmentVote: 'surface',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      }),
    ).toBeNull();
  });

  it('wifi station partial(arrival 미매칭) + env vote → fallback accept', () => {
    // wifi만 있고 position-train 없음 + arrival 호선 불일치.
    // primary: stationPairs=0 → fail. fallback: positional partial(wifi) 0.6 + env 0.5 = 1.1 ✓.
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const result = undergroundSSOTConsensus({
      wifiStation: wifi,
      positionTrainResult: null,
      arrival: arrivalLine3, // line=3 mismatch
      cellularEnvironmentVote: 'underground',
    });
    expect(result?.station.id).toBe(wifi.id);
    expect(result?.trainCode).toBe('');
  });
});
