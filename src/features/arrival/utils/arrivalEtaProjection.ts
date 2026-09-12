import type { ArrivalInfo } from '../api/arrivalApi';
import type { Station } from '../../../shared/types/station';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';

/**
 * ADR-008 ② ArrivalEtaStrategy의 순수 함수 코어 (Stage 2, #740).
 *
 * Live position이 stale일 때, 다음 역의 도착 정보(`realtimeStationArrival`)에서
 * `trainCode === input.trainCode`인 row를 골라 `arrivalSeconds`로 실측 ETA를 얻고,
 * `arrivalCode`로 현재역 인덱스를 정밀 판정한다.
 *
 * 90초 추측 적분(HOP_TIME_MS)을 사용하지 않는다 — 실제 API가 제공하는 ETA만 신뢰.
 *
 * 디코딩 (`src/constants/arrivalCodes.ts`와 일치):
 *  - PREV_ARRIVED(5): 열차가 전역까지 도착 — 현재 추정 인덱스 유지 (열차가 currentIdx에 있음)
 *  - ENTERING(0):     열차가 다음 역으로 진입 중 — currentIdx + 1
 *  - ARRIVED(1):      열차가 다음 역에 도착 — currentIdx + 1
 *  - 그 외(2/3/4/99/-1): 위치 신호로 부적합 → null
 *
 * Strategy 합성은 Stage 1(#739)의 `stationProgressEstimator`에서 수행한다.
 * 이 모듈은 순수 함수만 제공한다.
 */

export interface ArrivalEtaProjectionInput {
  /** 다음 역(arcStations[currentIdx + 1])의 ArrivalInfo 목록. */
  arrivals: readonly ArrivalInfo[];
  /** lock.trainCode — 매칭 대상 열차 식별자. */
  trainCode: string;
  /** 현재 추정 인덱스 (arcStations 내). */
  currentIdx: number;
  /** 경로 arc 역 목록. */
  arcStations: readonly Station[];
  /** 현재 시각 (epoch ms). */
  nowMs: number;
  /**
   * 신선도 임계. `nowMs - receivedAtMs > ttlMs`면 stale row로 스킵.
   *
   * 계약 차이: Strategy ①(LivePosition)은 호출자가 게이트 통과 신호만 non-null로 넘기는
   * 외부 필터 계약인 반면, ②는 raw arrivals 배열을 받아 row별 내부 필터링을 수행한다 —
   * arrival API row가 trainCode 섞여 들어오므로 row 단위 검사가 자연스럽다.
   */
  ttlMs: number;
}

export interface ArrivalEtaProjectionResult {
  /** arcStations 내 추정 인덱스. */
  index: number;
  /** index에 해당하는 역. */
  station: Station;
  /** 매칭 row의 `arrivalSeconds` (다음 역까지 남은 초). */
  etaSeconds: number;
  /** 신호 출처 라벨. estimator 합성 단에서 confidence 매핑에 사용. */
  source: 'arrival-eta';
}

/**
 * `arrivalCode`가 위치 신호로 사용 가능하면 그에 따른 인덱스 오프셋을 반환한다.
 *  - PREV_ARRIVED(5) → 0 (currentIdx 유지 — 열차가 currentIdx 직전 도착)
 *  - ENTERING(0) / ARRIVED(1) → 1 (다음 역 이동 확정)
 *  - 그 외(DEPARTED/PREV_DEPARTED/PREV_ENTERING/RUNNING) → null
 *
 * PREV_ENTERING(4) 의도적 null: 의미상 currentIdx+0가 타당하지만, "전역 진입" 신호는
 * 다음 hop으로 곧 바뀔 transient 상태라 적용 시점이 모호하다. 명확히 확정되는 코드(0/1/5)만
 * 위치 신호로 사용 — 후속 stage에서 ETA seconds까지 결합할 때 재평가 (보수적 정책).
 */
function decodeIndexOffset(arrivalCode: number): number | null {
  if (arrivalCode === ARRIVAL_CODE.PREV_ARRIVED) return 0;
  if (arrivalCode === ARRIVAL_CODE.ENTERING) return 1;
  if (arrivalCode === ARRIVAL_CODE.ARRIVED) return 1;
  return null;
}

/**
 * `arrival` row가 (1) 지정 trainCode 매칭, (2) 신선도 통과, (3) 디코딩 가능한
 * arrivalCode인지 확인한다. 적격이면 인덱스 오프셋을, 아니면 null을 반환.
 */
function evaluateRow(
  arrival: ArrivalInfo,
  trainCode: string,
  nowMs: number,
  ttlMs: number,
): number | null {
  if (arrival.trainCode !== trainCode) return null;
  // receivedAtMs === 0은 mock/누락 컨벤션 (parseRecptnDt). 항상 stale로 취급.
  if (arrival.receivedAtMs <= 0) return null;
  if (nowMs - arrival.receivedAtMs > ttlMs) return null;
  return decodeIndexOffset(arrival.arrivalCode);
}

export function projectArrivalEtaStation(
  input: ArrivalEtaProjectionInput,
): ArrivalEtaProjectionResult | null {
  const { arrivals, trainCode, currentIdx, arcStations, nowMs, ttlMs } = input;

  if (arcStations.length === 0) return null;
  if (currentIdx < 0 || currentIdx >= arcStations.length) return null;

  for (const arrival of arrivals) {
    const offset = evaluateRow(arrival, trainCode, nowMs, ttlMs);
    if (offset === null) continue;
    // 종착 경계: currentIdx + 1이 arc 밖이면 마지막 인덱스로 cap.
    const lastIdx = arcStations.length - 1;
    const index = Math.min(currentIdx + offset, lastIdx);
    return {
      index,
      station: arcStations[index],
      etaSeconds: arrival.arrivalSeconds,
      source: 'arrival-eta',
    };
  }

  return null;
}
