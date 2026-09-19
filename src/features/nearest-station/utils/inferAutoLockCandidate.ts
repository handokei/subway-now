/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 * #1526 — 출발역 stability 추출 보강 (boardingPrompt 0건 회귀 fix).
 *
 * SSOT consensus + stability buffer + direction verify 3개 게이트 결과를 받아 device-side
 * auto-lock candidate를 산출. 본 모듈은 측정만 — useBoardingLockStore.createLock 호출도, backend
 * `/boarding-lock/sync` 발사도 없다. PR-AutoLock-2가 결과를 lock 산출에 연결.
 *
 * 입력 결합 정의 (#1526 이후):
 *   1) SSOT 게이트: surface 또는 underground 중 적어도 하나의 consensus가 활성 (둘 다 활성이면
 *      surface 우선 — 지상 GPS+Arrival이 가장 신뢰도 높은 신호).
 *   2) Stability 게이트: consensusStabilityBuffer가 N=3 이상 동일 stationId 합의 (stable=true).
 *   3) Direction 게이트: verifyTrainDirection.matched=true 또는 출발역 예외 적용.
 *
 * 출발역 예외 (#1526):
 *   - direction reason이 `no-route` / `no-terminal` (= 진행 방향을 판정 불가 — 사용자가 route를
 *     설정하지 않았거나 arrival terminal이 비어 있는 trip 등록 직후 상태) 이고,
 *   - stability count가 `DEPARTURE_STRONG_STABILITY_THRESHOLD` (=5) 이상이면 (= 동일 station에
 *     5폴 이상 합의 = N=3 threshold의 ~1.7x. false consensus가 5회 연속 같은 station을 가리킬
 *     확률 매우 낮음),
 *   candidate 산출을 허용한다. 출발역은 정의상 "아직 한 칸도 advance 안 한" 상태로, route 미설정
 *   trip에서 direction을 판정할 신호 자체가 없다. 이 경계 케이스에서 SSOT+stability만으로
 *   boardingPrompt evidence를 생성해야 7일 누적 0건 회귀가 해소된다.
 *
 *   `reverse` / `terminal-out-of-route` (= 실제로 잘못된 방향)은 출발역 예외에서도 reject —
 *   judge-impossible과 judge-wrong은 의미가 다르다.
 *
 * `DeviceAutoLockCandidate`는 backend가 발급하는 기존 `AutoLockCandidate` (boardingLockSync.ts)와
 * 의미가 분리된다:
 *   - 기존: backend cron이 9-AND 게이트 통과 후 발급한 candidate. response payload type.
 *   - 본 type: device가 Tier 1 SSOT 직접 잡고 산출한 측정 후보. PR-AutoLock-2에서 sync payload에
 *     `source: 'device-ssot'`로 노출 예정.
 * 호환을 위해 내부에 기존 `AutoLockCandidate`를 그대로 포함하고(`candidate` 필드), 메타데이터
 * 필드(source/stationId/path)는 본 type에만 있다.
 */

import { lineToSubwayId } from '../../../shared/constants/lineApiNames';
import type { AutoLockCandidate } from '../api/boardingLockSync';
import type { Station } from '../../../shared/types/station';
import type { VerifyTrainDirectionReason } from './verifyTrainDirection';

/** 측정 인프라가 채택한 candidate의 source 라벨. PR-AutoLock-2 sync payload와 정합. */
export type DeviceAutoLockSource = 'device-ssot';

/**
 * #1526 — 출발역 strong-stability 예외에 필요한 최소 count.
 * threshold=3(stable=true)의 ~1.7x. 5회 연속 동일 station 합의 = N=3 majority vote 통과 + 추가 2폴
 * 재확인. 5폴 ≈ 150s (30s 폴링 기준) — trip 등록 후 첫 1~3 cycle transitional state를 넘어선 시점.
 */
export const DEPARTURE_STRONG_STABILITY_THRESHOLD = 5;

/**
 * #1526 — candidate 채택 path 라벨. 측정/디버깅 시 어느 경로로 lock 후보가 산출되었는지 추적.
 *  - `direction-matched`: verifyTrainDirection.matched=true (기존 경로, 정상 progressing).
 *  - `departure-strong-stability`: direction judge-impossible + stability count ≥ THRESHOLD
 *    (출발역 예외 — boardingPrompt 0건 회귀 대응).
 */
export type DeviceAutoLockPath = 'direction-matched' | 'departure-strong-stability';

export interface DeviceAutoLockCandidate {
  /** Backend `AutoLockCandidate`와 동일 형태 — PR-AutoLock-2에서 sync payload에 그대로 전달. */
  candidate: AutoLockCandidate;
  /** PR-AutoLock-2 sync payload `source` 필드. 본 모듈에서는 측정 라벨로만 사용. */
  source: DeviceAutoLockSource;
  /** SSOT가 합의한 stationId — DebugModal/메트릭에서 stable_match 시각화용. */
  stationId: string;
  /** #1526 — 채택 path. 출발역 예외 발동 여부 추적용. */
  path: DeviceAutoLockPath;
}

export interface InferAutoLockCandidateInput {
  /** surfaceSSOTConsensus 결과. null이면 surface 경로 미충족. */
  surfaceSSOT: { station: Station; trainCode: string } | null;
  /** undergroundSSOTConsensus 결과. null이면 underground 경로 미충족. */
  undergroundSSOT: { station: Station; trainCode: string } | null;
  /** consensusStabilityBuffer.push().stable. */
  stabilityStable: boolean;
  /**
   * #1526 — consensusStabilityBuffer.push().count. 출발역 strong-stability 예외 판정용.
   * 기본 stability 게이트(stable=true)와 추가 count 임계를 별도 평가한다.
   */
  stabilityCount: number;
  /** verifyTrainDirection.matched. */
  directionMatched: boolean;
  /**
   * #1526 — verifyTrainDirection.reason. 출발역 judge-impossible 케이스
   * (`no-route` / `no-terminal`) 판별용. matched=false여도 reason이 judge-impossible이면
   * strong-stability 예외 적용 가능.
   */
  directionReason: VerifyTrainDirectionReason | null;
}

/**
 * #1526 — `no-route` / `no-terminal`은 "방향을 판정할 신호 자체가 없는" 상태.
 * `reverse` / `terminal-out-of-route`는 "판정 결과가 잘못된 방향"이므로 strong-stability에서도 reject.
 */
function isDirectionJudgeImpossible(reason: VerifyTrainDirectionReason | null): boolean {
  return reason === 'no-route' || reason === 'no-terminal';
}

function buildCandidate(
  ssot: { station: Station; trainCode: string },
  path: DeviceAutoLockPath,
): DeviceAutoLockCandidate | null {
  const subwayId = lineToSubwayId(ssot.station.line);
  /* istanbul ignore next -- LineNumber 모두 LINE_TO_SUBWAY_ID에 등록. valid 입력 하에서 미도달. */
  if (!subwayId) return null;
  return {
    candidate: { trainCode: ssot.trainCode, line: ssot.station.line, subwayId },
    source: 'device-ssot',
    stationId: ssot.station.id,
    path,
  };
}

export function inferAutoLockCandidate(
  input: InferAutoLockCandidateInput,
): DeviceAutoLockCandidate | null {
  const {
    surfaceSSOT,
    undergroundSSOT,
    stabilityStable,
    stabilityCount,
    directionMatched,
    directionReason,
  } = input;
  if (!stabilityStable) return null;

  // 기본 경로: direction matched면 그대로 통과.
  // 출발역 예외 (#1526): direction judge-impossible + stability count >= THRESHOLD면 통과.
  let path: DeviceAutoLockPath;
  if (directionMatched) {
    path = 'direction-matched';
  } else if (
    isDirectionJudgeImpossible(directionReason) &&
    stabilityCount >= DEPARTURE_STRONG_STABILITY_THRESHOLD
  ) {
    path = 'departure-strong-stability';
  } else {
    return null;
  }

  // surface 우선 — GPS+Arrival 직접 신호가 가장 신뢰도 높음.
  if (surfaceSSOT) return buildCandidate(surfaceSSOT, path);
  if (undergroundSSOT) return buildCandidate(undergroundSSOT, path);
  return null;
}
