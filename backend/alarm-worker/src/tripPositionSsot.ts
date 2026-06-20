/**
 * TripPositionSSoT — ADR-017 foundation (Epic #1553, Sub #1554 / T1).
 *
 * 배경
 * ====
 * 2026-06-19 evidence: 정지 trip + lock active + arvlcd ARRIVED 상태가 `arvlcd-fire`와
 * `boarding-lock: waypoint advanced`를 분산된 fire path에서 독립 실행 → wrong "transfer
 * imminent" 발사. 본 모듈은 trip별 단일 state row(SSOT)를 정의해 T2(`advanceTripPosition`)
 * 단일 mutation 진입점이 6단 게이트로 advance를 결정하게 만드는 foundation이다.
 *
 * T1 스코프 (본 PR)
 * ================
 * - `TripPositionSSoT` 타입 + 보조 type (EvidenceType / EvidenceSource / MotionEvidence)
 * - KV CRUD helpers (`readSsot` / `writeSsot` / `deleteSsot`)
 * - `seedSsot()` — S1 GAP A의 backend 수신부 (trip 시작 시 currentStationId 정착)
 * - `pushMotionEvidence()` — ring buffer 50건 cap helper
 * - `migrateTripPassedStationsToSsot()` — S6 #1551의 `Trip.passedStations` → SSOT.passedStations
 *   read-only fallback (T7 이후 제거 예정)
 *
 * T1은 **새 게이트 추가도, 다른 fire path 변경도 하지 않는다**. 후속 T2~T8이 본 SSOT 위에
 * 게이트/머지/리더-only refactor를 쌓아간다.
 *
 * KV 설계
 * =======
 * - Key prefix: `ssot:<token>`
 * - cacheTtl: `CRON_READ_CACHE_TTL_SEC` (30s) — [[lesson_cron_cachettl_runtime_constraint]] 준수.
 *   Cloudflare KV는 `cacheTtl < 30` read를 throw하므로 helpers는 caller가 cacheTtl을 명시할
 *   때 `assertKvCacheTtl`로 floor 검증한다 (`trips.ts:getTrip`와 동일 패턴).
 * - Row 크기 관리: motionEvidence는 ring buffer로 50건 cap. 단일 row 예상 ≤5KB.
 *
 * schemaVersion
 * =============
 * 초기 값 1. 향후 SSOT 구조 변경 시 readSsot에서 마이그레이션 분기. 본 PR은 v1만 정의.
 */

import { assertKvCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';
import type { Trip } from './types';

/**
 * Motion evidence ring buffer cap. KV row 크기 폭주 방지 (단일 row ≤25MB CF KV 한도 대비
 * 여유 있게). 50건 초과 push 시 oldest entry FIFO eviction.
 */
export const MOTION_EVIDENCE_CAP = 50;

/** SSOT KV key prefix. */
const SSOT_PREFIX = 'ssot:';

/** SSOT KV row TTL 하한 — trip.expiresAt이 가까워도 최소 60s 보존 (trip TTL과 정합). */
const SSOT_MIN_TTL_SEC = 60;

/**
 * Trip별 advance 결정에 사용되는 evidence type.
 *
 * ADR-017 T2(`advanceTripPosition`) 6단 게이트가 `'time-only'`을 거부(ADR-015 E4 enforce).
 * 그 외 type은 합의 게이트(#3)에서 환경별로 가중치 평가.
 */
export type EvidenceType =
  | 'gps-displacement'
  | 'gps-stationary'
  | 'arvlcd-confirmed-train'
  | 'arvlcd-lockless'
  | 'position-train'
  | 'wifi-ssid-match'
  | 'cellular-tech-change'
  | 'accel-fingerprint'
  | 'time-only'
  | 'manual-user-intent'
  | 'seed-override';

/**
 * Evidence가 어느 데이터 출처에서 왔는지. T2 합의 게이트가 source 분산을 평가할 때 사용.
 */
export type EvidenceSource =
  | 'device-position'
  | 'seoul-arvlcd'
  | 'seoul-realtime-position'
  | 'device-wifi'
  | 'device-cellular'
  | 'device-accel'
  | 'device-user-intent'
  | 'cron-time';

/**
 * Motion state — `advanceTripPosition` 게이트 #2의 입력.
 *
 * - `'moving'`     : `/position` 수신부(T3)가 GPS displacement / speed sustained 확인.
 * - `'stationary'` : 5분 GPS displacement < 10m AND no arvlcd train-progress.
 * - `'unknown'`    : 보수적 보류. fire 허용하지 않음 (게이트 #2가 'moving'만 통과).
 */
export type MotionState = 'moving' | 'stationary' | 'unknown';

/**
 * 단일 motion evidence sample. T3 motion state machine이 ring buffer로 누적해 게이트 #2가
 * 합의로 motionState를 결정한다. `signal`은 type별 가변 payload(예: gps displacement m,
 * accel magnitude std)로 unknown — T2/T3가 type별 파싱.
 */
export interface MotionEvidence {
  source: EvidenceSource;
  ts: number;
  signal: unknown;
}

/**
 * #1534 (S1, ADR-016 / ADR-017 T9b) — backend가 추론한 lock 제안.
 *
 * 배경: lockless trip 등록 직후 backend가 GPS + arvlcd + trainCode 종합으로 origin/train을
 * 추론하면 device가 9-AND gate 통과를 기다리지 않고도 lock을 즉시 채택할 수 있다 (lockless
 * 첫 station miss 0 acceptance V2).
 *
 * 본 필드가 set되면 device `useLockSuggestion` reader가 본 값을 1순위로 채택. null이면
 * device는 기존 9-AND gate fallback으로 동작 (graceful, backward-compat).
 *
 * confidence:
 *   - 'high'   : arvlcd-confirmed-train evidence (trainCode/line 명확)
 *   - 'medium' : position-train / wifi-ssid-match evidence (train 후보 좁힘 + 정합)
 *   - 'low'    : 향후 cellular/accel single signal 채택 (현재 미사용 — 미래 확장 slot)
 */
export interface LockSuggestion {
  /** 추론된 출발/현재 station identifier. */
  stationId: string;
  /** Seoul API btrainNo (예: "7246"). */
  trainCode: string;
  /** 노선 (Waypoint.line / BoardingLockMeta.line과 동일 표기). */
  lineId: string;
  /** 추론 신뢰도 — device가 채택 정책에 사용 가능 (현 PR은 high/medium 모두 채택). */
  confidence: 'high' | 'medium' | 'low';
  /** 추론 결정 시각 (epoch ms). device가 staleness 판단 가능. */
  decidedAt: number;
}

/**
 * Trip Position Single Source of Truth (ADR-017).
 *
 * 단일 trip의 위치/모션/사용자 의향 상태를 한 곳에 응집. fire path는 read-only로 본 SSOT
 * 위 advance 결과만 보고 발사 결정.
 */
export interface TripPositionSSoT {
  /** SSOT가 속한 trip token (APNs device token). */
  tripToken: string;
  /**
   * 현재 device가 위치한다고 backend가 확신하는 stationId (또는 stationName 호환).
   *
   * #1534 (S1 GAP A) — currentStation 미상으로 trip이 등록되는 경우 빈 문자열("")로 seed될 수
   * 있다. 후속 advance / lockSuggestion 추론이 정착되면 정상 stationId로 갱신된다.
   * 본 필드가 빈 문자열인 동안 advance 게이트 #1(no-seed)이 blocked로 차단해 fire를 막는다.
   */
  currentStationId: string;
  /** 게이트 #2 입력. T3 motion state machine이 갱신. */
  motionState: MotionState;
  /** T3가 누적하는 ring buffer (cap 50). 최신 evidence가 마지막 index. */
  motionEvidence: MotionEvidence[];
  /** 마지막 advance 발생 시각 (epoch ms). 미발생 시 0. */
  lastAdvanceAt: number;
  /** 마지막 advance를 통과시킨 evidence type. 미발생 시 `'time-only'` placeholder가 아닌 별도 표기 필요 없음 — `lastAdvanceAt===0`로 구분. */
  lastAdvanceEvidence: EvidenceType;
  /** 통과 확인된 station 누적 (S6 #1551 Trip.passedStations migration target). */
  passedStations: string[];
  /** C 토글 ON / boardingPrompt 응답 / BoardingTrainList tap. ADR-014 §사용자 명시 의향 trip. */
  userIntentDeclared: boolean;
  /** seed override 발생 횟수 (E5 강 신호 2개 + 30s 연속 일치로 currentStationId 정정 시 +1). */
  seedOverrideCount: number;
  /**
   * #1534 (S1, T9b) — backend가 추론한 lock 제안. lockless trip + 강 evidence 합의 시 set.
   * device `useLockSuggestion`이 reader-only로 채택해 9-AND gate 우회. 부재 시 device는
   * 기존 9-AND gate fallback (graceful, backward-compat).
   */
  lockSuggestion?: LockSuggestion;
  /** schemaVersion. 향후 마이그레이션 분기용. v1 박제. */
  schemaVersion: 1;
}

/** SSOT KV key 생성. */
export function ssotKey(token: string): string {
  return `${SSOT_PREFIX}${token}`;
}

/**
 * SSOT read.
 *
 * `cacheTtl` 미지정 시 KV 기본(60s). caller가 명시할 때 `assertKvCacheTtl`로 floor 검증
 * ([[lesson_cron_cachettl_runtime_constraint]]). cron 사이클에서 사용 시
 * `CRON_READ_CACHE_TTL_SEC`(30s)을 명시.
 *
 * 손상된 JSON은 null 반환 (TTL로 자연 정리).
 */
export async function readSsot(
  kv: KVNamespace,
  token: string,
  options?: { cacheTtl?: number },
): Promise<TripPositionSSoT | null> {
  assertKvCacheTtl(options?.cacheTtl);
  const raw =
    options?.cacheTtl !== undefined
      ? await kv.get(ssotKey(token), { cacheTtl: options.cacheTtl })
      : await kv.get(ssotKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TripPositionSSoT;
  } catch {
    return null;
  }
}

/**
 * SSOT write.
 *
 * `expiresAt` 옵션이 주어지면 그 시각까지(최소 SSOT_MIN_TTL_SEC) 보존. 미지정 시 KV 기본 TTL.
 * trip lifecycle과 정합 — `putTrip`과 동일 패턴 (`trips.ts:42`).
 */
export async function writeSsot(
  kv: KVNamespace,
  ssot: TripPositionSSoT,
  options?: { expiresAt?: number },
): Promise<void> {
  if (options?.expiresAt !== undefined) {
    const ttlSec = Math.max(
      SSOT_MIN_TTL_SEC,
      Math.floor((options.expiresAt - Date.now()) / 1000),
    );
    await kv.put(ssotKey(ssot.tripToken), JSON.stringify(ssot), {
      expirationTtl: ttlSec,
    });
    return;
  }
  await kv.put(ssotKey(ssot.tripToken), JSON.stringify(ssot));
}

/** SSOT delete (trip 종료 시 호출). */
export async function deleteSsot(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(ssotKey(token));
}

/**
 * Seed — trip 등록 직후 SSOT 정착 (S1 GAP A backend 수신부).
 *
 * 새 SSOT를 생성해 KV에 write하고 반환. 이미 존재하면 덮어쓴다 (caller가 race 책임 — 본 PR
 * 스코프 외, T2/T3에서 atomic 보장).
 *
 * motionState는 `'unknown'`으로 시작 — T3 motion state machine이 첫 GPS sample 수신 후 갱신.
 * userIntentDeclared / seedOverrideCount는 false / 0.
 *
 * #1534 (S1 GAP A) — currentStationId는 빈 문자열("") 허용. device가 currentStation 미상으로
 * trip을 등록할 때 backend는 빈 stationId로 seed하고, /position upload + 후속 advance 수렴으로
 * lockSuggestion을 추론한다. advance 게이트 #1(no-seed)가 빈 stationId를 blocked로 차단해
 * 그 동안 fire는 자연 보류된다.
 */
export async function seedSsot(
  kv: KVNamespace,
  token: string,
  currentStationId: string,
  options?: { expiresAt?: number; userIntentDeclared?: boolean },
): Promise<TripPositionSSoT> {
  const ssot: TripPositionSSoT = {
    tripToken: token,
    currentStationId,
    motionState: 'unknown',
    motionEvidence: [],
    lastAdvanceAt: 0,
    // T1 스코프에서 advance 미발생 상태 placeholder — `lastAdvanceAt===0` 동행으로 caller가 구분.
    lastAdvanceEvidence: 'seed-override',
    passedStations: [],
    userIntentDeclared: options?.userIntentDeclared ?? false,
    seedOverrideCount: 0,
    schemaVersion: 1,
  };
  await writeSsot(kv, ssot, { expiresAt: options?.expiresAt });
  return ssot;
}

/**
 * Ring buffer push helper. 50건 초과 시 oldest FIFO eviction.
 *
 * 본 함수는 SSOT를 in-place mutate. caller가 write back 책임. T3 motion state machine이
 * 매 `/position` 수신마다 호출하는 hot path.
 */
export function pushMotionEvidence(
  ssot: TripPositionSSoT,
  evidence: MotionEvidence,
): void {
  ssot.motionEvidence.push(evidence);
  while (ssot.motionEvidence.length > MOTION_EVIDENCE_CAP) {
    ssot.motionEvidence.shift();
  }
}

/**
 * S6 #1551 `Trip.passedStations` → SSOT.passedStations migration (read-only fallback).
 *
 * 본 helper는 SSOT.passedStations와 Trip.passedStations를 union해 SSOT 측에 반영한다.
 * 본 PR(T1) 시점에는 advance가 여전히 `advanceBoardingLockWaypoint`(scheduled.ts)에서 일어나
 * Trip.passedStations에만 stamp됨 — 본 helper가 양방향 호환을 보장한다.
 *
 * T7(#1560) 이후 advance 진입점이 단일화되어 Trip.passedStations stamp가 제거되면 본 helper도
 * 함께 제거 예정.
 *
 * 본 함수는 SSOT를 in-place mutate. caller가 write back 책임.
 */
export function migrateTripPassedStationsToSsot(
  trip: Pick<Trip, 'passedStations'>,
  ssot: TripPositionSSoT,
): void {
  const tripPassed = trip.passedStations ?? [];
  if (tripPassed.length === 0) return;
  const known = new Set(ssot.passedStations);
  for (const stationName of tripPassed) {
    if (!known.has(stationName)) {
      ssot.passedStations.push(stationName);
      known.add(stationName);
    }
  }
}

/**
 * Cron read의 SSOT cacheTtl 박제. T4~T8 reader migration에서 사용 예정.
 *
 * `CRON_READ_CACHE_TTL_SEC`(30s) 재export — `trips.ts:listTrips` 패턴과 정합.
 */
export const SSOT_CRON_READ_CACHE_TTL_SEC = CRON_READ_CACHE_TTL_SEC;

/**
 * #1534 (S1, T9b) — backend lockSuggestion in-place set helper.
 *
 * caller(advanceTripPosition / 후속 cron 추론 site)가 LockSuggestion을 결정한 뒤 SSOT mutate.
 * 본 함수는 in-place — caller가 writeSsot 책임. confidence 같은 비교 정책은 caller가 처리.
 *
 * 같은 stationId+trainCode+lineId가 이미 set 됐고 confidence가 같거나 더 높으면 caller가 호출
 * 자체를 skip해 KV write 비용을 줄여야 한다 (본 함수는 unconditional write).
 */
export function setLockSuggestion(
  ssot: TripPositionSSoT,
  suggestion: LockSuggestion,
): void {
  ssot.lockSuggestion = suggestion;
}

/**
 * #1534 (S1, T9b) — 같은 lockSuggestion이 이미 set 됐는지 비교.
 *
 * stationId / trainCode / lineId가 모두 같으면 동일 suggestion으로 판정. confidence 변화나
 * decidedAt 갱신만으로는 본 함수는 false (caller가 더 강한 confidence면 자유롭게 갱신).
 */
export function isSameLockSuggestion(
  a: LockSuggestion | undefined,
  b: LockSuggestion,
): boolean {
  if (a === undefined) return false;
  return a.stationId === b.stationId && a.trainCode === b.trainCode && a.lineId === b.lineId;
}
