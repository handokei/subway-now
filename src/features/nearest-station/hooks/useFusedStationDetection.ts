/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: fusion 알고리즘(shared)을 features 간(arrival·nearest-station·shared)
 * 신호를 모아 호출하는 보조 hook. useFusedNearestStation과 같은 orchestrator 카테고리. Phase 5
 * enforce 모드에서 file-level disable로 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration
 * 슬라이스로 추출해 disable 제거 예정.
 */
/**
 * #921 — 신호 fusion wire-up (B1 후속 PR).
 *
 * 알고리즘(`fuseStationDetectionSignals`)이 dormant 상태였던 것을 실제 호출자로 연결.
 * 본 hook 자체는 cascade에 영향을 주지 않는다 — verdict만 반환. 호출자(useFusedNearestStation)는
 * 디버그 entry에 첨부해 측정·튜닝 단계를 거친 뒤 후속 PR에서 cascade에 결합한다.
 *
 * 신호 변환 규약:
 *   - 'barometer-stop'    ← BarometerSignal.stop (undefined → unavailable)
 *   - 'motion-stationary' ← useMotionActivity()의 stationary boolean
 *   - 'arvlcd-arrived'    ← arrival 응답의 arvlCd 평가 (pre/post-boarding 모드 분기, #962):
 *       - lockedTrainCode != null (post-boarding): 매칭 row의 arvlCd가 ARRIVED|ENTERING이면 true.
 *           정확한 trainCode 매칭으로 false positive 가능성 낮음 (strong path).
 *       - lockedTrainCode == null (pre-boarding): up/down 어느 row든 arvlCd가 ARRIVED|ENTERING이면 true.
 *           아직 어떤 열차를 탔는지 모르는 단계 — "이 역에 어떤 열차든 들어오고 있다"는 약신호로
 *           사용. motion/barometer와 OR 결합되어야 합의(>=2) 도달 가능 — 단독으로는 detected 못 만듦.
 *
 * unavailable 정책:
 *   - barometer.stop=undefined → fusion 입력에서 키 자체 생략 (signalsAvailable 감소, 다른 신호로
 *     합의 가능).
 *   - motionStationary=undefined → 동일.
 *   - arrival=null → arvlcd-arrived 키 생략.
 *   - lockedTrainCode != null이면서 매칭 row 없음 → arvlcd-arrived 키 생략 (아직 응답에 row 미도착).
 *
 * 본 hook은 순수 변환 — 부수 효과 없음. render마다 동기 계산.
 */

import { useMemo } from 'react';
import {
  fuseStationDetectionSignals,
  type StationDetectionSignalInput,
  type StationDetectionVerdict,
} from '../../../shared/utils/stationDetectionFusion';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { BarometerSignal } from '../../../shared/hooks/useBarometer';

/**
 * 입력 신호 묶음. 각 신호는 unavailable(undefined / null)을 명시적으로 표현.
 */
export interface FusedStationDetectionInput {
  /** 기압계 stop 신호. undefined면 미지원/평가불가 → fusion 입력 미제공. */
  readonly barometer: BarometerSignal | null | undefined;
  /** CMMotionActivity stationary. undefined면 미지원 — fusion 입력 미제공. */
  readonly motionStationary: boolean | undefined;
  /** 현재 후보 역의 arrival 응답. null이면 미수신 — arvlcd-arrived 입력 미제공. */
  readonly arrival: StationArrival | null;
  /**
   * 사용자가 탭한 BoardingLock의 trainCode. arrival.up/down에서 같은 trainCode row를
   * 찾고 그 row의 arvlCd로 평가. null이면 잠근 열차 없음 — arvlcd 평가 skip.
   */
  readonly lockedTrainCode: string | null | undefined;
}

function isArrivedCode(code: ArrivalInfo['arrivalCode']): boolean {
  return code === ARRIVAL_CODE.ARRIVED || code === ARRIVAL_CODE.ENTERING;
}

/**
 * arvlcd-arrived 신호 평가. lockedTrainCode 존재 여부로 두 모드 분기 (#962).
 *
 * post-boarding (lockedTrainCode != null):
 *   - 매칭 row 없음 → undefined (unavailable, 아직 응답에 row 미도착).
 *   - 매칭 row의 arrivalCode가 ARRIVED|ENTERING → true.
 *   - 그 외 → false.
 *
 * pre-boarding (lockedTrainCode == null):
 *   - up/down 어느 row든 ARRIVED|ENTERING이면 true (약신호).
 *   - 그 외(rows 비어있음 포함) → false (명시 미합의).
 *
 * 공통: arrival === null → undefined (unavailable).
 *
 * pre-boarding 모드는 단독으로 detected 못 만듦 — fusion 알고리즘이 >=2 신호 합의를 요구하므로
 * motion-stationary / barometer-stop과 OR 결합되어야만 합의에 기여한다. 이것이 false positive
 * 방지 — pre-boarding 약신호가 다른 신호 없이 단독으로 detected를 만들지 않는다.
 */
export function evaluateArvlcdArrivedSignal(
  arrival: StationArrival | null,
  lockedTrainCode: string | null | undefined,
): boolean | undefined {
  if (arrival === null) return undefined;
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  if (lockedTrainCode == null) {
    return all.some((r) => isArrivedCode(r.arrivalCode));
  }
  const row = all.find((r) => r.trainCode === lockedTrainCode);
  if (row === undefined) return undefined;
  return isArrivedCode(row.arrivalCode);
}

/**
 * 입력 신호들을 fusion 알고리즘 입력 형태로 변환.
 *
 * 명시적으로 boolean이 아닌 신호는 키 자체를 입력에서 제외 — fusion이 signalsAvailable에서
 * 자동으로 감산한다.
 */
export function buildFusionSignalInput(
  input: FusedStationDetectionInput,
): StationDetectionSignalInput {
  const out: StationDetectionSignalInput = {};
  const stopSignal = input.barometer?.stop;
  if (stopSignal !== undefined) {
    out['barometer-stop'] = stopSignal;
  }
  if (input.motionStationary !== undefined) {
    out['motion-stationary'] = input.motionStationary;
  }
  const arvlcd = evaluateArvlcdArrivedSignal(input.arrival, input.lockedTrainCode);
  if (arvlcd !== undefined) {
    out['arvlcd-arrived'] = arvlcd;
  }
  return out;
}

/**
 * 신호 입력 → fusion verdict. 입력 reference가 동일하면 동일 verdict 캐시.
 */
export function useFusedStationDetection(
  input: FusedStationDetectionInput,
): StationDetectionVerdict {
  return useMemo(() => {
    const signalInput = buildFusionSignalInput(input);
    return fuseStationDetectionSignals(signalInput);
  }, [input]);
}
