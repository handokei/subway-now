/**
 * #1884 (ADR-015 RC-3) — Weighted vote 4-signal fusion (Option A 채택 + D+A hybrid).
 *
 * 목적:
 *   `undergroundSSOTConsensus`의 2-of-N station-pair-required quorum이 lockless trip 지하
 *   환경에서 station pair가 끊기면 환경 vote(barometer/cellular/accel)가 아무리 강해도 station
 *   채택이 불가능해 26분 stuck 발생 (T3 충정로→용마산, 2026-06-26).
 *
 *   본 함수는 4 카테고리(positional/radio/motion/time)에 카테고리별 weight를 부여하고 같은
 *   station을 가리키는 신호의 weight를 합산. station 후보 점수와 환경 vote 합산이 임계를
 *   넘으면 accept — 신호 1개가 죽어도 나머지 신호로 진행 가능.
 *
 * 호출자:
 *   `undergroundSSOTConsensus` — 기존 quorum 미달 시 **fallback path**로 호출. 기존 path가
 *   먼저 시도되며 기존 통과 케이스는 동작 변경 없음. 본 함수는 기존 path가 null을 반환했을 때만
 *   진입 (surgical change, 회귀 zero).
 *
 * 신호 매핑 (paradigm taxonomy, `constants/fusion.ts`):
 *   - positional : `positionTrainResult` (track-1D 진행도), `wifiStation` (SSID 매칭).
 *                  underground 경로에서 GPS는 입력 reject 정책 유지.
 *                  arrival 호선 매칭 = full weight(1.0), 매칭 없음 = partial weight(0.6) —
 *                  arrival API 일시 실패에도 station 후보 유지하며 env vote와 합산 채택 허용.
 *   - radio      : `cellularEnvironmentVote === 'underground'` (환경 확정 vote).
 *                  'surface-weak'는 미투표 (호출자가 primary에서 envVotes −1로 처리 — #1876).
 *   - motion     : `accelerometerPattern === 'automotive'` (train 진동 fingerprint).
 *   - time       : `barometerStop === true` (dP/dt 정착 패턴).
 *
 * 환경 모순 reject (기존 정책 보존):
 *   `cellularEnvironmentVote === 'surface'` (NR SA, hard-reject) → vote 자체 불가. 본 함수 진입
 *   전에 호출자가 reject 처리 (기존 underground SSOT 첫 줄과 동일).
 *
 * D+A hybrid (#1876 cross-impact):
 *   `cellularEnvironmentVote === 'surface-weak'` (LTE/NRNSA, 지상 가능성) → 임계 1.1 → 1.6 상향.
 *   #1876 primary path `envVotes −1` 보수 처리 의도를 fallback에서도 보존. 강한 multi-source
 *   조합만 station 채택 허용. 자세히는 `STATION_ACCEPT_THRESHOLD_SURFACE_WEAK` 참고.
 *
 * 채택 임계 (기본 underground — `STATION_ACCEPT_THRESHOLD = 1.1`):
 *   - positional full(1.0) 단독 → 미달 reject (기존 steady quorum=2 정책 보존).
 *   - positional full(1.0) + 어떤 env vote ≥ 0.3 → 1.1 이상 accept (multi-source confirm).
 *   - positional partial(0.6) + env vote ≥ 0.5 → 1.1 이상 accept — T3 stuck 해소.
 *     예: position-train(arrival 미매칭, 0.6) + cellular underground(0.5) = 1.1 ✓.
 *   - positional partial(0.6) + time(0.3) 만 → 0.9 reject.
 *   - station 후보 0 → 항상 reject (env vote 누적이 아무리 커도) — A 옵션 가드.
 *
 * 채택 임계 (surface-weak — `STATION_ACCEPT_THRESHOLD_SURFACE_WEAK = 1.6`, D 옵션):
 *   - positional full(1.0) + barometer(0.3) = 1.3 → reject (단일 약 신호로는 부족).
 *   - positional full(1.0) + motion(0.4) + time(0.3) = 1.7 ≥ 1.6 → accept.
 *   - positional partial(0.6) + motion(0.4) + time(0.3) = 1.3 → reject.
 *
 * 데이터 주도(CLAUDE.md §3):
 *   - 신호별 평가는 `EVALUATORS` 배열 순회 — 신호 개수 하드코딩 X.
 *   - 새 신호 추가는 evaluator 객체 추가만으로 vote에 참여.
 *   - 환경별 임계는 `selectAcceptThreshold` 데이터 표 분기 — 새 환경 vote는 표에만 추가.
 */

import type { Station, NearestStationResult } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';
import type { CellularEnvironmentVote } from './cellularTech';
import type { AccelerometerPattern } from './accelerometerFingerprint';
import {
  FUSION_SIGNAL_WEIGHTS,
  STATION_ACCEPT_THRESHOLD,
  STATION_ACCEPT_THRESHOLD_SURFACE_WEAK,
  type FusionSignalCategory,
} from '../../../shared/constants/fusion';

/** arvlCd "정착한 위치 보고" 코드 집합 — underground/surface SSOT와 동일. */
const ARVL_CD_STATIONARY = new Set<number>([1, 2, 3, 5]);

/**
 * Arrival 매칭 없이 station 후보로 잡힌 positional 신호의 weight 비율.
 * Full weight(1.0) × 0.6 = 0.6. arrival API 일시 실패에도 station 후보를 유지하며 env vote와
 * 합산해 채택을 가능하게 한다. 0.6 + 0.5(radio) = 1.1 ≥ 임계 1.1 → accept.
 */
const POSITIONAL_NO_ARRIVAL_RATIO = 0.6;

export interface WeightedVoteInput {
  wifiStation: Station | null;
  positionTrainResult: NearestStationResult | null;
  arrival: StationArrival | null;
  barometerStop?: boolean | undefined;
  cellularEnvironmentVote?: CellularEnvironmentVote | undefined;
  accelerometerPattern?: AccelerometerPattern | undefined;
}

/**
 * Vote 결과 — 채택 station, 누적 점수, 신호별 contribution.
 * `accepted=false`인 경우에도 `winner`/`totalScore`는 진단용으로 노출 (DebugModal / Sentry).
 */
export interface WeightedVoteResult {
  accepted: boolean;
  /** 채택 station + trainCode. trainCode가 빈 문자열이면 arrival 미매칭 partial 후보 채택. */
  winner: { station: Station; trainCode: string } | null;
  /** 채택 winner station 점수 + 환경 vote 점수 합산. accept 결정 기준값. */
  totalScore: number;
  /**
   * 평가에 사용된 채택 임계. D+A hybrid(#1876)로 환경별 동적 — DebugModal 노출용.
   *   - 기본 (underground / unknown 등)        : 1.1
   *   - cellularEnvironmentVote='surface-weak' : 1.6
   */
  acceptThreshold: number;
  /**
   * 카테고리별 weight 기여 — DebugModal/Sentry breadcrumb용.
   * `contributed=false`는 신호 부재 or arrival 미매칭으로 weight 0 누적.
   * `effectiveWeight`는 weight × weightMultiplier — 실제 점수 기여분.
   */
  votes: ReadonlyArray<{
    category: FusionSignalCategory;
    weight: number;
    effectiveWeight: number;
    contributed: boolean;
    station: Station | null;
    trainCode: string | null;
  }>;
}

/**
 * Arrival에서 station 라인 매칭 + arvlCd 정착 row의 trainCode 추출. 미매칭 시 null.
 */
function findStationaryTrainCode(arrival: StationArrival | null, line: string): string | null {
  if (!arrival) return null;
  const allRows = [...arrival.up, ...arrival.down];
  for (const row of allRows) {
    if (row.line !== line) continue;
    if (!ARVL_CD_STATIONARY.has(row.arrivalCode)) continue;
    return row.trainCode;
  }
  return null;
}

/**
 * Evaluator — 카테고리별 신호 평가. 입력에서 카테고리 신호가 활성이면 station(있으면)과 함께
 * contribution 반환. 데이터 주도: 새 신호는 본 배열에 한 항목 추가.
 *
 * 카테고리당 1개 evaluator 원칙 — 같은 카테고리 내 여러 신호(예: positional의 position-train +
 * wifi)는 evaluator 내부에서 우선순위로 1개 station 선정.
 *
 * `weightMultiplier`로 부분 weight 표현:
 *   - 1.0 = full weight (categories 표 그대로).
 *   - 0.6 = arrival 미매칭 positional 신호 등 partial.
 *   - 0   = 미투표 (`contributed=false`와 동등 — 호출자가 weight 0 처리).
 */
interface CategoryEvaluator {
  category: FusionSignalCategory;
  evaluate(input: WeightedVoteInput): CategoryEvaluatorResult;
}

interface CategoryEvaluatorResult {
  contributed: boolean;
  /** Weight 곱셈 인수. arrival 매칭 등 부분 신호일 때 1.0 미만. */
  weightMultiplier: number;
  station: Station | null;
  trainCode: string | null;
}

const EVALUATORS: ReadonlyArray<CategoryEvaluator> = [
  {
    category: 'positional',
    evaluate(input) {
      // 우선순위: position-train > wifi-ssid (강 → 약).
      // arrival 매칭 시 full weight, 미매칭이어도 partial weight로 station 후보 유지.
      const { positionTrainResult, wifiStation, arrival } = input;
      if (positionTrainResult) {
        const trainCode = findStationaryTrainCode(arrival, positionTrainResult.station.line);
        if (trainCode !== null) {
          return {
            contributed: true,
            weightMultiplier: 1.0,
            station: positionTrainResult.station,
            trainCode,
          };
        }
        // arrival 미매칭 — partial weight로 후보 유지. trainCode 부재 표기 (호출자가 빈 문자열로 보존).
        return {
          contributed: true,
          weightMultiplier: POSITIONAL_NO_ARRIVAL_RATIO,
          station: positionTrainResult.station,
          trainCode: null,
        };
      }
      if (wifiStation) {
        const trainCode = findStationaryTrainCode(arrival, wifiStation.line);
        if (trainCode !== null) {
          return { contributed: true, weightMultiplier: 1.0, station: wifiStation, trainCode };
        }
        return {
          contributed: true,
          weightMultiplier: POSITIONAL_NO_ARRIVAL_RATIO,
          station: wifiStation,
          trainCode: null,
        };
      }
      return { contributed: false, weightMultiplier: 0, station: null, trainCode: null };
    },
  },
  {
    category: 'radio',
    evaluate(input) {
      // cellular `underground` vote → 환경 vote (station 정보 X).
      // `surface`는 호출자가 reject 처리(본 함수 진입 전), `unknown`/undefined는 미투표.
      const contributed = input.cellularEnvironmentVote === 'underground';
      return {
        contributed,
        weightMultiplier: contributed ? 1.0 : 0,
        station: null,
        trainCode: null,
      };
    },
  },
  {
    category: 'motion',
    evaluate(input) {
      // accelerometer `automotive` (RMS ≥ 2.0 m/s² 진동) = train 진행 환경 vote.
      // `stationary`/`walking`/`unknown` → 미투표.
      const contributed = input.accelerometerPattern === 'automotive';
      return {
        contributed,
        weightMultiplier: contributed ? 1.0 : 0,
        station: null,
        trainCode: null,
      };
    },
  },
  {
    category: 'time',
    evaluate(input) {
      // barometer `stop=true` (dP/dt 정착) = 정착 환경 vote.
      // `false` (이동 중)/undefined(warmup) → 미투표.
      const contributed = input.barometerStop === true;
      return {
        contributed,
        weightMultiplier: contributed ? 1.0 : 0,
        station: null,
        trainCode: null,
      };
    },
  },
];

/**
 * 환경별 채택 임계 표 — 데이터 주도(CLAUDE.md §3): 신규 환경 분기는 표에 한 줄 추가.
 *
 * 매칭 우선순위 = 배열 순서. 첫 매칭 항목의 threshold 사용.
 *   - 'surface-weak' (LTE/NRNSA, #1876 D+A hybrid) → 1.6 (강한 multi-source 강제).
 *   - 그 외 → 1.1 (기본 underground).
 */
const THRESHOLD_BY_ENV: ReadonlyArray<{
  matches(input: WeightedVoteInput): boolean;
  threshold: number;
}> = [
  {
    matches: (input) => input.cellularEnvironmentVote === 'surface-weak',
    threshold: STATION_ACCEPT_THRESHOLD_SURFACE_WEAK,
  },
];

/**
 * 환경 vote에 따른 채택 임계 선택. 매칭 실패 시 기본 `STATION_ACCEPT_THRESHOLD`.
 *
 * D+A hybrid(#1876): cellularEnvironmentVote='surface-weak'면 1.1 → 1.6 상향. 다른 환경은
 * 기본 1.1 유지. 신규 환경 분기는 `THRESHOLD_BY_ENV` 표 갱신만으로 추가.
 */
function selectAcceptThreshold(input: WeightedVoteInput): number {
  const hit = THRESHOLD_BY_ENV.find((entry) => entry.matches(input));
  return hit?.threshold ?? STATION_ACCEPT_THRESHOLD;
}

/**
 * Weighted vote 평가. 같은 station id의 weight를 합산, 최고점 station 선택. 환경 vote 점수와
 * 합산해 임계 이상이면 accept. station 후보 0이면 env 점수가 아무리 커도 reject.
 *
 * 환경 모순 reject: `cellularEnvironmentVote === 'surface'`는 호출자가 본 함수 진입 전에
 * reject 처리 (underground SSOT 첫 줄 정책).
 */
export function weightedVoteFusion(input: WeightedVoteInput): WeightedVoteResult {
  // station 점수 누적 — station id별 score / trainCode.
  const scoreByStation = new Map<
    string,
    { station: Station; trainCode: string; score: number }
  >();
  // 환경 vote 누적 (station 없음) — winner 점수에 합산해 임계 평가에 사용.
  let envScore = 0;
  const votes: WeightedVoteResult['votes'][number][] = [];

  for (const evaluator of EVALUATORS) {
    const baseWeight = FUSION_SIGNAL_WEIGHTS[evaluator.category];
    const result = evaluator.evaluate(input);
    const effectiveWeight = baseWeight * result.weightMultiplier;
    votes.push({
      category: evaluator.category,
      weight: baseWeight,
      effectiveWeight,
      contributed: result.contributed,
      station: result.station,
      trainCode: result.trainCode,
    });
    if (!result.contributed || effectiveWeight === 0) continue;

    if (result.station !== null) {
      // station 후보 — trainCode는 null(arrival 미매칭 partial)이면 빈 문자열 표기.
      // 현재 evaluator 구조에서 카테고리당 1개만 station을 반환하므로 stationId 충돌은 없음.
      // 새 카테고리가 station을 반환하도록 진화하면 여기서 score 합산 로직 추가 필요.
      const trainCode = result.trainCode ?? '';
      scoreByStation.set(result.station.id, {
        station: result.station,
        trainCode,
        score: effectiveWeight,
      });
    } else {
      envScore += effectiveWeight;
    }
  }

  // 채택 winner — 현재 evaluator 구조에서 station 후보는 카테고리당 1개(positional만 station 반환)
  // 이므로 Map에 0개 또는 1개. 새 카테고리가 station을 반환하도록 진화하면 최고 점수 선정 로직 추가.
  const winnerEntry = scoreByStation.values().next();
  const winner: { station: Station; trainCode: string; score: number } | null = winnerEntry.done
    ? null
    : winnerEntry.value;

  const acceptThreshold = selectAcceptThreshold(input);

  // station 후보 0 → 항상 reject (env vote 누적이 아무리 커도) — A 옵션 가드 명시.
  // 호출자(undergroundSSOTConsensus)가 station 채택 없이 SSOT 발사하는 사고 차단.
  if (winner === null) {
    return { accepted: false, winner: null, totalScore: envScore, acceptThreshold, votes };
  }

  // totalScore = winner station score + 환경 vote. 환경 기반 임계 이상이면 accept.
  // 기본(underground/unknown): 1.1. surface-weak(LTE/NRNSA): 1.6 — #1876 보수 정책 보존.
  const totalScore = winner.score + envScore;
  const accepted = totalScore >= acceptThreshold;

  return {
    accepted,
    winner: accepted ? { station: winner.station, trainCode: winner.trainCode } : null,
    totalScore,
    acceptThreshold,
    votes,
  };
}
