/**
 * transferDestinationGate — ADR-017 T7 (Epic #1553, Sub #1560).
 *
 * 배경
 * ====
 * 2026-06-19 evidence: 정지 trip + lock active + arvlcd ARRIVED → wrong "transfer imminent
 * 건대입구" 발사 (device `01:00:01 silent-push-received transfer imminent 건대입구`).
 *
 * T4(#1557)/T5(#1558)가 `advanceTripPosition` 단일 mutation 진입점으로 매역 station-passed
 * 발사를 6단 게이트로 통합했지만, **transfer / destination kind** 특별 변종은 추가 보강이
 * 필요하다 — 이들은 사용자가 의식적으로 환승/하차해야 하는 critical UX 순간이므로 SSoT가
 * "정말 그 역(또는 직전 hop)에 있고, 최근 advance evidence 가 있다" 둘 다 통과해야만 발사한다
 * (시간 적분 false advance 차단 — issue 본문 §검증 N9/N10 회귀 박제).
 *
 * 본 모듈은 **순수 게이트 함수**만 정의한다 — caller(scheduled.ts의 fire path들)가
 * `advanceTripPosition` 호출 직후 또는 직전에 본 게이트로 transfer/destination 발사 여부를
 * 추가 검증한다.
 *
 * 범위 (T7 본 PR)
 * ===============
 * - `isAtOrApproachingTransferDestination(ssot, trip, waypoint)` — SSoT.currentStationId가
 *   transfer/destination waypoint 또는 직전 1 hop(=trip.passedStations 마지막) 인지.
 * - `isSsotAdvanceRecent(ssot, now, maxFreshCycles)` — 마지막 advance 이후 완료된 cron cycle
 *   수 <= maxFreshCycles (#2602 이산화). 미 advance(0)는 dormant 통과.
 * - `evaluateTransferDestinationGate(ssot, trip, waypoint, now, options)` — 두 게이트 합성 +
 *   사유 stamp. `options.maxFreshCycles`로 evidence 강도별 관용치를 caller가 선택(#2602 리뷰).
 *
 * Out of scope
 * ============
 * - intermediate kind는 본 게이트를 통과하지 않는다 (T4/T5 6단 게이트로 충분).
 * - SSoT mutation X — 본 게이트는 read-only.
 * - payload.ssot field stamp 는 T8(#1561, 이미 머지)이 담당.
 */

import { CRON_INTERVAL_MS } from './cronConstants';
import type { TripPositionSSoT } from './tripPositionSsot';
import type { Trip, Waypoint } from './types';

/**
 * SSoT.lastAdvanceAt 신선도 판정을 시간창(ms)이 아니라 **cron cycle 수**로 이산화한 기본 임계
 * (#2602) — arvlCd 확증(ground truth 도착 신호) 또는 position 확증(직전 hop 일치) 경로 전용.
 * 마지막 advance 이후 완료된 cron cycle 수가 이 값 이하면 신선으로 판정한다.
 *
 * 배경: 기존 60s 시간창(`now - lastAdvanceAt <= 60_000`)은 cron 명목 주기(60s)와 **동일**해
 * 정상 hop(역 간 실제 간격 ~2분)조차 실행 ms 지터에 따라 통과/차단이 동전던지기로 갈렸다
 * (#2602 실캡처 재생 2건: 60,001ms 및 128,365ms 간격에서 각각 재현).
 *
 * 정직한 대수 (코드리뷰 항목2) — 이 값은 "진짜 cron 실행 횟수를 카운트"하지 않는다.
 * `elapsedCronCycles(elapsedMs) = Math.floor(elapsedMs / CRON_INTERVAL_MS)` 이므로
 * `elapsedCronCycles(elapsedMs) <= 2` 는 산술적으로 `elapsedMs < 3 × CRON_INTERVAL_MS =
 * 180,000ms` 와 완전히 동치인 **벽시계 창**이다("cycle"이라는 이름이 실제 cron 실행 시퀀스를
 * SSoT에 기록해 카운트한다는 착각을 주면 안 된다 — 그런 진짜 시퀀스 카운팅은 SSoT 스키마에
 * `lastCronSeq` 같은 필드를 추가해야 하는데, 확정된 razor-edge 문제(#2602 RCA)를 고치는 데는
 * 불필요한 과설계다). 60,001ms/128,365ms 둘 다 180,000ms보다 작아 신선 판정되고, 이 창이
 * cron 명목 주기(60s)의 3배라 실행 ms 지터(수 ms~수백 ms)에 대해 압도적으로 여유가 있다는
 * 점이 razor-edge를 해소하는 실질적 이유다.
 *
 * 잔여 경계 (180s) — Cloudflare cron이 이론적으로 2 사이클 연속 지연/스킵되면(예: 플랫폼
 * 장애) 이 180,000ms 벽시계 경계도 다시 razor-edge가 될 수 있다. 그러나 (1) 다음 정상 cycle이
 * 도착하면 SSoT가 즉시 갱신돼 자기치유(self-healing)되고, (2) 연속 2회 cron 스킵은 프로덕션
 * 실측 빈도가 극히 낮다 — 그래서 이 잔여 경계는 수용한다. 진짜 시퀀스 카운팅(SSoT에 cron 실행
 * 순번 stamp)으로 완전히 제거할 수 있지만, 그 전까지는 **field 재발 신호(같은 razor-edge 패턴이
 * D1/production에서 다시 관측)가 있을 때만** 승격 대상으로 삼는다 — 확정되지 않은 이론적 경계를
 * 선제적으로 스키마 변경까지 해서 막는 것은 과설계.
 */
export const TRANSFER_DESTINATION_FRESH_CYCLES = 2;

/**
 * vanish-fallback / vanish-release 경로(arvlCd 확증 없이 "trainCode 사라짐 + hop 시간 경과"
 * 만으로 통과를 추정하는 약한 evidence, `fireVanishFallbackStationPush`) 전용 관용치(#2602
 * 코드리뷰 항목1). 이 경로는 이미 position 확증 없이 시간 추정만으로 도착을 판단하므로, 여기에
 * `TRANSFER_DESTINATION_FRESH_CYCLES`(2, 위 벽시계 180,000ms)까지 겹치면 "약한 evidence + stale
 * 위치"가 겹친 복합 false-positive를 막지 못한다.
 *
 * 0은 `elapsedCronCycles(elapsedMs) <= 0 ⟺ elapsedMs < CRON_INTERVAL_MS(60,000ms)` — #2602
 * 이전 코드의 정확한 60,000ms 시간창과 (거의) 동일한 결과를 낸다. 유일한 차이는 정확히
 * 60,000ms 지점의 경계 처리(구 코드는 `<=` 로 포함해 pass, 본 값은 `<` 로 배제해 block)뿐이며,
 * 이는 약한 evidence 경로를 더 보수적으로 만드는 방향이라 허용한다(61,000~119,999ms 범위는
 * 구 코드와 동일하게 명확히 stale 차단 — 회귀 테스트로 박제).
 */
export const TRANSFER_DESTINATION_FRESH_CYCLES_VANISH = 0;

/**
 * `elapsedMs` 동안 완료된 cron cycle 수 (floor). 예: 128,365ms → 2 (2×60,000ms=120,000ms 완료,
 * 3번째 cycle은 미완료). 위 상수 주석의 "정직한 대수" 설명 참고 — `<= N` 비교는 항상
 * `elapsedMs < (N+1) × CRON_INTERVAL_MS` 벽시계 창과 동치다.
 */
function elapsedCronCycles(elapsedMs: number): number {
  return Math.floor(elapsedMs / CRON_INTERVAL_MS);
}

/**
 * 본 게이트가 차단한 사유. caller가 log meta로 stamp → production tail에서 분포 측정.
 *
 * 'ssot-stale'은 lastAdvanceAt 정의됐지만(>0) 윈도우 초과한 경우. lastAdvanceAt===0(미advance,
 * legacy/lazy-seed 직후)은 본 게이트가 dormant로 통과시킨다 — T4 motion 게이트의 'unknown' 통과
 * 정책과 동일 ([[advanceTripPosition.ts]] #2 게이트). 본 게이트가 stationary advance와 짝을 이루는
 * defense-in-depth이지 legacy 경로 차단 게이트가 아니기 때문.
 */
export type TransferDestinationBlockReason =
  | 'ssot-not-at-or-approaching'
  | 'ssot-stale';

export interface TransferDestinationGateOutcome {
  pass: boolean;
  blockReason?: TransferDestinationBlockReason;
  /**
   * 평가에 사용한 `trip.passedStations` 마지막 entry(#2602 코드리뷰 항목7) — pass/block 무관하게
   * 항상 채운다. caller(`buildTransferGateBlockMeta`)가 로그 meta를 조립할 때 이 값을 그대로
   * 재사용해, "게이트가 실제로 평가한 값"과 "로그에 찍힌 값"이 각자 따로 계산되어 어긋나는 것을
   * 구조적으로 방지한다.
   */
  lastPassed: string | undefined;
}

/**
 * 본 게이트가 적용되는 waypoint kind 인지. intermediate 는 T4/T5 6단 게이트만으로 충분.
 */
export function isTransferOrDestination(
  waypoint: Pick<Waypoint, 'kind'>,
): waypoint is Waypoint & { kind: 'transfer' | 'destination' } {
  return waypoint.kind === 'transfer' || waypoint.kind === 'destination';
}

/** `trip.passedStations`의 마지막 entry — 없으면 undefined. 평가/로그 양쪽이 공유하는 단일 계산. */
function lastPassedStation(trip: Pick<Trip, 'passedStations'>): string | undefined {
  const passed = trip.passedStations ?? [];
  return passed.length === 0 ? undefined : passed[passed.length - 1];
}

/**
 * SSoT.currentStationId가 target waypoint 의 stationName 또는 직전 1 hop(=trip.passedStations
 * 의 마지막 entry) 인지.
 *
 * 정상 흐름:
 *   - lock 활성 trip이 transfer waypoint에 도달하기 직전 → SSoT는 직전 hop에 stamp.
 *   - arvlcd ARRIVED → `advanceTripPosition` 통과로 SSoT.currentStationId = waypoint.stationName 로
 *     advance. 이 시점 직후 본 게이트가 다시 호출되더라도 "at" 분기로 통과.
 *
 * 차단 흐름:
 *   - SSoT.currentStationId가 transfer waypoint 도, 직전 hop 도 아닌 station(예: 정지 trip이
 *     시간 적분으로 cron이 transfer waypoint 발사를 시도하는데 SSoT는 한참 뒤에 있음) → 차단.
 *
 * passedStations 미존재 / 빈 배열인 경우 "직전 hop" 후보는 없음 → at-target 분기만 평가.
 */
export function isAtOrApproachingTransferDestination(
  ssot: Pick<TripPositionSSoT, 'currentStationId'>,
  trip: Pick<Trip, 'passedStations'>,
  waypoint: Pick<Waypoint, 'stationName'>,
): boolean {
  if (ssot.currentStationId === waypoint.stationName) return true;
  const lastPassed = lastPassedStation(trip);
  return lastPassed !== undefined && ssot.currentStationId === lastPassed;
}

/**
 * SSoT.lastAdvanceAt이 신선(마지막 advance 이후 완료된 cron cycle 수가 `maxFreshCycles`
 * 이하) 한지. `maxFreshCycles` 미지정 시 `TRANSFER_DESTINATION_FRESH_CYCLES`(arvlCd/position
 * 확증 경로 기본값).
 *
 * lastAdvanceAt===0(미 advance, lazy-seed 직후)은 dormant 분기로 true 반환 — T4 motion 게이트가
 * 'unknown' 통과시키는 것과 같은 legacy 호환. 실 advance가 발생하면(`lastAdvanceAt > 0`) 본
 * cycle 수 검증이 활성화된다.
 */
export function isSsotAdvanceRecent(
  ssot: Pick<TripPositionSSoT, 'lastAdvanceAt'>,
  now: number,
  maxFreshCycles: number = TRANSFER_DESTINATION_FRESH_CYCLES,
): boolean {
  if (ssot.lastAdvanceAt === 0) return true;
  return elapsedCronCycles(now - ssot.lastAdvanceAt) <= maxFreshCycles;
}

/**
 * 합성 게이트 — transfer/destination 발사 전 caller가 호출.
 *
 * @param ssot 현재 trip SSoT (caller가 `readSsot` 으로 fetch). null 이면 호출 X (caller 책임).
 * @param trip trip 객체 (passedStations 조회).
 * @param waypoint 발사 후보 waypoint. kind가 transfer/destination 아닌 경우 caller가 본 함수를
 *                 호출하지 않는다 (intermediate는 통과 정책).
 * @param now epoch ms.
 * @param options.deviceSyncStale #2321 (O1-B) — device sync stale(`isDeviceSyncStale`) 시 cycle
 *   신선도 검사(`isSsotAdvanceRecent`)를 dormant 전환한다. 이 cycle 임계는 "정지 trip이 cron
 *   wake-up만으로 시간 적분 도달"하는 false advance를 막기 위함(N9 회귀)이지, device가 정상
 *   suspend로 침묵한 사이 backend가 arvlCd ground truth로 자율 전진한 advance까지 stale 취급할
 *   의도는 아니었다 (#2306 RCA). `isAtOrApproachingTransferDestination`(position 일치)은
 *   staleness와 무관한 별도 안전장치로 그대로 유지.
 * @param options.maxFreshCycles #2602 코드리뷰 항목1 — evidence 강도별 관용치. 미지정 시
 *   `TRANSFER_DESTINATION_FRESH_CYCLES`(arvlCd/position 확증 경로). vanish-fallback/release
 *   (약한 evidence) 경로는 caller가 `TRANSFER_DESTINATION_FRESH_CYCLES_VANISH`를 명시 전달한다.
 */
export function evaluateTransferDestinationGate(
  ssot: Pick<TripPositionSSoT, 'currentStationId' | 'lastAdvanceAt'>,
  trip: Pick<Trip, 'passedStations'>,
  waypoint: Pick<Waypoint, 'stationName' | 'kind'>,
  now: number,
  options?: { deviceSyncStale?: boolean; maxFreshCycles?: number },
): TransferDestinationGateOutcome {
  const lastPassed = lastPassedStation(trip);
  if (!isAtOrApproachingTransferDestination(ssot, trip, waypoint)) {
    return { pass: false, blockReason: 'ssot-not-at-or-approaching', lastPassed };
  }
  if (
    !options?.deviceSyncStale &&
    !isSsotAdvanceRecent(ssot, now, options?.maxFreshCycles)
  ) {
    return { pass: false, blockReason: 'ssot-stale', lastPassed };
  }
  return { pass: true, lastPassed };
}

/**
 * transfer/destination gate 차단 로그의 meta 조립 (#2602 코드리뷰 항목6/7) — `scheduled.ts`의
 * 두 caller(arvlcd-fire / vanish-fallback-fire)가 복붙했던 동일 조립 로직을 여기 하나로 통합.
 * `outcome.lastPassed`를 그대로 사용해 게이트가 실제로 평가한 값과 로그값이 항상 일치한다.
 *
 * 기존 `ssotCurrent`/`ssotLastAdvanceAt` 필드는 `currentStationId`/`lastAdvanceAt`과 완전히
 * 동일한 값의 쌍둥이였다 — 중복 제거하고 신규 정보(lastPassed/lastAdvanceAtDeltaMs/
 * deviceSyncStale)만 추가한다.
 */
export function buildTransferGateBlockMeta(
  ssot: Pick<TripPositionSSoT, 'currentStationId' | 'lastAdvanceAt'>,
  outcome: Pick<TransferDestinationGateOutcome, 'lastPassed'>,
  deviceSyncStale: boolean,
  now: number,
): {
  currentStationId: string;
  lastPassed: string | undefined;
  lastAdvanceAt: number;
  lastAdvanceAtDeltaMs: number | undefined;
  deviceSyncStale: boolean;
} {
  return {
    currentStationId: ssot.currentStationId,
    lastPassed: outcome.lastPassed,
    lastAdvanceAt: ssot.lastAdvanceAt,
    lastAdvanceAtDeltaMs: ssot.lastAdvanceAt === 0 ? undefined : now - ssot.lastAdvanceAt,
    deviceSyncStale,
  };
}
