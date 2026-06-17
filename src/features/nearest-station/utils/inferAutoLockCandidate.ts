/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * SSOT consensus + stability buffer + direction verify 3개 게이트 결과를 받아 device-side
 * auto-lock candidate를 산출. 본 PR은 측정만 — useBoardingLockStore.createLock 호출도, backend
 * `/boarding-lock/sync` 발사도 없다. PR-AutoLock-2가 결과를 lock 산출에 연결.
 *
 * 입력 결합 정의:
 *   1) SSOT 게이트: surface 또는 underground 중 적어도 하나의 consensus가 활성 (둘 다 활성이면
 *      surface 우선 — 지상 GPS+Arrival이 가장 신뢰도 높은 신호).
 *   2) Stability 게이트: consensusStabilityBuffer가 N=3 이상 동일 stationId 합의 (stable=true).
 *   3) Direction 게이트: verifyTrainDirection이 route의 destination 쪽 방향과 일치 확인.
 *
 * 모든 게이트 통과 시 `DeviceAutoLockCandidate` 반환. 셋 중 하나라도 미달이면 null.
 *
 * `DeviceAutoLockCandidate`는 backend가 발급하는 기존 `AutoLockCandidate` (boardingLockSync.ts)와
 * 의미가 분리된다:
 *   - 기존: backend cron이 9-AND 게이트 통과 후 발급한 candidate. response payload type.
 *   - 본 type: device가 Tier 1 SSOT 직접 잡고 산출한 측정 후보. PR-AutoLock-2에서 sync payload에
 *     `source: 'device-ssot'`로 노출 예정.
 * 호환을 위해 내부에 기존 `AutoLockCandidate`를 그대로 포함하고(`candidate` 필드), 메타데이터
 * 필드(source/stationId)는 본 type에만 있다.
 */

import { lineToSubwayId } from '../../../shared/constants/lineApiNames';
import type { AutoLockCandidate } from '../api/boardingLockSync';
import type { Station } from '../../../shared/types/station';

/** 측정 인프라가 채택한 candidate의 source 라벨. PR-AutoLock-2 sync payload와 정합. */
export type DeviceAutoLockSource = 'device-ssot';

export interface DeviceAutoLockCandidate {
  /** Backend `AutoLockCandidate`와 동일 형태 — PR-AutoLock-2에서 sync payload에 그대로 전달. */
  candidate: AutoLockCandidate;
  /** PR-AutoLock-2 sync payload `source` 필드. 본 PR에서는 측정 라벨로만 사용. */
  source: DeviceAutoLockSource;
  /** SSOT가 합의한 stationId — DebugModal/메트릭에서 stable_match 시각화용. */
  stationId: string;
}

export interface InferAutoLockCandidateInput {
  /** surfaceSSOTConsensus 결과. null이면 surface 경로 미충족. */
  surfaceSSOT: { station: Station; trainCode: string } | null;
  /** undergroundSSOTConsensus 결과. null이면 underground 경로 미충족. */
  undergroundSSOT: { station: Station; trainCode: string } | null;
  /** consensusStabilityBuffer.push().stable. */
  stabilityStable: boolean;
  /** verifyTrainDirection.matched. */
  directionMatched: boolean;
}

function buildCandidate(
  ssot: { station: Station; trainCode: string },
): DeviceAutoLockCandidate | null {
  const subwayId = lineToSubwayId(ssot.station.line);
  /* istanbul ignore next -- LineNumber 모두 LINE_TO_SUBWAY_ID에 등록. valid 입력 하에서 미도달. */
  if (!subwayId) return null;
  return {
    candidate: { trainCode: ssot.trainCode, line: ssot.station.line, subwayId },
    source: 'device-ssot',
    stationId: ssot.station.id,
  };
}

export function inferAutoLockCandidate(
  input: InferAutoLockCandidateInput,
): DeviceAutoLockCandidate | null {
  const { surfaceSSOT, undergroundSSOT, stabilityStable, directionMatched } = input;
  if (!stabilityStable) return null;
  if (!directionMatched) return null;
  // surface 우선 — GPS+Arrival 직접 신호가 가장 신뢰도 높음.
  if (surfaceSSOT) return buildCandidate(surfaceSSOT);
  if (undergroundSSOT) return buildCandidate(undergroundSSOT);
  return null;
}
