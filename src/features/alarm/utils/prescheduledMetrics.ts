/**
 * A3 사전 예약 효과 측정 인프라 (#918, Epic #912 P1).
 *
 * `safetyNetScheduler`(#2089 — 구 tripBoundScheduler 통합 후속)가 OS local notification으로
 * 사전 예약한 안전망 알람이 실제로 발사됐는지/예측 시각 대비 얼마나 어긋났는지를 ledger
 * 기반으로 측정한다.
 *
 * 산출 지표 (Phase 4 결정 게이트 아님 — 운영 KPI / A4 metrics catalog로 노출):
 *  - prescheduledFireDeltaMs   : histogram (actualFireMs - scheduledFireMs)
 *      → OS local notification 타이밍 정확도. 큰 양수면 OS가 늦게 발사,
 *        음수면 timer drift / 시계 보정으로 더 일찍 발사된 케이스.
 *  - prescheduledFireMissRate  : rate (hit=missed, total=scheduled)
 *      → trip 종료 시점까지 fire ledger에 actualFireMs가 기록되지 않은 비율.
 *        cancel/취소/OS drop을 모두 포함 — A4 recall과 보완 신호 (사전 예약 단독).
 *  - prescheduledStationAccuracy : rate (hit=correctStation, total=fired)
 *      → fired entry 중 alarmLog가 같은 station에서 fired outcome을 남긴 비율.
 *
 * 동작 변경 없음 — 순수 측정 모듈. ledger는 trip마다 시작 시 cleared, fire ledger entry는
 * 최대 LEDGER_MAX_ENTRIES(200)건만 보관 (스마트폰 1 trip 최대 ~40역 × 2 phase = 80건이라
 * 여유). 보관 초과 시 oldest 절단.
 *
 * **#2089 리뷰 P2-1** — 구 identifier(`tba:phaseId:stationName`)는 콜론 split으로 stationName을
 * 파싱했지만, safetyNetScheduler의 새 identifier(`alarm-${tripToken}-${station}-${kind}`)는
 * tripToken 자체가 대시를 포함할 수 있어 문자열 파싱이 본질적으로 불안전하다
 * (`readSafetyNetData`가 identifier 파싱 대신 구조화된 notification content.data를 쓰는
 * 이유와 동일). 따라서 ledger entry에 stationName을 파싱 대상이 아닌 명시 필드로 저장한다 —
 * 호출자(`safetyNetScheduler.scheduleOne`)가 이미 구조화된 station 값을 들고 있으므로 비용이
 * 없고, 프리징된 문자열 포맷에 측정 인프라가 결합되는 취약점을 제거한다.
 *
 * Privacy: 좌표/원문 미적재. identifier + stationName은 사용자 stations.json에서 식별 가능한
 * 정보지만 backend는 token prefix(8자) anonymous aggregate만 사용 — recallTelemetry 정책 동일.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from '../../../shared/utils/logger';
import { PRESCHEDULED_LEDGER_KEY } from '../../../shared/constants/storageKeys';
// NOTE: `safetyNetScheduler.ts`의 `SAFETY_NET_ALARM_PREFIX` / `stationPrescheduler.ts`의
// `PRESCHED_ALARM_PREFIX`와 동일 값 — 모듈 간 순환 import 방지를 위해 로컬 상수로 보관.
// 두 스케줄러(sleepMode ON 전용 / OFF 전용)가 각각 등록하는 예약 채널 2종을 이 ledger가
// 공통으로 측정한다(#918) — prefix가 둘 중 하나라도 바뀌면 본 파일도 동시 업데이트.
const SCHEDULED_ALARM_PREFIXES = ['alarm-', 'presched-'];

function hasKnownPrefix(identifier: string): boolean {
  return SCHEDULED_ALARM_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}

const log = createLogger('prescheduledMetrics');

/** Ledger 크기 상한 — 1 trip 최대 ~40역 × 2 phase 여유. 초과분은 oldest 절단. */
export const LEDGER_MAX_ENTRIES = 200;

/**
 * Ledger entry 1건. identifier는 safetyNetScheduler의 `alarm-${tripToken}-${station}-${kind}`
 * (occurrence>0이면 `#n` suffix) — 같은 identifier가 한 trip 안에 두 번 등장하지 않는다
 * (occurrenceIdx suffix로 충돌 방지).
 *
 * stationName은 identifier에서 파싱하지 않고 호출자가 명시 전달한다(#2089 리뷰 P2-1 — 모듈
 * 헤더 참고).
 */
export interface PrescheduledLedgerEntry {
  identifier: string;
  /** 사전 예약 시점에 호출자가 예측한 발사 시각 (epoch ms). */
  scheduledFireMs: number;
  /** identifier 파싱이 아닌 호출자 명시 전달 — station 정확도(prescheduledStationAccuracy) 산출용. */
  stationName: string;
  /** 발사 ledger 기록 시각 (epoch ms). 미발사면 undefined. */
  actualFireMs?: number;
}

export type PrescheduledLedger = PrescheduledLedgerEntry[];

async function readLedger(): Promise<PrescheduledLedger> {
  try {
    const raw = await AsyncStorage.getItem(PRESCHEDULED_LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // shape 가드 — entry 일부가 깨져도 전체 ledger 폐기보다 정상 entry만 보존.
    return parsed.filter(isLedgerEntry);
  } catch (e) {
    log.warn('ledger read failed — start fresh', e);
    return [];
  }
}

function isLedgerEntry(v: unknown): v is PrescheduledLedgerEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.identifier !== 'string' || !hasKnownPrefix(o.identifier)) {
    return false;
  }
  if (typeof o.stationName !== 'string' || o.stationName.length === 0) return false;
  if (typeof o.scheduledFireMs !== 'number' || !Number.isFinite(o.scheduledFireMs)) return false;
  if (o.actualFireMs !== undefined) {
    if (typeof o.actualFireMs !== 'number' || !Number.isFinite(o.actualFireMs)) return false;
  }
  return true;
}

async function writeLedger(ledger: PrescheduledLedger): Promise<void> {
  // 상한 절단 — oldest(앞쪽) 제거.
  const trimmed =
    ledger.length > LEDGER_MAX_ENTRIES
      ? ledger.slice(ledger.length - LEDGER_MAX_ENTRIES)
      : ledger;
  await AsyncStorage.setItem(PRESCHEDULED_LEDGER_KEY, JSON.stringify(trimmed));
}

/**
 * safetyNetScheduler가 사전 예약 1건 등록 직후 호출(#2089 리뷰 P2-1 — `scheduleOne`에서 wire).
 * 같은 identifier가 ledger에 이미 있으면 scheduledFireMs를 갱신하고 actualFireMs는 reset
 * (재예약 케이스 — 새 trip 또는 backend reschedule 정정).
 */
export async function recordScheduledAlarm(input: {
  identifier: string;
  scheduledFireMs: number;
  stationName: string;
}): Promise<void> {
  if (!hasKnownPrefix(input.identifier)) return;
  if (!Number.isFinite(input.scheduledFireMs)) return;
  if (input.stationName.length === 0) return;
  try {
    const ledger = await readLedger();
    const idx = ledger.findIndex((e) => e.identifier === input.identifier);
    const entry: PrescheduledLedgerEntry = {
      identifier: input.identifier,
      scheduledFireMs: input.scheduledFireMs,
      stationName: input.stationName,
    };
    if (idx >= 0) {
      ledger[idx] = entry;
    } else {
      ledger.push(entry);
    }
    await writeLedger(ledger);
  } catch (e) {
    log.warn('recordScheduledAlarm failed', e);
  }
}

/**
 * safety-net 알람 발사 수신 시 호출 (scheduledAlarmReceiver). ledger에 entry가 없으면 no-op —
 * 다른 trip의 잔여 발화이거나 ledger reset 후 발사된 케이스. fire ledger entry는 actualFireMs만 set.
 */
export async function recordFiredAlarm(input: {
  identifier: string;
  actualFireMs: number;
}): Promise<void> {
  if (!hasKnownPrefix(input.identifier)) return;
  if (!Number.isFinite(input.actualFireMs)) return;
  try {
    const ledger = await readLedger();
    const idx = ledger.findIndex((e) => e.identifier === input.identifier);
    if (idx < 0) return;
    ledger[idx] = { ...ledger[idx], actualFireMs: input.actualFireMs };
    await writeLedger(ledger);
  } catch (e) {
    log.warn('recordFiredAlarm failed', e);
  }
}

/** trip 종료/새 trip 시작 시 호출. 다음 trip은 깨끗한 ledger에서 시작. */
export async function clearPrescheduledLedger(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PRESCHEDULED_LEDGER_KEY);
  } catch (e) {
    log.warn('clearPrescheduledLedger failed', e);
  }
}

/** test/debug 용 — ledger 현 상태 노출. 외부 호출자는 일반적으로 compute*만 호출. */
export async function readPrescheduledLedger(): Promise<PrescheduledLedger> {
  return readLedger();
}

export interface PrescheduledMetricsResult {
  /** trip 윈도우 lower bound (inclusive, scheduledFireMs ≥ tripStart). */
  tripStart: number;
  /** trip 윈도우 upper bound. */
  tripEnd: number;
  /** scheduledFireMs가 윈도우에 포함되는 ledger entry 수. */
  scheduledCount: number;
  /** 그 중 actualFireMs가 기록된 entry 수. */
  firedCount: number;
  /** 그 중 alarmLog fired와 station이 일치한 entry 수 (정확도 분자). */
  stationAccurateCount: number;
  /** scheduledFireMs - actualFireMs 차이 (양수 = OS 늦게 발사). fired entry만. */
  fireDeltaSamplesMs: readonly number[];
}

export interface ComputeMetricsInput {
  /** trip 시작 epoch ms — entry.scheduledFireMs ≥ tripStart인 ledger entry만 포함. */
  tripStart: number;
  /** trip 종료 epoch ms — entry.scheduledFireMs ≤ tripEnd인 ledger entry만 포함. */
  tripEnd: number;
  /**
   * alarmLog의 fired entries에서 추출된 station name 집합. recallMetrics가 동일 입력으로
   * 산출하므로 호출자가 한 번만 alarmLog를 읽어 양쪽에 전달한다.
   */
  firedStationNames: ReadonlySet<string>;
}

export async function computePrescheduledMetrics(
  input: ComputeMetricsInput,
): Promise<PrescheduledMetricsResult> {
  const { tripStart, tripEnd, firedStationNames } = input;
  const ledger = await readLedger();

  const fireDeltaSamplesMs: number[] = [];
  let scheduledCount = 0;
  let firedCount = 0;
  let stationAccurateCount = 0;

  for (const entry of ledger) {
    if (entry.scheduledFireMs < tripStart || entry.scheduledFireMs > tripEnd) continue;
    scheduledCount++;
    if (entry.actualFireMs === undefined) continue;
    firedCount++;
    fireDeltaSamplesMs.push(entry.actualFireMs - entry.scheduledFireMs);
    // #2089 리뷰 P2-1 — identifier 파싱 대신 entry.stationName(호출자 명시 전달)을 직접 사용.
    if (firedStationNames.has(entry.stationName)) {
      stationAccurateCount++;
    }
  }

  return {
    tripStart,
    tripEnd,
    scheduledCount,
    firedCount,
    stationAccurateCount,
    fireDeltaSamplesMs,
  };
}

/**
 * upload 의미가 있는지 — scheduled=0이면 사전 예약 자체가 없었던 trip(lock 없이 시작 등).
 * 빈 신호 전송으로 backend 노이즈 증가 막기 위한 가드.
 */
export function isEmptyPrescheduledMetrics(result: PrescheduledMetricsResult): boolean {
  return result.scheduledCount === 0;
}
