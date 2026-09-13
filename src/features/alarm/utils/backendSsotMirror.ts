/**
 * #1568 (T8b, Epic ADR-017 #1553) — backend SSoT 권위 mirror storage SSoT 모듈.
 *
 * silent push handler가 payload.ssot를 영속화하고 device 화면/cascade picker가 read한다.
 * 본 모듈은 AsyncStorage I/O만 다루며 expo-notifications / expo-task-manager 의존성이 없어
 * 어떤 feature에서든 가볍게 import 가능하다 (#1568 cascade picker / DebugModal 양쪽이 사용).
 *
 * 구 호환: 원래 `silentPushTask.ts`에 함께 있던 helper(`persistBackendSsotMirror`/`readBackendSsotMirror`/
 * `SilentPushSsotMirror`/`BackendSsotMirrorEntry`)를 본 모듈로 이전. silentPushTask.ts는 re-export로
 * 기존 import path를 유지한다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_SSOT_MIRROR_KEY } from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BackendSsotMirror');

/**
 * #1534 (S1, T9b, ADR-016) — backend가 추론한 lock 제안 (device 측 mirror schema).
 *
 * backend `apns.ts`의 `LockSuggestionPayload`와 1:1. device `useLockSuggestion` reader가
 * `useBoardingLockController`에 1순위 candidate로 forward해 9-AND gate 우회.
 *
 * confidence 'low'는 향후 단일 cellular/accel 채택 slot. 현재는 high/medium만 backend가 set.
 *
 * confidence 'consensus' — #2330 (consensus-D, 설계 SSoT #2323 (1)(3)). backend legConsensus
 * 엔진이 environment confirmed(core 창 단일 생존 + match≥2 + mismatch=0)한 transfer leg 다음
 * 열차를 forward. high/medium/low(9-AND gate 기반)와 달리 **lock 승격 금지** — device
 * (`useBoardingLockController`)는 이 값을 UI 표시(배지/하이라이트)/floor 힌트 전용으로만 소비하고
 * 자동 lock 채택 경로에서는 명시적으로 제외한다.
 */
export interface LockSuggestionMirror {
  stationId: string;
  trainCode: string;
  lineId: string;
  confidence: 'high' | 'medium' | 'low' | 'consensus';
  decidedAt: number;
}

/**
 * #1572 (T9, ADR-017) — backend가 결정한 alarmEvent (device 측 mirror schema).
 *
 * backend `apns.ts`의 `AlarmEventPayload`와 1:1. device `evaluateSsotFireGate`가 5 fire path에서
 * reader-only 게이트로 사용 — alarmId 매칭 시 Gate A, stationId 매칭 시 Gate B.
 *
 * `type`: backend AlarmEventType과 동일 narrow. validator에서 부적합한 type은 graceful drop.
 */
export interface AlarmEventMirror {
  alarmId: string;
  stationId: string;
  type: 'station-passed' | 'transfer' | 'destination' | 'imminent';
  decidedAt: number;
}

/**
 * #1561 (T8) — silent push payload에 실린 SSoT 권위 스냅샷 형태.
 *
 * backend `apns.ts`의 `SilentPushSsotPayload`와 1:1. device는 본 값을 BACKEND_SSOT_MIRROR_KEY에
 * mirror하며 cascade picker가 다음 polling cycle에서 read해 `backend-ssot` tier로 채택.
 *
 * #1534 (S1, T9b) — lockSuggestion optional. 부재 시 device `useLockSuggestion` reader는 null
 * 반환 (graceful, 기존 9-AND gate fallback).
 *
 * #1572 (T9) — alarmEvents optional. 부재 시 `evaluateSsotFireGate`는 `mirror-missing` 반환
 * (graceful, 기존 fire path 동작). 본 list에서 alarmId/stationId 매칭 시 게이트 A/B 차단.
 */
export interface SilentPushSsotMirror {
  currentStationId: string;
  motionState: 'moving' | 'stationary' | 'unknown';
  lastAdvanceEvidence: string;
  lastAdvanceAt: number;
  passedStations: readonly string[];
  lockSuggestion?: LockSuggestionMirror;
  alarmEvents?: readonly AlarmEventMirror[];
  /**
   * #1705 — backend advance한 station의 노선.
   *
   * 구 backend 호환 위해 optional (v1 row 부재 시 undefined). 부재 시 cascade picker는
   * name-only fallback (`findStationByName`)으로 기존 동작 유지.
   */
  currentStationLine?: string;
  /**
   * #2593 — mirror가 소속된 trip 식별자 (backend push payload의 `tripToken` echo).
   *
   * `persistBackendSsotMirror`의 단조성 가드가 "같은 trip"을 판정하는 키. 구 backend/구 저장분
   * 호환 위해 optional — 부재 시(레거시 stored entry 포함) same-trip으로 취급해 기존 가드 동작 보존.
   */
  tripToken?: string;
}

/** #1561 (T8) — mirror entry에 receivedAt 추가. cascade picker가 자체 staleness 판정. */
export interface BackendSsotMirrorEntry extends SilentPushSsotMirror {
  receivedAt: number;
}

/**
 * #1561 (T8, ADR-017 / S2 #1535 흡수) — backend SSoT 권위 mirror를 AsyncStorage에 영속화.
 *
 * useFusedNearestStation cascade picker가 다음 polling cycle에서 본 값을 read해 `backend-ssot`
 * tier(최상위)로 채택한다. receivedAt epoch ms를 함께 stamp.
 *
 * write 실패는 silent — backend SSoT mirror는 보조 신호로 미존재 시 cascade는 기존 tier fallback.
 *
 * #2593 — 단조성 가드 (RCA: 2026-09-13 데스크 trip, 군자 21:54:38 적용 후 stale 중곡 21:54:53 역행
 * 적용). APNs는 순서를 보장하지 않아 늦게 도착한 과거 push가 최신 상태를 덮어쓸 수 있다. 기존
 * mirror가 있고 **같은 trip**이며 incoming.lastAdvanceAt이 existing보다 과거면 write를 skip한다.
 * 같음(=)은 수용(advance 없는 사이 재수신 push는 정상). **다른 trip이면 무조건 수용** — 새 trip의
 * 작은 lastAdvanceAt를 이전 trip 기준으로 거부하면 안 된다. trip 식별은 `tripToken` — 기존 저장분처럼
 * 한쪽이라도 tripToken이 없으면 same-trip으로 취급해 하위 호환을 보존한다(레거시 mirror에도 가드 적용).
 */
export async function persistBackendSsotMirror(
  ssot: SilentPushSsotMirror,
  receivedAt: number,
): Promise<void> {
  try {
    const existing = await readBackendSsotMirror();
    if (existing !== null) {
      const sameTrip =
        existing.tripToken === undefined ||
        ssot.tripToken === undefined ||
        existing.tripToken === ssot.tripToken;
      if (sameTrip && ssot.lastAdvanceAt < existing.lastAdvanceAt) {
        logger.info(
          `ssot-mirror-stale-skip: incoming station=${ssot.currentStationId} lastAdvanceAt=${ssot.lastAdvanceAt} existing station=${existing.currentStationId} lastAdvanceAt=${existing.lastAdvanceAt}`,
        );
        return;
      }
    }
    await AsyncStorage.setItem(
      BACKEND_SSOT_MIRROR_KEY,
      JSON.stringify({ ...ssot, receivedAt }),
    );
  } catch {
    // graceful — cascade picker는 mirror 부재 시 기존 tier fallback.
  }
}

/**
 * #1573 (T10) — backend SSoT mirror를 AsyncStorage에서 제거.
 *
 * trip 종료 시(tripBoundCleanups 경로 전체 — FG setDestination(null), silent push trip-ended,
 * useStateRehydration sentinel, useLaunchTripReconciliation, 6h backstop) 호출해 stale mirror가
 * 다음 trip의 cascade 최상위 tier로 leak 채택되는 회귀(Mirror leak #3) 차단.
 *
 * 멱등 — 키 부재 시 graceful no-op. removeItem 실패는 swallow.
 */
export async function clearBackendSsotMirror(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BACKEND_SSOT_MIRROR_KEY);
  } catch {
    // graceful — 다음 cleanup pass에서 재시도. 잔존하더라도 freshness 180s 만료 후
    // 자연 비활성화되므로 보조 backstop이 있다.
  }
}

/**
 * #1561 (T8) — AsyncStorage에서 backend SSoT mirror 읽기. cascade picker가 polling cycle마다 호출.
 *
 * 미존재 / parse 실패 → null. cascade picker는 기존 tier fallback.
 */
export async function readBackendSsotMirror(): Promise<BackendSsotMirrorEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(BACKEND_SSOT_MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BackendSsotMirrorEntry> | null;
    if (
      !parsed ||
      typeof parsed.currentStationId !== 'string' ||
      parsed.currentStationId.length === 0 ||
      (parsed.motionState !== 'moving' &&
        parsed.motionState !== 'stationary' &&
        parsed.motionState !== 'unknown') ||
      typeof parsed.lastAdvanceEvidence !== 'string' ||
      typeof parsed.lastAdvanceAt !== 'number' ||
      !Array.isArray(parsed.passedStations) ||
      typeof parsed.receivedAt !== 'number'
    ) {
      return null;
    }
    // #1534 (S1, T9b) — lockSuggestion parse (optional). 형식 misjudge 시 omit (graceful).
    const lockSuggestion = parseLockSuggestion(parsed.lockSuggestion);
    // #1572 (T9) — alarmEvents parse (optional). 부재/형식 mismatch entry는 graceful drop —
    // 잔여만 채택 (passedStations와 동일 패턴).
    const alarmEvents = parseAlarmEventsMirror(parsed.alarmEvents);
    // #1705 — currentStationLine parse (optional). non-empty string만 채택.
    const currentStationLine =
      typeof parsed.currentStationLine === 'string' && parsed.currentStationLine.length > 0
        ? parsed.currentStationLine
        : undefined;
    // #2593 — tripToken parse (optional). 레거시 저장분(필드 부재)은 undefined로 정규화 —
    // persistBackendSsotMirror 단조성 가드가 same-trip으로 취급하는 것과 동일 계약.
    const tripToken =
      typeof parsed.tripToken === 'string' && parsed.tripToken.length > 0
        ? parsed.tripToken
        : undefined;
    return {
      currentStationId: parsed.currentStationId,
      motionState: parsed.motionState,
      lastAdvanceEvidence: parsed.lastAdvanceEvidence,
      lastAdvanceAt: parsed.lastAdvanceAt,
      passedStations: parsed.passedStations.filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      ),
      receivedAt: parsed.receivedAt,
      ...(lockSuggestion ? { lockSuggestion } : {}),
      ...(alarmEvents !== undefined ? { alarmEvents } : {}),
      ...(currentStationLine !== undefined ? { currentStationLine } : {}),
      ...(tripToken !== undefined ? { tripToken } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * #1572 (T9) — alarmEvents JSON parse + 형식 검증. 항목별 형식 misjudge 시 graceful drop.
 *
 * raw가 array가 아니면 undefined (필드 자체 omit). array면 각 entry를 narrow — 통과한 것만 채택.
 * 잔여 0개여도 빈 배열 반환 (caller는 "fresh empty" vs "missing"을 mirror.alarmEvents 정의 여부로 구분).
 *
 * AsyncStorage 영속 mirror read 시(`readBackendSsotMirror`)와 silent push payload validation 시
 * (`silentPushTask.validSsotMirror`) 둘 다 같은 형식 narrow가 필요 — 양쪽에서 본 함수를 호출한다.
 * 통합으로 SonarCloud CPD dup 회피 + backend AlarmEventPayload 어휘 확장 시 단일 진입점.
 */
export function parseAlarmEventsMirror(raw: unknown): readonly AlarmEventMirror[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered: AlarmEventMirror[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.alarmId !== 'string' || o.alarmId.length === 0) continue;
    if (typeof o.stationId !== 'string' || o.stationId.length === 0) continue;
    if (
      o.type !== 'station-passed' &&
      o.type !== 'transfer' &&
      o.type !== 'destination' &&
      o.type !== 'imminent'
    ) {
      continue;
    }
    if (typeof o.decidedAt !== 'number' || !Number.isFinite(o.decidedAt)) continue;
    filtered.push({
      alarmId: o.alarmId,
      stationId: o.stationId,
      type: o.type,
      decidedAt: o.decidedAt,
    });
  }
  return filtered;
}

/**
 * #1534 (S1, T9b) — JSON에서 LockSuggestionMirror 형식 검증 후 narrow.
 *
 * 필드 누락/타입 mismatch 시 null. graceful — device는 9-AND gate fallback. 본 함수가 backend
 * forward 호환의 단일 진입점이라 backend가 confidence 어휘를 확장(예: 'very-high')해도 device가
 * graceful drop으로 동작 (필드 자체 무효 시).
 */
function parseLockSuggestion(raw: unknown): LockSuggestionMirror | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.stationId !== 'string' || o.stationId.length === 0) return null;
  if (typeof o.trainCode !== 'string' || o.trainCode.length === 0) return null;
  if (typeof o.lineId !== 'string' || o.lineId.length === 0) return null;
  if (
    o.confidence !== 'high' &&
    o.confidence !== 'medium' &&
    o.confidence !== 'low' &&
    o.confidence !== 'consensus'
  ) {
    return null;
  }
  if (typeof o.decidedAt !== 'number' || !Number.isFinite(o.decidedAt)) return null;
  return {
    stationId: o.stationId,
    trainCode: o.trainCode,
    lineId: o.lineId,
    confidence: o.confidence,
    decidedAt: o.decidedAt,
  };
}
