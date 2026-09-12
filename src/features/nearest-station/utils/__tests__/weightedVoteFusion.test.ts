/**
 * #1884 (ADR-015 RC-3) — Weighted vote 4-signal fusion.
 *
 * 검증 카테고리:
 *   - paradigm: positional(1.0/0.6) + radio(0.5) + motion(0.4) + time(0.3) weights
 *   - T3 stuck 해소: arrival 미매칭 positional + env vote 합산 임계 1.1 초과 → accept
 *   - 환경 모순 reject는 호출자 책임 (`undergroundSSOTConsensus`) — 본 함수는 'surface' 입력 받음
 *   - station 후보 0 → 항상 reject (env vote 누적이 아무리 커도)
 *   - votes meta 노출: DebugModal/Sentry breadcrumb용 contribution 표
 */

import { weightedVoteFusion } from '../weightedVoteFusion';
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

describe('weightedVoteFusion — T3 stuck 해소 (#1884 RC-3)', () => {
  it('position-train(arrival 미매칭, 0.6) + cellular underground(0.5) = 1.1 → accept', () => {
    // T3 시나리오: 을지로4가 station, arrival API 일시 실패(line 미매칭), cellular는 underground.
    // 기존 quorum 정책으로는 stationPairs=0 + envVotes=1 = reject. weighted vote로 회복.
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // line=2, position-train과 불일치
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(positionTrain.station.id);
    expect(result.winner?.trainCode).toBe(''); // arrival 미매칭이므로 trainCode 빈 문자열
    expect(result.totalScore).toBeCloseTo(1.1, 10); // 0.6 + 0.5
  });

  it('position-train(arrival 매칭, 1.0) + cellular underground(0.5) = 1.5 → strong accept', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine3, // matches line=3
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(positionTrain.station.id);
    expect(result.winner?.trainCode).toBe('P1');
    expect(result.totalScore).toBeCloseTo(1.5, 10); // 1.0 + 0.5
  });

  it('position-train partial(0.6) + barometer-stop(0.3) = 0.9 → reject (단일 약 vote만으로는 부족)', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // line=2 mismatch → partial
      barometerStop: true,
    });
    expect(result.accepted).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.totalScore).toBeCloseTo(0.9, 10); // 0.6 + 0.3
  });

  it('position-train partial(0.6) + motion automotive(0.4) + time barometer(0.3) = 1.3 → accept', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // partial
      accelerometerPattern: 'automotive',
      barometerStop: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.totalScore).toBeCloseTo(1.3, 10);
  });

  it('position-train partial(0.6) + 모든 env vote = 1.8 → accept', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2,
      cellularEnvironmentVote: 'underground',
      accelerometerPattern: 'automotive',
      barometerStop: true,
    });
    expect(result.accepted).toBe(true);
    expect(result.totalScore).toBeCloseTo(1.8, 10); // 0.6 + 0.5 + 0.4 + 0.3
  });
});

describe('weightedVoteFusion — backward compat (기존 정책 보존)', () => {
  it('positional full(1.0) 단독 → 임계 1.1 미달 → reject', () => {
    // 기존 steady quorum=2 정책과 동등. station pair 단독 불가.
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine3, // matches
    });
    expect(result.accepted).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.totalScore).toBeCloseTo(1.0, 10);
  });

  it('station 후보 0 + env vote 누적 (barometer + cellular + motion) → 항상 reject', () => {
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: null,
      arrival: arrivalLine2,
      barometerStop: true,
      cellularEnvironmentVote: 'underground',
      accelerometerPattern: 'automotive',
    });
    expect(result.accepted).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.totalScore).toBeCloseTo(1.2, 10); // env vote 누적은 노출
  });

  it('모든 신호 부재 → reject, totalScore=0', () => {
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: null,
      arrival: null,
    });
    expect(result.accepted).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.totalScore).toBe(0);
  });
});

describe('weightedVoteFusion — positional 우선순위 (position-train > wifi-ssid)', () => {
  it('position-train + wifi 둘 다 매칭 → position-train station 채택', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = weightedVoteFusion({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine3, // matches position-train
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(positionTrain.station.id);
    expect(result.winner?.trainCode).toBe('P1');
  });

  it('position-train arrival 미매칭, wifi 있음 → position-train partial이 우선 (먼저 평가)', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const positionTrain = makeNearestResult('chungmuro', 0.05); // line=3
    const result = weightedVoteFusion({
      wifiStation: wifi,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // wifi와 매칭, position-train과 불일치
      cellularEnvironmentVote: 'underground',
    });
    // positional evaluator는 position-train 먼저 시도 → 매칭 실패 시 partial. wifi는 평가 X.
    // → station=position-train, weight=0.6 + env 0.5 = 1.1 ≥ 임계 → accept.
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(positionTrain.station.id);
    expect(result.winner?.trainCode).toBe('');
  });

  it('position-train 없음, wifi + arrival 매칭 → wifi 채택 (full weight)', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const result = weightedVoteFusion({
      wifiStation: wifi,
      positionTrainResult: null,
      arrival: arrivalLine2,
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(wifi.id);
    expect(result.winner?.trainCode).toBe('T1');
    expect(result.totalScore).toBeCloseTo(1.5, 10); // 1.0 + 0.5
  });

  it('position-train 없음, wifi arrival 미매칭 → wifi partial(0.6) + env 0.5 = 1.1 accept', () => {
    const wifi = MOCK_STATIONS.gangnam; // line=2
    const result = weightedVoteFusion({
      wifiStation: wifi,
      positionTrainResult: null,
      arrival: arrivalLine3, // wifi line=2와 불일치
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(wifi.id);
    expect(result.winner?.trainCode).toBe('');
  });
});

describe('weightedVoteFusion — Arrival 매칭 edge cases', () => {
  it('arrival null → positional partial only (arrival 호출 실패)', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: null,
      barometerStop: true,
      cellularEnvironmentVote: 'underground',
    });
    // positional partial(0.6) + barometer(0.3) + cellular(0.5) = 1.4 → accept
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe(positionTrain.station.id);
    expect(result.totalScore).toBeCloseTo(1.4, 10);
  });

  it.each([0, 4, 99, -1])('arrival arvlCd=%i 비정착 → positional partial 처리', (arvlCd) => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const arrivalMoving = makeArrival([
      makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '3', arrivalCode: arvlCd }),
    ]);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalMoving,
      cellularEnvironmentVote: 'underground',
    });
    // partial 0.6 + cellular 0.5 = 1.1 → accept
    expect(result.accepted).toBe(true);
    expect(result.winner?.trainCode).toBe('');
  });

  it('arrival down 슬롯 매칭도 인식', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const arrivalDown: StationArrival = {
      up: [],
      down: [makeArrivalInfo({ destination: '', arrivalSeconds: 0, line: '3', arrivalCode: 5, trainCode: 'D1' })],
      source: 'realtime',
    };
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalDown,
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.trainCode).toBe('D1');
  });

  it('동일 station id 중복 신호 시 weight 누적 (wifi=position-train 같은 station)', () => {
    // wifi랑 positionTrain이 같은 station id를 가리킬 때 (드물지만 가능 — 둘 다 강남):
    // positional evaluator는 우선순위로 position-train 1개만 평가 → wifi 무시.
    // 결과: position-train weight 1.0만 누적, 중복 누적 없음.
    const positionTrain = makeNearestResult('gangnam', 0.05); // line=2
    const result = weightedVoteFusion({
      wifiStation: MOCK_STATIONS.gangnam, // 같은 station
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // matches
      cellularEnvironmentVote: 'underground',
    });
    expect(result.accepted).toBe(true);
    expect(result.winner?.station.id).toBe('0201');
    expect(result.totalScore).toBeCloseTo(1.5, 10); // 1.0 (positional) + 0.5 (radio)
  });
});

describe('weightedVoteFusion — votes meta 노출 (DebugModal/Sentry)', () => {
  it('모든 카테고리 evaluator votes 배열에 포함 (contributed 여부 무관)', () => {
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: null,
      arrival: null,
    });
    expect(result.votes).toHaveLength(4);
    const categories = result.votes.map((v) => v.category);
    expect(categories).toEqual(['positional', 'radio', 'motion', 'time']);
  });

  it('contributed=true 신호의 effectiveWeight는 baseWeight × multiplier', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine3, // full match
      cellularEnvironmentVote: 'underground',
      accelerometerPattern: 'automotive',
      barometerStop: true,
    });
    const positionalVote = result.votes.find((v) => v.category === 'positional');
    expect(positionalVote?.contributed).toBe(true);
    expect(positionalVote?.effectiveWeight).toBe(1.0);
    expect(positionalVote?.weight).toBe(1.0);

    const radioVote = result.votes.find((v) => v.category === 'radio');
    expect(radioVote?.contributed).toBe(true);
    expect(radioVote?.effectiveWeight).toBe(0.5);

    const motionVote = result.votes.find((v) => v.category === 'motion');
    expect(motionVote?.contributed).toBe(true);
    expect(motionVote?.effectiveWeight).toBe(0.4);

    const timeVote = result.votes.find((v) => v.category === 'time');
    expect(timeVote?.contributed).toBe(true);
    expect(timeVote?.effectiveWeight).toBe(0.3);
  });

  it('arrival 미매칭 positional partial weight = 0.6 (1.0 × 0.6)', () => {
    const positionTrain = makeNearestResult('chungmuro', 0.05);
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: positionTrain,
      arrival: arrivalLine2, // mismatch
    });
    const positionalVote = result.votes.find((v) => v.category === 'positional');
    expect(positionalVote?.contributed).toBe(true);
    expect(positionalVote?.effectiveWeight).toBeCloseTo(0.6, 10);
    expect(positionalVote?.trainCode).toBeNull();
  });

  it.each<'unknown' | 'surface'>(['unknown', 'surface'])(
    'cellular=%s → radio contributed=false, effectiveWeight=0',
    (vote) => {
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: null,
        arrival: null,
        cellularEnvironmentVote: vote,
      });
      const radioVote = result.votes.find((v) => v.category === 'radio');
      expect(radioVote?.contributed).toBe(false);
      expect(radioVote?.effectiveWeight).toBe(0);
    },
  );

  it.each<'stationary' | 'walking' | 'unknown'>(['stationary', 'walking', 'unknown'])(
    'accelerometer=%s → motion contributed=false',
    (pattern) => {
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: null,
        arrival: null,
        accelerometerPattern: pattern,
      });
      const motionVote = result.votes.find((v) => v.category === 'motion');
      expect(motionVote?.contributed).toBe(false);
    },
  );

  it('barometer-stop=false → time contributed=false', () => {
    const result = weightedVoteFusion({
      wifiStation: null,
      positionTrainResult: null,
      arrival: null,
      barometerStop: false,
    });
    const timeVote = result.votes.find((v) => v.category === 'time');
    expect(timeVote?.contributed).toBe(false);
  });
});

describe("weightedVoteFusion — D+A hybrid (#1876 'surface-weak' cross-impact)", () => {
  // D: 'surface-weak'일 때 threshold 1.1 → 1.6 상향.
  // A: station 후보 0 → 항상 reject (env vote 무관).
  //
  // 사용자 결정: PR #1876 surface-weak (envVotes -= 1 보수 처리) 의도를 fallback에서도 보존.

  describe('D: threshold 1.6 동적 상향', () => {
    it("'surface-weak' + positional full(arrival 매칭, 1.0) 단독 → 1.0 < 1.6 → reject", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3, // full match
        cellularEnvironmentVote: 'surface-weak',
      });
      expect(result.accepted).toBe(false);
      expect(result.acceptThreshold).toBe(1.6);
      expect(result.totalScore).toBeCloseTo(1.0, 10);
    });

    it("'surface-weak' + positional full + barometer(0.3) → 1.3 < 1.6 → reject", () => {
      // 1.1 임계 환경이라면 accept였을 케이스. surface-weak 환경에서는 약 신호 하나로는 부족.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak',
        barometerStop: true,
      });
      expect(result.accepted).toBe(false);
      expect(result.acceptThreshold).toBe(1.6);
      expect(result.totalScore).toBeCloseTo(1.3, 10);
    });

    it("'surface-weak' + positional full + barometer + accelerometer automotive → 1.7 ≥ 1.6 → accept", () => {
      // 강한 multi-source 조합 (정착 + train 진동 + station). surface-weak이어도 채택 가능.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(true);
      expect(result.acceptThreshold).toBe(1.6);
      expect(result.winner?.station.id).toBe(positionTrain.station.id);
      expect(result.totalScore).toBeCloseTo(1.7, 10);
    });

    it("'surface-weak' + positional partial + barometer + accelerometer → 0.6+0.3+0.4=1.3 < 1.6 → reject", () => {
      // surface-weak에서는 partial positional + 환경 vote 둘만으로는 부족.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2, // mismatch → partial 0.6
        cellularEnvironmentVote: 'surface-weak',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(false);
      expect(result.acceptThreshold).toBe(1.6);
      expect(result.totalScore).toBeCloseTo(1.3, 10);
    });

    it("'surface-weak' + radio vote 미참여 (cellular 자체가 surface-weak이므로 underground vote X)", () => {
      // surface-weak일 때 radio evaluator는 'underground'와 매칭 안 됨 → contributed=false.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak',
      });
      const radioVote = result.votes.find((v) => v.category === 'radio');
      expect(radioVote?.contributed).toBe(false);
      expect(radioVote?.effectiveWeight).toBe(0);
    });

    it("'underground' (기본 환경)에서는 threshold 1.1 유지", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2, // partial
        cellularEnvironmentVote: 'underground',
      });
      expect(result.acceptThreshold).toBe(1.1);
      expect(result.accepted).toBe(true); // 0.6 + 0.5 = 1.1 ✓
    });

    it("cellularEnvironmentVote 미전달(undefined)에서는 threshold 1.1 유지", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        barometerStop: true,
      });
      expect(result.acceptThreshold).toBe(1.1);
      expect(result.accepted).toBe(true); // 1.0 + 0.3 = 1.3 ≥ 1.1 ✓
    });

    it("'unknown' cellular에서도 threshold 1.1 유지 (vote 미투표일 뿐)", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'unknown',
        barometerStop: true,
      });
      expect(result.acceptThreshold).toBe(1.1);
      expect(result.accepted).toBe(true); // 1.0 + 0.3 = 1.3 ≥ 1.1 ✓
    });

    it("'surface' (NR SA hard-reject) 입력 시에도 threshold 1.1 유지 — 호출자가 본 함수 진입 전 reject", () => {
      // 본 함수는 'surface' 입력을 받아도 reject 처리는 호출자(undergroundSSOTConsensus) 책임.
      // 본 함수 자체는 'surface'에 특별 분기 없이 기본 threshold 적용.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface',
      });
      expect(result.acceptThreshold).toBe(1.1);
    });
  });

  describe("NRNSA: threshold 1.3 완화 + barometerRecentSubsurface 무효화 (#2099, Part of #2093 E)", () => {
    // 7/7 trip 로그: NRNSA(surface-weak-nrnsa)는 LTE(surface-weak)와 같은 근거지만 서울 지하철
    // 전 구간 중계 구조상 surface 정보가치가 더 낮다 — threshold를 1.6에서 1.3으로 완화(옵션 2).
    // trip 활성 중 barometer가 최근 subsurface=true를 확정했으면 threshold조차 적용하지 않고
    // 기본 1.1로 완전 무효화한다(옵션 1) — barometer 확정을 cellular NRNSA가 뒤집지 못하게.

    it("'surface-weak-nrnsa' + positional full + barometer(0.3) = 1.3 ≥ 1.3 → accept (LTE였다면 1.3 < 1.6 → reject)", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak-nrnsa',
        barometerStop: true,
      });
      expect(result.acceptThreshold).toBe(1.3);
      expect(result.accepted).toBe(true);
      expect(result.totalScore).toBeCloseTo(1.3, 10);
    });

    it("'surface-weak-nrnsa' + positional full 단독 = 1.0 < 1.3 → reject", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak-nrnsa',
      });
      expect(result.acceptThreshold).toBe(1.3);
      expect(result.accepted).toBe(false);
    });

    it("#2099 재현 시나리오 — 'surface-weak-nrnsa' + barometerRecentSubsurface=true → threshold 기본 1.1로 무효화, positional full 단독(1.0)은 여전히 미달이나 partial+radio 조합은 기존 underground 정책과 동일하게 accept", () => {
      // barometerRecentSubsurface=true → THRESHOLD_BY_ENV 매칭 제외 → 기본 1.1 적용.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine2, // partial (0.6)
        cellularEnvironmentVote: 'underground',
        barometerRecentSubsurface: true,
      });
      expect(result.acceptThreshold).toBe(1.1);
      expect(result.accepted).toBe(true); // 0.6(partial) + 0.5(radio-underground) = 1.1 — 기본 정책과 동일
    });

    it("'surface-weak-nrnsa' + barometerRecentSubsurface=true → threshold 1.1로 무효화, positional full + barometer(1.3) → accept (기본 정책과 동등)", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak-nrnsa',
        barometerStop: true,
        barometerRecentSubsurface: true,
      });
      expect(result.acceptThreshold).toBe(1.1);
      expect(result.accepted).toBe(true);
      expect(result.totalScore).toBeCloseTo(1.3, 10);
    });

    it("'surface-weak-nrnsa' + barometerRecentSubsurface=false → threshold 1.3 그대로 (가중 미적용, 회귀 없음)", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak-nrnsa',
        barometerStop: true,
        barometerRecentSubsurface: false,
      });
      expect(result.acceptThreshold).toBe(1.3);
      expect(result.totalScore).toBeCloseTo(1.3, 10);
      expect(result.accepted).toBe(true); // 1.3 ≥ 1.3 threshold — 이 케이스는 accept
    });

    it("'surface-weak-nrnsa' + radio vote 미참여 (cellular 자체가 surface-weak-nrnsa이므로 underground vote X)", () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak-nrnsa',
      });
      const radioVote = result.votes.find((v) => v.category === 'radio');
      expect(radioVote?.contributed).toBe(false);
      expect(radioVote?.effectiveWeight).toBe(0);
    });
  });

  describe('A: station 후보 0 → 항상 reject (env 무관)', () => {
    it("'surface-weak' + station 후보 0 → null (env 누적이 1.6 미달인 것과 무관, station 가드)", () => {
      // env 누적: time(0.3) + motion(0.4) = 0.7. 둘 다 1.6 미달이지만 station 후보 0이 primary 가드.
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: null,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'surface-weak',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(false);
      expect(result.winner).toBeNull();
      expect(result.totalScore).toBeCloseTo(0.7, 10);
    });

    it("'underground' + station 후보 0 → null (A 가드는 환경 무관)", () => {
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: null,
        arrival: arrivalLine2,
        cellularEnvironmentVote: 'underground',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(false);
      expect(result.winner).toBeNull();
    });

    it("'surface-weak' + station 후보 0 + 모든 env 누적 → null", () => {
      // 모든 env vote (radio 'surface-weak'는 미참여, motion+time만 누적).
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: null,
        arrival: null,
        cellularEnvironmentVote: 'surface-weak',
        barometerStop: true,
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(false);
      expect(result.winner).toBeNull();
    });
  });

  describe("integration: 'surface-weak' 정확 임계 boundary", () => {
    it('positional full + accelerometer + time = 정확히 1.7 → accept', () => {
      // 1.0 + 0.4 + 0.3 = 1.7. 1.6보다 큼.
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak',
        accelerometerPattern: 'automotive',
        barometerStop: true,
      });
      expect(result.accepted).toBe(true);
      expect(result.totalScore).toBeCloseTo(1.7, 10);
    });

    it('positional full + accelerometer만 → 1.4 < 1.6 → reject', () => {
      const positionTrain = makeNearestResult('chungmuro', 0.05);
      const result = weightedVoteFusion({
        wifiStation: null,
        positionTrainResult: positionTrain,
        arrival: arrivalLine3,
        cellularEnvironmentVote: 'surface-weak',
        accelerometerPattern: 'automotive',
      });
      expect(result.accepted).toBe(false);
      expect(result.totalScore).toBeCloseTo(1.4, 10);
    });
  });
});
