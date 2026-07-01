/**
 * Unified fire dedup — ADR-022 Phase 1-5 (#1997).
 *
 * ## 배경
 *
 * #1980 코멘트 "동일 알림 반복 발사 근본 원인" 케이스 3 (채널 간 dedup 부족). 현 client
 * dedup 5 채널 (`dedup-station`, `dedup-station-unified`, `dedup-alarm`,
 * `dedup-channel-agnostic`, `dedup-cross-category-recent`) 은 각각 별개 판정하며 kind 가
 * 다르면 통과한다. `station-passed` vs `destination` vs `imminent` 등 kind 만 다르면
 * 같은 (station, line) 조합에서 여러 번 fire.
 *
 * ## 정책
 *
 * 통합 dedup key = `{stationName}|{line}|{trainCode}|{arvlCdCycle}` (kind 무관).
 *
 * - `stationName` 은 `normalizeStationName` (`src/shared/utils/normalizeStationName.js`,
 *   전 프로젝트 SSOT) 로 정규화 — `'서울역(1)'` vs `'서울역'` 같은 표기 variant 를
 *   하나의 cycle timeline 으로 묶어 wire PR 에서 caller 마다 다른 source (arrival API
 *   응답 vs route.waypoint) 를 써도 dedup 이 성립하도록.
 * - `trainCode` = `BoardingLock.trainCode` (사용자 target train). 같은 station 에 여러
 *   train 이 동시에 있을 수 있어 (예: `arrival.up[]` + `arrival.down[]` 두 방향) train 간
 *   arvlCd 값이 섞이면 cycle 추적이 오작동. `stationName + line + trainCode` 로 격리해
 *   trip 안 사용자 target train 만 관측한다.
 * - `arvlCdCycle` = per-(station, line, trainCode) 정수 counter. arvlCd 시퀀스
 *   `0→1→2→5` monotone 관측. `5→0` 전환 시 +1 — 다음 train 도착 = 새 cycle.
 *   (같은 trainCode 가 같은 station 을 재방문할 수 없어 실무적으로 `5→0` 은 재현 안
 *   되지만 방어적으로 남긴다. 다음 train 은 다른 trainCode → 별개 timeline.)
 * - 같은 (station, line, trainCode, cycle) 조합에서 **kind 무관 1 fire** 만 통과.
 *
 * ## 기존 5 채널 dedup 관계
 *
 * 별개 유지 — 통합 dedup 는 **layer 하나 더 추가** (additive backstop). 기존 채널이
 * 각자의 회귀 (per-station race, cross-category cascade, phase-to-phase 등) 를 담당하고
 * 본 통합 layer 는 kind-agnostic 최상위 backstop 이다.
 *
 * ## Flag guard
 *
 * Phase 0 (#1982) 의 real `isSimpleArchEnabled()` (`src/shared/config/archFlag.ts`).
 *
 * - flag OFF (기본) → `hasFiredForCycle` 항상 `false` (기존 5 채널만 동작, backward-compat).
 * - flag ON → 통합 dedup layer 활성.
 *
 * `observeArvlCd` / `markFiredForCycle` 자체는 flag 무관하게 in-memory state 를 갱신한다.
 * flag OFF 시에는 `hasFiredForCycle` 이 무조건 `false` 를 반환해 dead code — production
 * 무영향.
 *
 * ## In-memory + TTL sweep
 *
 * AsyncStorage roundtrip race 를 배제해 in-memory Map 만 사용. 앱 재시작 시 reset 되며
 * 그 직후엔 hydration warmup (#1010/#1316) 이 발사를 차단한다 (Phase 1-4 fireAlarmOnce 와
 * 동일 설계).
 *
 * Entry 만료: `UNIFIED_FIRE_DEDUP_TTL_MS` (5 분, backend Phase 1-1
 * `ARVLCD_FIRE_ONCE_TTL_SEC` 와 정합). Train 이 물리적으로 같은 station 을 5 분 안에
 * 재방문할 수 없음이 근거. Map cap 도달 시 만료 entry 를 sweep — live cycle state 는 보존.
 *
 * Trip 종료 시엔 별도 `clearUnifiedFireDedup` API 로 전체 초기화 (후속 wire PR 에서
 * `TRIP_BOUND_CLEANUPS` 등록 예정).
 */

import type { LineNumber } from '../../../shared/types/station';
import { isSimpleArchEnabled } from '../../../shared/config/archFlag';
// SSOT — 런타임(stationRoute.ts, transferTimes.ts, stationLookup.ts)과 빌드 스크립트
// (build-transfer-times.js) 가 공유하는 정규화. 괄호 부제 제거 + trim.
import { normalizeStationName } from '../../../shared/utils/normalizeStationName';

/**
 * arvlCd 시퀀스 monotone: 0 진입 → 1 도착 → 2 출발 → 5 전역도착. `5→0` 전환은 다음
 * train 이 진입한 것 = 새 cycle. (본 모듈은 trainCode 별로 timeline 을 격리하므로
 * `5→0` 은 실무상 재현 안 되지만 방어적으로 유지.)
 *
 * `ARRIVAL_CODE` (`src/shared/constants/arrivalCodes.ts`) 리터럴 값을 그대로 재사용하지
 * 않은 이유: 본 모듈은 cycle 전환 판정만 담당하며 API 응답 값 상수와 결합도를 낮춰
 * refactor 시 spec drift 를 격리한다. 값이 바뀌면 test 가 감지한다.
 */
const ARVL_CD_ENTERING = 0;
const ARVL_CD_PREV_ARRIVED = 5;

/**
 * Entry TTL — 5 분. backend Phase 1-1 (#1985) `ARVLCD_FIRE_ONCE_TTL_SEC` 와 정합.
 * Train 이 물리적으로 같은 station 을 5 분 안에 재방문할 수 없다는 실제 운영 특성 기반.
 */
export const UNIFIED_FIRE_DEDUP_TTL_MS = 5 * 60_000;

/** Map cap — 도달 시 만료 entry 만 sweep (live 는 보존). 정상 trip 수백 개면 충분. */
const MAP_CAP = 512;

interface CycleState {
  /** 현재 cycle 번호 (0 부터 시작, 5→0 전환 시 +1). */
  cycle: number;
  /** 마지막 관측된 arvlCd. cycle 전환 판정 (5 → 0) 용. */
  lastArvlCd: number;
  /** 마지막 갱신 timestamp. TTL sweep 용. */
  ts: number;
}

const cycleStates = new Map<string, CycleState>();

/**
 * `${stationName}|${line}|${trainCode}` — 정규화된 stationName + line + trainCode
 * 3-tuple 로 timeline 격리. wire PR 에서 caller 는 반드시 `BoardingLock.trainCode`
 * (사용자 target train) 를 전달해야 한다 — 자세한 caller 룰은 `observeArvlCd` docstring 참조.
 */
function stateKey(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
): string {
  const lineStr = line ?? 'null';
  return `${normalizeStationName(stationName)}|${lineStr}|${trainCode}`;
}

interface FiredLedgerRecord {
  cycle: number;
  /** stamp timestamp. TTL sweep 용. */
  ts: number;
}

/**
 * fire 기록 ledger. key = `${stationName}|${line}|${trainCode}|${cycle}`. cycle 단위 캡슐화.
 *
 * cycle 이 전환 (예: 0 → 1) 되면 이전 cycle 의 fired stamp 는 그대로 남아있지만 새 cycle
 * 은 별개 entry 라 다시 fire 가능. 오래된 entry 는 TTL sweep 대상.
 */
const firedLedger = new Map<string, FiredLedgerRecord>();

function ledgerKey(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
  cycle: number,
): string {
  const lineStr = line ?? 'null';
  return `${normalizeStationName(stationName)}|${lineStr}|${trainCode}|${cycle}`;
}

/**
 * cap 도달 시 만료 entry (TTL 초과) 만 삭제. live entry 는 보존.
 * cap 미달 이면 skip — 정상 trip 내엔 sweep 오버헤드 없음.
 */
function sweepExpired(now: number): void {
  if (cycleStates.size > MAP_CAP) {
    for (const [k, rec] of cycleStates) {
      if (now - rec.ts >= UNIFIED_FIRE_DEDUP_TTL_MS) cycleStates.delete(k);
    }
  }
  if (firedLedger.size > MAP_CAP) {
    for (const [k, rec] of firedLedger) {
      if (now - rec.ts >= UNIFIED_FIRE_DEDUP_TTL_MS) firedLedger.delete(k);
    }
  }
}

/**
 * arvlCd 시퀀스 관측 — `5→0` 전환 시 cycle counter +1.
 *
 * **CALLER 룰 (필수 준수)**:
 *   - **MUST** 사용자 target train 의 arvlCd 만 관측. `BoardingLock.trainCode` 로
 *     `arrival.up[] + arrival.down[]` 중 매칭 row 를 하나 골라 그 row 의 `arvlCd` 를 넘긴다
 *     (`findFgArvlCdFireSignal` 패턴, `fgArvlCdFastPath.ts:31` 참조).
 *   - **DO NOT** `arrival.up[] + arrival.down[]` 를 iterate 해 매 train row 마다 호출하지
 *     않는다. 여러 train 의 arvlCd 값이 섞이면 cycle 전환 (`prev.lastArvlCd=5 && arvlCd=0`)
 *     이 잘못 트리거되고 사용자 target train 의 fire 가 dedup 되지 않는 회귀 발생.
 *   - `trainCode` param 은 명시적으로 요구된다 — timeline 을 (station, line, trainCode) 3-tuple
 *     로 격리해 다른 train row 관측이 실수로 섞여도 사용자 target train 에는 영향 없도록.
 *
 * 최초 관측 시 cycle = 0 로 초기화.
 *
 * 순차 관측 규칙:
 *   - 이전 arvlCd = 5, 현재 arvlCd = 0 → cycle +1 (다음 train 진입).
 *   - 그 외 전환 (0→1, 1→2, 2→5, 같은 값 반복 등) → cycle 유지.
 *
 * flag 무관하게 상태 갱신 — flag OFF 시에도 state 는 warm 상태로 유지되며 flag 전환
 * 즉시 정확 판정 가능. state 축적 자체는 무해 (in-memory, TTL sweep).
 */
export function observeArvlCd(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
  arvlCd: number,
  now: number = Date.now(),
): void {
  const key = stateKey(stationName, line, trainCode);
  const prev = cycleStates.get(key);
  if (prev === undefined) {
    cycleStates.set(key, { cycle: 0, lastArvlCd: arvlCd, ts: now });
    sweepExpired(now);
    return;
  }
  const isCycleTransition =
    prev.lastArvlCd === ARVL_CD_PREV_ARRIVED && arvlCd === ARVL_CD_ENTERING;
  const nextCycle = isCycleTransition ? prev.cycle + 1 : prev.cycle;
  cycleStates.set(key, { cycle: nextCycle, lastArvlCd: arvlCd, ts: now });
  sweepExpired(now);
}

/**
 * 현재 cycle 조회. 관측 이전이면 0.
 *
 * `hasFiredForCycle` / `markFiredForCycle` 이 내부적으로 호출하며, 외부에서도 log/debug
 * 용도로 사용 가능.
 */
export function getCurrentCycle(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
): number {
  const state = cycleStates.get(stateKey(stationName, line, trainCode));
  return state?.cycle ?? 0;
}

/**
 * 같은 (station, line, trainCode, current cycle) 조합에서 이미 fire 됐는지 판정.
 *
 * **Flag guard**: `isSimpleArchEnabled()` 가 `false` 면 항상 `false` 반환 — 기존 5 채널
 * dedup 만 동작. Phase 1-5 는 flag OFF 상태로 머지, 후속 wire PR 에서 flag ON 후 caller
 * 가 본 helper 를 backstop gate 로 사용.
 *
 * TTL 만료된 stamp 는 fire 를 허용 — 5 분 이상 지난 entry 는 새 cycle 관측이 없어도
 * 재발사 통과 (실무 안전 마진).
 *
 * @param remoteFlag `useArchFlagRemote()` 결과. 미조회 시 `undefined` — env 만 참조.
 * @returns true → dedup 적중 (skip 필요). false → 정상 fire 가능.
 */
export function hasFiredForCycle(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
  remoteFlag?: 'on' | 'off',
  now: number = Date.now(),
): boolean {
  if (!isSimpleArchEnabled(remoteFlag)) return false;
  const cycle = getCurrentCycle(stationName, line, trainCode);
  const rec = firedLedger.get(ledgerKey(stationName, line, trainCode, cycle));
  if (rec === undefined) return false;
  return now - rec.ts < UNIFIED_FIRE_DEDUP_TTL_MS;
}

/**
 * 성공 fire 직후 현재 cycle 을 stamp — 같은 (station, line, trainCode, cycle) 에 대한
 * 후속 fire 는 `hasFiredForCycle` 이 true 를 반환하도록.
 *
 * flag 무관하게 stamp — flag OFF 시에도 state 는 warm 상태로 유지 (state 축적 무해).
 * flag 전환 즉시 정확 판정 가능.
 */
export function markFiredForCycle(
  stationName: string,
  line: LineNumber | null,
  trainCode: string,
  now: number = Date.now(),
): void {
  const cycle = getCurrentCycle(stationName, line, trainCode);
  firedLedger.set(ledgerKey(stationName, line, trainCode, cycle), { cycle, ts: now });
  sweepExpired(now);
}

/**
 * trip 종료 / 전환 시 호출 — 모든 cycle state 및 fire ledger 초기화. trip 간 leak 차단.
 *
 * caller 는 `TRIP_BOUND_CLEANUPS` (`src/features/alarm/store/tripBoundCleanups.ts`) 에
 * 후속 wire PR 에서 등록. 본 helper 자체는 fire-and-forget Promise 로 반환.
 */
export function clearUnifiedFireDedup(): Promise<void> {
  cycleStates.clear();
  firedLedger.clear();
  return Promise.resolve();
}

/** 테스트 전용 — 모듈 상태 리셋. production 호출 금지. */
export function _resetUnifiedFireDedupForTests(): void {
  cycleStates.clear();
  firedLedger.clear();
}
