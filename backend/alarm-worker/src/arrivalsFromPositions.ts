/**
 * #1702 (B2-A) — Seoul OpenAPI arrivals 단방향/0건 시 realtimePosition fallback.
 *
 * 배경
 * ====
 * 2026-06-23 사용자 trip evidence: `fetchArrivals(합정 6호선)`이 한 방향(망원방면=상행)만 반환 →
 * 사용자 의도 방향(공덕방면=하행) train candidate 0건 → `pickAutoTrainCode`가 응암 방향
 * train(6184)만 lock → 잘못된 방향 lock → vanish fallback 도착 알림 mislabel.
 *
 * 본 모듈은 같은 line의 `realtimePosition` snapshot(이미 `selfPollPosition`이 cron 진입부에서
 * 호선당 1회 stamp)을 활용해 ArrivalEntry 를 합성한다. arrivals API 가 한 방향만 반환해도
 * positions API 는 호선의 양방향 전체 trains 를 반환하므로 missing direction 보강이 가능하다.
 *
 * 합성 정책
 * ========
 * 입력 positions 의 각 train 마다:
 *   1. direction 필터 — `direction='up'` → `isUp=true`, `'down'` → `isUp=false`, `null` → 양방향.
 *   2. segmentStations 위치 검증 — train.stationName 이 segmentStations 안에 있고, 그 인덱스가
 *      targetIndex 보다 작거나 같은 경우만 (아직 target 통과 X). 이미 target 지난 train(currentIdx
 *      > targetIdx) 은 제외.
 *   3. ETA 합성 — `(targetIdx - currentIdx) * HOP_SEC * 1000` ms (scheduled.ts:FALLBACK_HOP_SEC 와 동일).
 *   4. ArrivalEntry 합성 — `arvlCd=0` (ENTERING). 이는 `pickAutoTrainCode` 의 priority 우선순위에서
 *      2(출발) / 1(도착) 보다 낮아 real arrivals 가 같은 train 을 더 강한 신호로 표기하면 우선되도록.
 *      `subwayNm` 은 canonical line name 으로 합성 — `matchLine` cross-check 통과 보장.
 *
 * `arvlCd` 를 ENTERING(0) 으로 두는 이유
 * ====================================
 * positions API 의 trainSttus(0=진입/1=도착/2=출발) 는 train 위치 기준 신호로, 합성 ArrivalEntry
 * 의 도착 예측은 fallback 추정값이므로 가장 보수적인 ENTERING(0) 으로 통일한다. autoLock 의 RC1
 * confidence gate(arvlCd=2 branch)는 합성 entry 로는 트리거되지 않아 false positive 차단.
 *
 * 제한
 * ====
 * - positions 가 비어 있으면 빈 배열 반환 (caller 는 기존 schedule-based fallback 진행).
 * - segmentStations 가 비어 있으면 빈 배열 반환 (인덱스 산출 불가).
 * - `realtimePosition` API 가 호선 전체 trains 를 반환하므로 line 필터는 caller 의 책임 (caller 는
 *   target.line 의 positions 를 전달).
 */

import { pickAutoTrainCode } from './boardingPrompt';
import { canonicalLineName } from './lineAlias';
import type { ArrivalEntry, PositionEntry } from './seoul';

/**
 * hop 당 기본 소요(초). `scheduled.ts:FALLBACK_HOP_SEC` 와 동일 값을 사용해야 하지만,
 * `scheduled.ts → lockSwap.ts → arrivalsFromPositions.ts → scheduled.ts` 순환 import 를
 * 피하기 위해 본 모듈에서 별도 선언한다. 두 값은 항상 동일해야 한다 — `scheduled.ts` 의
 * `FALLBACK_HOP_SEC` 변경 시 본 상수도 동시에 갱신.
 */
const HOP_SEC = 90;

export interface SynthesizeArrivalsInputs {
  /** `selfPollPositions` 또는 `seoul.fetchPositions(line)` 결과 — line 의 모든 trains. */
  positions: readonly PositionEntry[];
  /** target waypoint 의 line — `subwayNm` 합성 + matchLine cross-check 용. */
  line: string;
  /** 사용자 진행 방향. null 이면 양방향 허용. */
  direction: 'up' | 'down' | null;
  /** trip leg 의 segmentStations (origin 포함) — train 위치 인덱스 산출 기반. */
  segmentStations: readonly string[];
  /** 합성 ETA 계산 기준 target station name. */
  targetStation: string;
}

/**
 * positions list 에서 ArrivalEntry 들을 합성. 합성 가능한 train 이 없으면 빈 배열 반환.
 *
 * 본 함수는 pure — KV/네트워크 의존 없음. caller 가 결과를 real arrivals 와 merge 해서
 * `pickAutoTrainCode` 에 전달한다.
 */
export function synthesizeArrivalsFromPositions(
  inputs: SynthesizeArrivalsInputs,
): ArrivalEntry[] {
  const { positions, line, direction, segmentStations, targetStation } = inputs;
  if (positions.length === 0 || segmentStations.length === 0) return [];

  const targetIdx = segmentStations.indexOf(targetStation);
  if (targetIdx < 0) return [];

  const subwayNm = canonicalLineName(line) ?? '';
  // canonical 매핑 누락 line (이론상 발생 X — caller 가 이미 subwayId 검증) 은 matchLine
  // 우회 위험이 있어 빈 배열 반환으로 자연 차단.
  if (!subwayNm) return [];

  const synthesized: ArrivalEntry[] = [];
  for (const train of positions) {
    // direction 필터.
    if (direction !== null) {
      const wantUp = direction === 'up';
      if (train.isUp !== wantUp) continue;
    }
    // segmentStations 위치 검증.
    const currentIdx = segmentStations.indexOf(train.stationName);
    if (currentIdx < 0) continue;
    // 이미 target 을 지난 train 은 제외.
    if (currentIdx > targetIdx) continue;
    // ETA 합성 — currentIdx === targetIdx 인 경우 (이미 target 역에 있음) arrivalSeconds=0.
    const hops = targetIdx - currentIdx;
    const arrivalSeconds = hops * HOP_SEC;
    synthesized.push({
      destination: '',
      arrivalSeconds,
      trainCode: train.trainCode,
      isUp: train.isUp,
      subwayNm,
      // ENTERING(0) — 보수적. priority 우선순위에서 가장 낮아 real arrivals 가 같은 train 을
      // 더 강한 신호로 표기하면 priority 가 우선됨.
      arvlCd: 0,
    });
  }
  return synthesized;
}

/**
 * `pickAutoTrainCode(realArrivals, ...)` 가 candidate 를 찾지 못한 경우 positions snapshot 으로
 * 합성 entry 를 만들어 retry 하는 helper.
 *
 * autoLock + lockSwap 두 caller 모두 동형 패턴 (real candidate 시도 → 실패 시 합성 retry) 을
 * 쓰므로 한 곳에 모아 SonarCloud duplication < 3% 유지.
 *
 * 반환:
 *   - `{ trainCode, arrivals }` — fallback 으로 채택한 trainCode + merged arrivals (caller 의
 *     subsequent `arrivals.find` 가 fallback 분기 entry 를 찾을 수 있도록 merged 를 노출).
 *   - `null` — positions 미전달 / 합성 0건 / 합성 후에도 ambiguity 등 → caller 는 기존 null 동작.
 */
export interface FallbackPickInputs {
  realArrivals: readonly ArrivalEntry[];
  positions: readonly PositionEntry[] | undefined;
  line: string;
  direction: 'up' | 'down' | null;
  segmentStations: readonly string[];
  targetStation: string;
}

export function pickFallbackTrainCodeFromPositions(
  inputs: FallbackPickInputs,
): { trainCode: string; arrivals: readonly ArrivalEntry[] } | null {
  const { realArrivals, positions, line, direction, segmentStations, targetStation } = inputs;
  if (!positions || positions.length === 0) return null;

  const synthesized = synthesizeArrivalsFromPositions({
    positions,
    line,
    direction,
    segmentStations,
    targetStation,
  });
  if (synthesized.length === 0) return null;

  // real arrivals 가 있는 경우 merge — real 의 arvlCd 우선순위(2/1/0) 가 자연 우선됨.
  // 같은 trainCode 가 양쪽에 있으면 real 우선 (synthesized 는 arvlCd=0 으로 보수적).
  const realCodes = new Set(realArrivals.map((a) => a.trainCode));
  const merged: readonly ArrivalEntry[] = [
    ...realArrivals,
    ...synthesized.filter((s) => !realCodes.has(s.trainCode)),
  ];
  const trainCode = pickAutoTrainCode(merged, line, direction);
  if (!trainCode) return null;
  return { trainCode, arrivals: merged };
}

/**
 * `pickAutoTrainCode` 시도 → 실패 시 `pickFallbackTrainCodeFromPositions` retry 의 결합 helper.
 *
 * autoLock + lockSwap 두 caller 가 동형으로 사용 (direction 만 다름) — duplication < 3% 유지를
 * 위해 한 곳에 모음. 반환된 `arrivals` 는 caller 가 chosen entry 의 subwayNm cross-check 등
 * subsequent verification 에 사용한다.
 *
 * 입력
 *   - realArrivals: `seoul.fetchArrivals(target.stationName)` 결과 (호출자 책임)
 *   - 그 외: pickFallbackTrainCodeFromPositions 와 동일.
 *
 * 반환
 *   - `{ trainCode, arrivals }` — real 또는 fallback 으로 결정된 candidate + 검증용 arrivals.
 *   - `null` — 양쪽 모두 실패. caller 는 기존 null 동작 진행.
 */
export interface ResolveTrainCodeInputs {
  realArrivals: readonly ArrivalEntry[];
  positions: readonly PositionEntry[] | undefined;
  line: string;
  direction: 'up' | 'down' | null;
  segmentStations: readonly string[];
  targetStation: string;
}

export function resolveTrainCodeWithFallback(
  inputs: ResolveTrainCodeInputs,
): { trainCode: string; arrivals: readonly ArrivalEntry[] } | null {
  const { realArrivals, line, direction } = inputs;
  const realCandidate =
    realArrivals.length > 0 ? pickAutoTrainCode(realArrivals, line, direction) : null;
  if (realCandidate) return { trainCode: realCandidate, arrivals: realArrivals };
  return pickFallbackTrainCodeFromPositions(inputs);
}
