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
 *   - 'arvlcd-arrived'    ← lockedTrainCode 매칭 row의 arvlCd가 ARRIVED|ENTERING이면 true
 *
 * unavailable 정책:
 *   - barometer.stop=undefined → fusion 입력에서 키 자체 생략 (signalsAvailable 감소, 다른 신호로
 *     합의 가능).
 *   - motionStationary=undefined → 동일.
 *   - arrival=null 또는 lockedTrainCode=null → arvlcd-arrived 키 생략.
 *
 * 본 hook은 순수 변환 — 부수 효과 없음. render마다 동기 계산.
 */

import { useMemo } from 'react';
import {
  STATION_DETECTION_SIGNALS,
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

/**
 * arvlcd-arrived 신호 평가.
 *
 * - arrival 또는 lockedTrainCode 부재 → undefined (unavailable).
 * - row 매칭 없음(아직 응답에 안 들어옴) → undefined (unavailable).
 * - row.arrivalCode가 ARRIVED|ENTERING → true.
 * - 그 외(출발/전역/운행중) → false (명시 미합의).
 */
export function evaluateArvlcdArrivedSignal(
  arrival: StationArrival | null,
  lockedTrainCode: string | null | undefined,
): boolean | undefined {
  if (arrival === null || lockedTrainCode == null) return undefined;
  const all: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  const row = all.find((r) => r.trainCode === lockedTrainCode);
  if (row === undefined) return undefined;
  return (
    row.arrivalCode === ARRIVAL_CODE.ARRIVED ||
    row.arrivalCode === ARRIVAL_CODE.ENTERING
  );
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
 * #963 — fusion 신호 조합의 안정 식별자. unavailable까지 구분해서 인코딩한다.
 *
 * 인코딩: STATION_DETECTION_SIGNALS 순서대로 각 신호를 `T`(true) / `F`(false) / `U`(unavailable)
 * 문자 하나로 합친 고정 길이 문자열. 신호 추가 시 STATION_DETECTION_SIGNALS 갱신만으로 길이가
 * 자연스럽게 늘어난다.
 *
 * 용도: `useFusedNearestStation`의 fusionDebugBuffer dedup key에 포함시켜 같은 station에서
 * 신호 조합 변화(예: motion stationary flip, barometer subsurface flip)도 별도 entry로 보존.
 * P1.2 follow-up (PR #944 본문 참고) — decisionKey가 source/confidence/stationId만 비교해
 * 신호 변화가 측정 데이터에서 누락되던 버그 수정.
 */
export function buildFusionSignalMask(input: StationDetectionSignalInput): string {
  let mask = '';
  for (const name of STATION_DETECTION_SIGNALS) {
    const value = input[name];
    if (value === undefined) {
      mask += 'U';
    } else if (value) {
      mask += 'T';
    } else {
      mask += 'F';
    }
  }
  return mask;
}

/**
 * 신호 입력 → fusion verdict + signal mask. 입력 reference가 동일하면 동일 결과 캐시.
 *
 * signalMask는 호출자(useFusedNearestStation)의 측정 dedup key에 포함되어 신호 조합 변화도
 * entry로 보존한다 (#963).
 */
export function useFusedStationDetection(
  input: FusedStationDetectionInput,
): StationDetectionVerdict & { readonly signalMask: string } {
  return useMemo(() => {
    const signalInput = buildFusionSignalInput(input);
    const verdict = fuseStationDetectionSignals(signalInput);
    return { ...verdict, signalMask: buildFusionSignalMask(signalInput) };
  }, [input]);
}
