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
import type { LineNumber, Station } from '../../../shared/types/station';
import { findStationByName, findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { BACKEND_SSOT_MIRROR_MAX_AGE_MS } from '../../../shared/constants/realtime';

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
   * #2593 (code-review 수정) — mirror가 소속된 trip 인스턴스 식별자.
   *
   * **`tripToken`이 아니라 `corrId`를 쓴다** — tripToken은 APNs 기기 토큰이라 기기당 고정이고
   * (types.ts, #2120), 같은 기기가 trip을 재등록해도 값이 바뀌지 않는다. 그 tripToken을
   * same-trip 판정 키로 쓰면 "다른 trip" 분기가 사실상 dead code가 되고, 누수된 옛 trip mirror가
   * 새 trip의 `lastAdvanceAt=0` seed push(`positionUpload.persistFromPositionResponse` legacy
   * 합성)를 전부 stale-skip해버리는 역효과가 생긴다(register-retry가 `clearBackendSsotMirror`
   * 없이 ACTIVE_TRIP만 갱신하는 시나리오).
   *
   * `corrId`는 trip 등록마다 새로 발급되는 인스턴스 식별자(`tripCorrId.ts`, #1501/#2120 — trip-ended
   * corrId 가드와 동일 계약)이므로 이 판정에 적합하다. 호출부는 device의 현재 corrId
   * (`getCurrentTripCorrIdSync()`)를 stamp한다 — payload가 corrId를 실어 보낼 필요가 없어
   * 백엔드 계약 변경 없이 device 자체 정보만으로 동작한다.
   *
   * 구 저장분/구 호출부 호환 위해 optional — 부재 시(레거시 stored entry 포함) same-trip으로
   * 취급해 기존 가드 동작 보존.
   */
  corrId?: string;
  /**
   * #2593 (code-review 수정) — backend 발사 시점 epoch ms (silent push payload의 `sentAt` echo).
   *
   * `lastAdvanceAt`이 동일한 두 push(예: `trySeedOverride`/모션 갱신처럼 advance 없이 재수신되는
   * push)는 `lastAdvanceAt`만으로 순서를 못 가른다 — 늦게 도착한 구 push가 보정된 값을 되돌릴 수
   * 있다. `persistBackendSsotMirror`가 `lastAdvanceAt` 동률일 때 `sentAt`으로 tie-break한다.
   * 한쪽이라도 없으면(구 backend/구 저장분) tie-break를 skip하고 기존처럼 수용한다.
   */
  sentAt?: number;
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
 * mirror가 있고 **같은 trip**(`corrId` 일치 — 정의는 `SilentPushSsotMirror.corrId` 참조)이며
 * incoming.lastAdvanceAt이 existing보다 과거면 write를 skip한다. **다른 trip이면 무조건 수용** —
 * 새 trip의 작은 lastAdvanceAt를 이전 trip 기준으로 거부하면 안 된다.
 *
 * `lastAdvanceAt`이 동률이면(advance 없는 사이 재수신) 기본은 수용하되, 양쪽에 `sentAt`이 모두
 * 있으면 그것으로 재정렬 창을 한 번 더 가른다(`SilentPushSsotMirror.sentAt` 참조) — 동일 역에서
 * `trySeedOverride`/모션 보정처럼 advance를 안 올리는 구 push가 새 push를 되돌리는 것을 차단.
 *
 * #2593 — TOCTOU 하드닝: read(`readBackendSsotMirror`) → write(`AsyncStorage.setItem`) 사이 다른
 * 호출이 인터리브하면 두 호출이 같은 stale `existing`을 보고 동시에 write할 수 있다. 모듈 레벨
 * promise chain(`mirrorWriteQueue`)으로 호출을 직렬화 — 동시 호출도 항상 이전 write가 끝난 뒤의
 * `existing`을 read한다.
 */
let mirrorWriteQueue: Promise<void> = Promise.resolve();

export function persistBackendSsotMirror(
  ssot: SilentPushSsotMirror,
  receivedAt: number,
): Promise<void> {
  mirrorWriteQueue = mirrorWriteQueue.then(() =>
    persistBackendSsotMirrorSerialized(ssot, receivedAt),
  );
  return mirrorWriteQueue;
}

async function persistBackendSsotMirrorSerialized(
  ssot: SilentPushSsotMirror,
  receivedAt: number,
): Promise<void> {
  try {
    const existing = await readBackendSsotMirror();
    if (existing !== null) {
      const sameTrip =
        existing.corrId === undefined ||
        ssot.corrId === undefined ||
        existing.corrId === ssot.corrId;
      if (sameTrip) {
        if (ssot.lastAdvanceAt < existing.lastAdvanceAt) {
          logger.info(
            `ssot-mirror-stale-skip: incoming station=${ssot.currentStationId} lastAdvanceAt=${ssot.lastAdvanceAt} existing station=${existing.currentStationId} lastAdvanceAt=${existing.lastAdvanceAt}`,
          );
          return;
        }
        if (
          ssot.lastAdvanceAt === existing.lastAdvanceAt &&
          ssot.sentAt !== undefined &&
          existing.sentAt !== undefined &&
          ssot.sentAt < existing.sentAt
        ) {
          logger.info(
            `ssot-mirror-stale-skip: incoming station=${ssot.currentStationId} sentAt=${ssot.sentAt} existing station=${existing.currentStationId} sentAt=${existing.sentAt} (lastAdvanceAt tie)`,
          );
          return;
        }
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
    // #2593 — corrId parse (optional). 레거시 저장분(필드 부재)은 undefined로 정규화 —
    // persistBackendSsotMirror 단조성 가드가 same-trip으로 취급하는 것과 동일 계약.
    const corrId =
      typeof parsed.corrId === 'string' && parsed.corrId.length > 0 ? parsed.corrId : undefined;
    // #2593 — sentAt parse (optional). lastAdvanceAt 동률 tie-break에만 사용.
    const sentAt =
      typeof parsed.sentAt === 'number' && Number.isFinite(parsed.sentAt)
        ? parsed.sentAt
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
      ...(corrId !== undefined ? { corrId } : {}),
      ...(sentAt !== undefined ? { sentAt } : {}),
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

/**
 * #2591 (code review 7번, SonarCloud dup 회피) — backend SSoT mirror freshness(≤180s,
 * `BACKEND_SSOT_MIRROR_MAX_AGE_MS`) 단일 판정 진입점.
 *
 * 동일 `mirror !== null && Date.now() - mirror.receivedAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS` 식이
 * `useBackendSsotMirrorPoll`(FG 5s 폴링) / `refreshLiveActivityFromBackgroundContext`(BG LA 갱신) /
 * 로컬 boarding-prompt 억제 게이트(`fireLocalBoardingPromptNotification`) 3곳에 사본으로 존재해
 * 상한값 drift 위험이 있었다 — 이 함수로 통합해 세 소비처가 공유한다. `now` 파라미터는 테스트용
 * (기본 `Date.now()`).
 */
export function isBackendSsotMirrorFresh(
  mirror: Pick<BackendSsotMirrorEntry, 'receivedAt'> | null,
  now: number = Date.now(),
): boolean {
  return mirror !== null && now - mirror.receivedAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS;
}

/**
 * #2589 (code review) — backend SSoT mirror의 currentStationId(+line)를 stations.json Station으로
 * 해석하는 단일 진입점. FG cascade picker(`useFusedNearestStation`의 `ssotGuardResult`)와 BG LA
 * refresh(`refreshLiveActivityFromBackgroundContext`)가 동일 함수를 공유해, 같은 입력에 서로 다른
 * 판정(한쪽은 line 불일치를 "보정", 다른 쪽은 "거부")이 발생하는 의미론 drift를 원천 차단한다.
 *
 * 의미론(FG 기존 계약과 100% 동일, additive 아님 — 순수 추출):
 *   - `lockLine`(사용자가 탑승 확정한 노선) 주어짐 → 그 line으로 정확 매칭만. 불일치/미존재면 **거부(null)**.
 *   - `lockLine` 없고 `mirror.currentStationLine`(backend forward) 있음 → 그 line으로 정확 매칭만.
 *     불일치/미존재면 **거부(null)** — ADR-038 `resolveConsistentStationLine`처럼 다른 실제 노선으로
 *     "보정"하지 않는다. 보정은 이미 채택된 station의 표시 노선 통일용(다른 문제)이지, mirror
 *     자체의 신뢰성 판정(채택 여부)에는 부적합 — 틀린 노선을 보정해 채택하면 그 mirror가 애초에
 *     신뢰 불가능한 상태(동명 환승역 오매칭 등)라는 신호를 무시하게 된다.
 *   - 둘 다 없음(legacy v1 mirror, currentStationLine 필드 자체 부재) → name-only fallback(기존 동작).
 *
 * 거부(null) 시 caller는 다음 cascade tier로 fallback한다 — FG는 estimator/GPS, LA refresh는
 * BG_LAST_STATION(GPS).
 */
export function resolveBackendSsotMirrorStation(
  mirror: Pick<SilentPushSsotMirror, 'currentStationId' | 'currentStationLine'>,
  lockLine?: LineNumber,
): Station | null {
  if (lockLine !== undefined) {
    return findStationByNameAndLine(mirror.currentStationId, lockLine);
  }
  if (mirror.currentStationLine !== undefined) {
    return findStationByNameAndLine(
      mirror.currentStationId,
      mirror.currentStationLine as LineNumber,
    );
  }
  return findStationByName(mirror.currentStationId);
}
