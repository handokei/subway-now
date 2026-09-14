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
 * "정말 그 역(또는 직전 hop)에 있고, 최근(cron 2 cycle 이내, #2602) advance evidence 가 있다"
 * 둘 다 통과해야만 발사한다 (시간 적분 false advance 차단 — issue 본문 §검증 N9/N10 회귀 박제).
 *
 * 본 모듈은 **순수 게이트 함수**만 정의한다 — caller(scheduled.ts의 fire path들)가
 * `advanceTripPosition` 호출 직후 또는 직전에 본 게이트로 transfer/destination 발사 여부를
 * 추가 검증한다.
 *
 * 범위 (T7 본 PR)
 * ===============
 * - `isAtOrApproachingTransferDestination(ssot, trip, waypoint)` — SSoT.currentStationId가
 *   transfer/destination waypoint 또는 직전 1 hop(=trip.passedStations 마지막) 인지.
 * - `isSsotAdvanceRecent(ssot, now)` — 마지막 advance 이후 완료된 cron cycle 수 <= 2 (#2602 이산화).
 *   미 advance(0)는 dormant 통과.
 * - `evaluateTransferDestinationGate(ssot, trip, waypoint, now)` — 두 게이트 합성 + 사유 stamp.
 *
 * Out of scope
 * ============
 * - intermediate kind는 본 게이트를 통과하지 않는다 (T4/T5 6단 게이트로 충분).
 * - SSoT mutation X — 본 게이트는 read-only.
 * - payload.ssot field stamp 는 T8(#1561, 이미 머지)이 담당.
 */

import type { TripPositionSSoT } from './tripPositionSsot';
import type { Trip, Waypoint } from './types';

/**
 * cron 명목 주기 (ms). `scheduled.ts`의 `CRON_NOMINAL_INTERVAL_MS`(`wrangler.toml` `[triggers].crons`
 * = every 1 minute)와 동일 값 — 순환 import를 피하기 위해 본 모듈에 독립 상수로 둔다(#2602).
 */
export const CRON_INTERVAL_MS = 60_000;

/**
 * SSoT.lastAdvanceAt 신선도 판정을 시간창(ms)이 아니라 **cron cycle 수**로 이산화한 임계
 * (#2602). 마지막 advance 이후 완료된 cron cycle 수가 이 값 이하면 신선으로 판정한다.
 *
 * 배경: 기존 60s 시간창(`now - lastAdvanceAt <= 60_000`)은 cron 명목 주기(60s)와 **동일**해
 * 정상 hop(역 간 실제 간격 ~2분)조차 실행 ms 지터에 따라 통과/차단이 동전던지기로 갈렸다
 * (#2602 실캡처 재생 2건: 60,001ms 및 128,365ms 간격에서 각각 재현). cycle 수 이산화는 ms 단위
 * 지터에 무관 — `elapsedCronCycles`가 완료된 cycle 수만 카운트하므로 60,001ms 도 128,365ms 도
 * 모두 "2 cycle 이내"로 신선 판정된다.
 *
 * 정지 trip false advance 차단(issue 본문 §검증 N9 박제) 의미는 유지 — 실제로 멈춘 trip은 여러
 * cycle(3개 이상, 즉 >2×60s ≈ 3분+)이 advance 없이 누적돼야 하므로 여전히 차단된다.
 */
export const TRANSFER_DESTINATION_FRESH_CYCLES = 2;

/**
 * `elapsedMs` 동안 완료된 cron cycle 수 (floor). 예: 128,365ms → 2 (2×60,000ms=120,000ms 완료,
 * 3번째 cycle은 미완료).
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
}

/**
 * 본 게이트가 적용되는 waypoint kind 인지. intermediate 는 T4/T5 6단 게이트만으로 충분.
 */
export function isTransferOrDestination(
  waypoint: Pick<Waypoint, 'kind'>,
): waypoint is Waypoint & { kind: 'transfer' | 'destination' } {
  return waypoint.kind === 'transfer' || waypoint.kind === 'destination';
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
  const passed = trip.passedStations ?? [];
  if (passed.length === 0) return false;
  const lastPassed = passed[passed.length - 1];
  return ssot.currentStationId === lastPassed;
}

/**
 * SSoT.lastAdvanceAt이 신선(마지막 advance 이후 완료된 cron cycle 수가
 * `TRANSFER_DESTINATION_FRESH_CYCLES` 이하) 한지.
 *
 * lastAdvanceAt===0(미 advance, lazy-seed 직후)은 dormant 분기로 true 반환 — T4 motion 게이트가
 * 'unknown' 통과시키는 것과 같은 legacy 호환. 실 advance가 발생하면(`lastAdvanceAt > 0`) 본
 * cycle 수 검증이 활성화된다.
 */
export function isSsotAdvanceRecent(
  ssot: Pick<TripPositionSSoT, 'lastAdvanceAt'>,
  now: number,
): boolean {
  if (ssot.lastAdvanceAt === 0) return true;
  return elapsedCronCycles(now - ssot.lastAdvanceAt) <= TRANSFER_DESTINATION_FRESH_CYCLES;
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
 */
export function evaluateTransferDestinationGate(
  ssot: Pick<TripPositionSSoT, 'currentStationId' | 'lastAdvanceAt'>,
  trip: Pick<Trip, 'passedStations'>,
  waypoint: Pick<Waypoint, 'stationName' | 'kind'>,
  now: number,
  options?: { deviceSyncStale?: boolean },
): TransferDestinationGateOutcome {
  if (!isAtOrApproachingTransferDestination(ssot, trip, waypoint)) {
    return { pass: false, blockReason: 'ssot-not-at-or-approaching' };
  }
  if (!options?.deviceSyncStale && !isSsotAdvanceRecent(ssot, now)) {
    return { pass: false, blockReason: 'ssot-stale' };
  }
  return { pass: true };
}
