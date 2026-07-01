/**
 * #1984 (Phase 1-4, ADR-022 B3) — Client 채널 통합 fire ledger.
 *
 * ## 문제 (2026-07-01 08:32:09 성수 evidence, #1980 코멘트 케이스 1)
 * `useStationAlarm` 내부에 fg fire path 2개(Phase ETA + API imminent)가 같은 초에 동시 실행돼
 * 사용자에게 같은 station 알람이 2번 노출되는 회귀. 기존 `fireAndLog` sync entry의
 * `firedAlarmsRef.current.add(key)` (`${phaseId}:${stationName}`) 만으로는 phase가 다른 발사가
 * 동일 station에 겹치는 경우(예: `early:성수` + `imminent:성수` 또는 두 effect가 다른 phase로
 * dispatch)를 catch 못 함. 통합 dedup ledger가 station+line+kind+phase 조합으로 상위 backstop.
 *
 * ## 정책
 * - **키**: `${stationName}|${line}|${kind}|${phase}` (기존 phaseId+stationName 보다 강화)
 *   - `line`은 lock.boardingLine 우선 fallback nearestStation.line. null이면 문자열 `null`로 stringify
 *     (환승역 무-노선 fire 케이스는 실무상 없음, 방어적 stringify).
 * - **윈도우**: `FIRE_ONCE_WINDOW_MS = 30_000` — CROSS_CATEGORY dedup 윈도우와 동일. 같은 station+
 *   phase 재발사가 사용자 체감 "같은 초 2건"의 root cause라 30s 안 재발사는 회귀로 본다. 정상 phase
 *   진행(early → imminent)은 phase 필드가 달라 별도 키 → 통과.
 * - **In-memory only**: AsyncStorage roundtrip race가 본 회귀 원인이라 의도적으로 storage 배제.
 *   앱 재시작 시 reset되고 그 직후엔 hydration warmup(#1010/#1316)이 발사를 차단한다.
 * - **flag guard**: 호출부(`useStationAlarm.ts`)의 `SIMPLE_ARCH_ENABLED` 상수 OFF 시 본 ledger는
 *   dead code — 기존 fire 흐름이 그대로 동작 (backward-compat).
 *
 * ## API
 * - `fireAlarmOnce(payload, fire)` — sync in-flight reservation → fire callback 실행 → 성공 시만
 *   ledger 영구 stamp. fire 실패(throw/reject) 시 in-flight reservation 해제 → 다음 호출 재시도 가능.
 *   반환값: `{ deduped: false, fired: true }` (실행) 또는 `{ deduped: true, fired: false }` (스킵).
 * - `_resetFireAlarmOnceForTests()` — 테스트 전용 in-memory Map 리셋.
 *
 * ## Race 원자성 (Finding #2 review 반영)
 * - **in-flight Set**: sync 진입 즉시 `inFlight.add(key)` — 같은 tick 재진입한 두 번째 호출은
 *   즉시 dedup되도록. `ledger.set`은 fire 성공 후로 미룸.
 * - **fire 실패**: catch에서 `inFlight.delete(key)` — reservation만 해제, ledger는 stamp 안 됨.
 *   다음 호출은 정상 fire 재시도. transient failure(silence gate error / notification permission
 *   race)에서 알람이 30s 동안 blackhole되는 회귀 차단.
 * - **fire 성공**: `ledger.set(key, {ts})` + `inFlight.delete(key)` — 30s 재발사 차단으로 승격.
 *
 * ## 회귀 evidence
 * - #1980 코멘트 케이스 1 (2026-07-01 08:32:09 성수 fg fired station-passed 2건)
 * - ADR-022 B3 정책 (Device 채널 통합 fire path)
 */

import type { AlarmPhaseId } from './alarmPhases';
import type { AlarmLogKind } from './alarmLog';
import type { LineNumber } from '../../../shared/types/station';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('FireAlarmOnce');

/** 같은 (station+line+kind+phase) 조합에 대한 재발사 차단 윈도우. */
export const FIRE_ONCE_WINDOW_MS = 30_000;

/** Map 무한 성장 cap. 정상 trip(역 수 ~수십) × phase 2종 × kind 3종 = 수백. cap 도달 시 만료 일괄 정리. */
const FIRE_ONCE_MAP_CAP = 256;

export interface FireAlarmOnceKeyInput {
  stationName: string;
  /** 라인 번호. null이면 문자열 `null`로 stringify — 방어적 처리(실무상 발생 X). */
  line: LineNumber | null;
  kind: AlarmLogKind;
  phase: AlarmPhaseId;
}

export interface FireAlarmOnceResult {
  /** true면 dedup 적중 — fire callback 미실행. false면 정상 fire. */
  deduped: boolean;
  /** true면 fire callback이 정상 실행됨. deduped와 상호 배타. */
  fired: boolean;
}

interface LedgerRecord {
  ts: number;
}

const ledger = new Map<string, LedgerRecord>();
/**
 * In-flight reservation Set. sync 진입 즉시 add — 같은 tick 재진입한 두 번째 호출을 즉시 catch.
 * fire 성공 시 ledger로 승격 후 delete. fire 실패 시 delete만 — ledger 미stamp 상태로 다음 재시도 허용.
 */
const inFlight = new Set<string>();

/**
 * 키 생성 — station/line/kind/phase 조합. line은 문자열, phase/kind는 union 리터럴.
 * 파이프(`|`) 구분자는 stationName에 등장하지 않는 문자(BLDN_NM 도메인 검증됨).
 */
export function makeFireAlarmOnceKey(input: FireAlarmOnceKeyInput): string {
  const lineStr = input.line ?? 'null';
  return `${input.stationName}|${lineStr}|${input.kind}|${input.phase}`;
}

function sweepExpired(now: number): void {
  if (ledger.size <= FIRE_ONCE_MAP_CAP) return;
  for (const [k, rec] of ledger) {
    if (now - rec.ts >= FIRE_ONCE_WINDOW_MS) ledger.delete(k);
  }
}

/**
 * ledger + in-flight 확인 후 fire callback 실행.
 *
 * 원자성:
 *   1. sync 진입 즉시 ledger(성공 stamp) 또는 inFlight(진행 중) 조회 → hit이면 즉시 dedup.
 *   2. sync `inFlight.add(key)` — 같은 tick 재진입한 두 번째 호출을 즉시 catch (본 util의 핵심).
 *   3. `await fire()` — 실제 알람 발사.
 *   4-a. 성공: `ledger.set(key, {ts})` + `inFlight.delete(key)` → 30s 재발사 차단으로 승격.
 *   4-b. 실패(throw/reject): `inFlight.delete(key)` + rethrow → ledger 미stamp, 다음 호출 재시도 허용.
 *
 * Finding #2 review 반영: 기존 구현은 ledger를 fire 전에 stamp해 fire 실패 시 30s 동안 알람이
 * blackhole. 새 구현은 성공 시만 stamp — transient failure(silence gate error / notification
 * permission race) 회복 가능.
 */
export async function fireAlarmOnce(
  payload: FireAlarmOnceKeyInput,
  fire: () => Promise<void> | void,
  now: number = Date.now(),
): Promise<FireAlarmOnceResult> {
  const key = makeFireAlarmOnceKey(payload);
  const rec = ledger.get(key);
  if (rec !== undefined && now - rec.ts < FIRE_ONCE_WINDOW_MS) {
    return { deduped: true, fired: false };
  }
  if (inFlight.has(key)) {
    return { deduped: true, fired: false };
  }
  // sync reservation before await — 같은 tick 재진입한 두 번째 호출이 즉시 dedup되도록.
  inFlight.add(key);
  try {
    await fire();
    // 성공: ledger 승격 + reservation 해제. 30s 동안 재발사 차단.
    ledger.set(key, { ts: now });
    sweepExpired(now);
    return { deduped: false, fired: true };
  } catch (err) {
    // 실패: reservation만 해제. ledger 미stamp → 다음 호출은 정상 재시도.
    logger.error('fire failed, releasing in-flight reservation without ledger stamp', err);
    throw err;
  } finally {
    inFlight.delete(key);
  }
}

/** 테스트 전용 — 모듈 상태 리셋(ledger + inFlight). production 호출 금지. */
export function _resetFireAlarmOnceForTests(): void {
  ledger.clear();
  inFlight.clear();
}
