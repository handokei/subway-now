/**
 * 지하(underground) Tier 1 SSOT 합의 판정.
 *
 * #1418 — 지하 GPS dead zone에서 WiFi SSID 또는 realtimePosition train 신호 + Arrival arvlCd 합의.
 *
 * #1574 (ADR-017 T11) — BG WiFi 갭 해소를 위한 4-signal 합의로 확장.
 *   - iOS BG에서 `NEHotspotNetwork.fetchCurrent`는 nil → WiFi pair 사실상 불가
 *   - Position-Train+Arrival 1-input에 의존 → 1 input 실패 시 합의 붕괴
 *   - Barometer `stop`(dP/dt 정착) + Cellular `underground` vote를 환경-확정 vote로 추가
 *
 * #1542 (ADR-016 S9) — CMMotionManager accelerometer fingerprint 환경 vote 추가.
 *   - V1 BG 지하 천장 70 → 90% (Transit App 90% / SubwayPS 학술 85% baseline)
 *   - patternClass='automotive' (RMS ≥ 2.0 m/s² 진동) = train 진행 신호 환경 vote 1표
 *
 * #1884 (ADR-015 RC-3, Option A) — Weighted vote 4-signal fusion fallback.
 *   - T3 trip 충정로→용마산 (lockless, 지하) 회귀: env-consensus-fail로 26분 stuck
 *   - 원인: lockless trip + 지하에서 station pair가 끊기면 (warmup 60s 이후) 2-of-N quorum
 *     달성 불가, env vote 누적도 station 채택 불가
 *   - 해결: 기존 quorum 미달 시 `weightedVoteFusion` fallback. positional(1.0/0.6) + radio(0.5)
 *     + motion(0.4) + time(0.3) 합산이 임계 1.1 이상이면 accept
 *   - "신호 1개 죽어도 진행" paradigm — backend silent push 없이 device가 자체 판정
 *
 * 합의 구조 — station-providing pair + environment-confirming vote:
 *   - Station pair (station 채택 가능, arrival 호선 매칭 필수):
 *       (a) WiFi SSID    + Arrival  (FG only — BG에선 SSID nil)
 *       (b) Position-Train + Arrival (FG/BG)
 *   - Environment vote (station 미제공, 환경 확정만):
 *       (c) Barometer `stop=true` (FG/BG) — #1574
 *       (d) Cellular `underground` vote (FG/BG) — #1574
 *       (e) Accelerometer `automotive` pattern (FG/BG, BG location piggyback) — #1542
 *
 * 합의 임계:
 *   - Primary path: 2-of-N 통과 시 SSOT 채택 (station pair + env vote 어떤 조합이든 OK)
 *   - 단, 채택 station이 필요하므로 station pair ≥ 1 필수 (env vote만 2개로는 불가)
 *   - Cellular `surface` vote 시 underground SSOT 자체 reject (환경 확정 모순)
 *   - GPS는 input set에서 reject (ADR-015 §5, backend `consensusGate.ts` 동일 정책)
 *   - Fallback path (#1884): primary 미달 시 weighted vote 임계 평가
 *
 * station 채택 우선순위: Position-Train > WiFi (강 → 약 신호).
 *
 * Backward-compat:
 *   - barometerStop/cellularEnvironmentVote/accelerometerPattern 미전달 → 기존 호출자 동작 유지
 *   - 단, 2-of-N quorum이 강화되어 단일 station pair만으로는 통과 불가 (의도된 tightening).
 *     기존 wifi-only / position-only 통과 케이스는 barometer/cellular/accelerometer 보강으로 회복.
 *   - Weighted vote fallback은 기존 통과 케이스를 깨지 않는다 (primary path가 먼저 시도).
 */

import type { NearestStationResult, Station } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';
import type { CellularEnvironmentVote } from './cellularTech';
import type { AccelerometerPattern } from './accelerometerFingerprint';
import { weightedVoteFusion } from './weightedVoteFusion';

/** arvlCd "정착한 위치 보고" 코드 집합. surfaceSSotConsensus와 동일 — 향후 공용 추출 여지. */
const ARVL_CD_STATIONARY = new Set<number>([1, 2, 3, 5]);

/** 2-of-N quorum 임계 — trip 안정화(60s 이후) 기본 임계. */
const CONSENSUS_QUORUM = 2;
/**
 * Warmup quorum — trip 시작 후 60s 이내 완화 임계.
 * station pair 단독 1개로 underground 채택 허용.
 * 이유: BG 첫 60s는 WiFi nil + arrival 미수렴 + barometer 미정착 상태로 quorum 달성 불가 → unknown 고착.
 */
const CONSENSUS_QUORUM_WARMUP = 1;
/** Warmup 윈도우 ms. */
const WARMUP_WINDOW_MS = 60_000;

export interface UndergroundSSOTInput {
  /** useWifiStation 매칭 결과. null이면 SSID 미매칭(또는 BG nil). */
  wifiStation: Station | null;
  /** trackTrainProgress 결과 (fusion 게이트 통과 후). null이면 position-train 신호 부재. */
  positionTrainResult: NearestStationResult | null;
  /** 채택 후보 station 매칭 슬롯의 arrival. null이면 arrival 신호 부재. */
  arrival: StationArrival | null;
  /**
   * #1574 — 기압계 `useBarometer().signal.stop`. 30s 윈도우 |dP|가 정착 임계 이하 = true.
   * undefined(평가 불가, warmup) → vote 미투표.
   * iOS BG에서도 동작 (NSMotionUsageDescription 1회로 충분).
   */
  barometerStop?: boolean | undefined;
  /**
   * #1574 — `useCellularTech()` 환경 vote (CTRadioAccessTechnology 분류).
   * 'surface'면 underground SSOT 자체 reject (환경 확정 모순).
   * 'underground'면 환경-확정 1표.
   * 'unknown'/undefined → vote 미투표.
   * iOS BG에서도 동작 (CTServiceRadioAccessTechnologyDidChangeNotification observer).
   */
  cellularEnvironmentVote?: CellularEnvironmentVote | undefined;
  /**
   * #1542 (ADR-016 S9) — CMMotionManager 60s window RMS magnitude 분류 결과.
   * 'automotive' (RMS ≥ 2.0 m/s² 진동 — train 진행)이면 환경-확정 1표 추가.
   * 'stationary' / 'walking' (정지/도보) → vote 미투표 (station 채택 신호 X, 환경 모순 X).
   * 'unknown'/undefined (60s window 미수렴, 미지원) → vote 미투표.
   * iOS BG에서도 동작 (Background Location piggyback으로 raw 가속도 수신).
   */
  accelerometerPattern?: AccelerometerPattern | undefined;
  /**
   * #1821 — trip 시작 Unix ms 타임스탬프. undefined이면 warmup 완화 미적용(steady 모드).
   * 첫 60s(WARMUP_WINDOW_MS) 이내 → CONSENSUS_QUORUM_WARMUP(1) 적용.
   * 60s 이후 또는 미전달 → CONSENSUS_QUORUM(2) 기본 임계 적용.
   */
  tripStartedAt?: number | undefined;
}

export interface UndergroundSSOT {
  station: Station;
  /** 합의 근거가 된 arrival row의 trainCode. */
  trainCode: string;
}

function findStationaryTrain(
  arrival: StationArrival | null,
  line: string,
): string | null {
  if (!arrival) return null;
  const allRows = [...arrival.up, ...arrival.down];
  for (const row of allRows) {
    if (row.line !== line) continue;
    if (!ARVL_CD_STATIONARY.has(row.arrivalCode)) continue;
    return row.trainCode;
  }
  return null;
}

export function undergroundSSOTConsensus(
  input: UndergroundSSOTInput,
  nowMs: number = Date.now(),
): UndergroundSSOT | null {
  const {
    wifiStation,
    positionTrainResult,
    arrival,
    barometerStop,
    cellularEnvironmentVote,
    accelerometerPattern,
    tripStartedAt,
  } = input;

  // 환경 확정 모순 — cellular가 surface면 underground SSOT 자체 candidate X.
  if (cellularEnvironmentVote === 'surface') return null;

  // Station pair 후보 — 채택 우선순위 순서. position-train > wifi.
  const stationPairs: Array<{ station: Station; trainCode: string }> = [];
  if (positionTrainResult) {
    const trainCode = findStationaryTrain(arrival, positionTrainResult.station.line);
    if (trainCode !== null) {
      stationPairs.push({ station: positionTrainResult.station, trainCode });
    }
  }
  if (wifiStation) {
    const trainCode = findStationaryTrain(arrival, wifiStation.line);
    if (trainCode !== null) {
      stationPairs.push({ station: wifiStation, trainCode });
    }
  }

  // Environment-confirming votes (station 미제공). 신규 #1574 — BG WiFi 갭 해소 + #1542 accelerometer.
  let envVotes = 0;
  if (barometerStop === true) envVotes += 1;
  if (cellularEnvironmentVote === 'underground') envVotes += 1;
  if (accelerometerPattern === 'automotive') envVotes += 1;

  // Warmup 60s 이내 → quorum=1 (station pair 단독 채택 허용). 60s 이후 → steady quorum=2.
  const isWarmup =
    tripStartedAt !== undefined && nowMs - tripStartedAt < WARMUP_WINDOW_MS;
  const quorum = isWarmup ? CONSENSUS_QUORUM_WARMUP : CONSENSUS_QUORUM;

  // Primary path — station pair ≥ 1 + (station pair + env vote) ≥ quorum.
  if (stationPairs.length >= 1 && stationPairs.length + envVotes >= quorum) {
    // station 채택: position-train > wifi (stationPairs는 우선순위 순서로 push됨).
    return stationPairs[0];
  }

  // #1884 (ADR-015 RC-3) — Fallback: weighted vote.
  // Primary 미달 시 카테고리별 weight 합산으로 station 채택 시도. positional 미매칭(arrival 부재)
  // 도 partial weight로 후보 유지하고 env vote와 합산해 임계(1.1)를 넘으면 accept.
  // 기존 통과 케이스는 primary에서 이미 return되었으므로 본 경로가 깨지 않는다.
  const voteResult = weightedVoteFusion({
    wifiStation,
    positionTrainResult,
    arrival,
    barometerStop,
    cellularEnvironmentVote,
    accelerometerPattern,
  });
  if (voteResult.accepted && voteResult.winner !== null) {
    return voteResult.winner;
  }

  return null;
}
