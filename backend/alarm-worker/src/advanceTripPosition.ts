/**
 * advanceTripPosition — ADR-017 T2 단일 mutation 진입점 (Epic #1553, Sub #1555).
 *
 * 배경
 * ====
 * 2026-06-19 evidence: 정지 trip + lock active + arvlcd ARRIVED → wrong "transfer imminent
 * 건대입구" 발사. 분산된 fire path별 게이트가 다 달랐다:
 *   - `scheduled.ts:795 evaluateArvlCdFireGate` — lock+arvlCd만
 *   - lockless `LOCKLESS_ADVANCE_MOTION_MODES` — lockless만 motion 검증
 *   - vanish path `isFallbackAdvanceBlockedByMotion` — vanish만 stationary 차단
 *   - `evaluateConsensusGate` — 호출자 미적용
 *
 * 본 T2는 단일 진입점 `advanceTripPosition`을 도입해 6단 게이트를 강제한다.
 * 본 PR은 함수 + 테스트만 추가하고 기존 fire path를 변경하지 않는다 (T4~T7가 reader migration).
 *
 * 6단 게이트 (순서 강제, ADR-017)
 * ===============================
 *   #1 Seed 게이트         — SSoT 미존재 / currentStationId 없으면 blocked('no-seed')
 *   #2 Motion 게이트       — motionState==='stationary' 이고 userIntentDeclared=false면 blocked('motion-stationary')
 *                            ([[feedback_user_intent_equal_protection]] — userIntent ON trip은
 *                             lock 활성과 동급 정확도 → motion stationary 게이트도 우회 X 아닌 동급 처리.
 *                             그러나 P8 acceptance "userIntentDeclared=true + 정지 → advanced"가
 *                             명시되어 있어 #2에서만 명시 의향 trip을 통과시킨다. 다른 게이트는 동급.)
 *   #3 Environment 게이트  — evaluateConsensusGate 통과 필수 (지하 GPS-only false positive 차단)
 *   #4 Evidence type 게이트 — ADR-015 §E4: 'time-only' evidence 절대 거부
 *   #5 Train identity 게이트 — lock 활성 + arvlcd-confirmed-train evidence면 trainCode 일치 필수
 *   #6 Lockless arvlcd 단독 게이트 — lock 없는 trip에서 arvlcd-lockless 단독은 60s 윈도우 내
 *                                    strong evidence 1+개가 추가로 있어야 통과
 *
 * Seed override (E5)
 * ==================
 * `trySeedOverride`가 strong evidence 2+개 + 30s 연속 일치 시 currentStationId 정정.
 * passedStations은 초기화 (잘못 stamp된 station 폐기). seedOverrideCount += 1.
 *
 * Out of scope (본 PR)
 * ====================
 * - 기존 fire path 변경 (T4~T7가 reader migration)
 * - KV CAS retry (issue 본문 §Race safety — "last write wins" 허용. motionEvidence ring buffer로 손실 X)
 * - WiFi SSID map 데이터 자체 (`subwayWifiSsidMap.json`) backend 임포트 — `lookupStationFromWifiSsid`는
 *   injectable entries 인자를 받는 순수 함수로 두고, 실제 매핑 데이터 wire는 T3 (device/position upload
 *   payload에 `wifiSsid` 추가 + backend wire) 또는 별도 데이터 module로 분리한다.
 */

import { evaluateConsensusGate, type StationEnvironment } from './consensusGate';
import type { ArrivalEntry, PositionEntry } from './seoul';
import {
  isSameLockSuggestion,
  MOTION_EVIDENCE_CAP,
  readSsot,
  setLockSuggestion,
  writeSsot,
  type EvidenceType,
  type LockSuggestion,
  type MotionEvidence,
  type TripPositionSSoT,
} from './tripPositionSsot';
import { getTrip } from './trips';
import type { BoardingLockMeta, Trip } from './types';

/**
 * Evidence environment — device가 upload하는 좁은 set.
 *
 * 'hybrid'는 `consensusGate.StationEnvironment` 의 'mixed'에 매핑된다 (E1 #1444 stations.json
 * 필드와 device payload 어휘가 달라서). `mapEvidenceEnvironment`가 변환.
 */
export type EvidenceEnvironment = 'surface' | 'underground' | 'hybrid' | 'unknown';

/**
 * Strong evidence type — 게이트 #6 + seedOverride 공통.
 *
 * 단일 신호만으로 advance를 견인할 수 있는 weight. GPS는 의도적으로 제외 (지하 false positive 차단).
 */
export const STRONG_EVIDENCE_TYPES: ReadonlySet<EvidenceType> = new Set<EvidenceType>([
  'arvlcd-confirmed-train',
  'wifi-ssid-match',
  'cellular-tech-change',
  'position-train',
  'accel-fingerprint',
]);

/**
 * Cellular tech vote — `evaluateConsensusGate.cellularEnvironmentVote` 입력 호환.
 */
export type CellularTechVote = 'surface' | 'underground' | 'unknown';

/**
 * 단일 advance 후보 evidence. caller(T3/T4+ fire path)가 본 객체로 advance 시도.
 *
 * - `arvlcdTrainCode` — evidence type 이 arvlcd 계열일 때 lock.trainCode와 cross-check (E8)
 * - `wifiSsid` — 'wifi-ssid-match'일 때 caller가 lookup 결과를 stamp (E6)
 * - `cellularTechVote` — `consensusGate.cellularEnvironmentVote`로 forward (S10)
 */
export interface AdvanceEvidence {
  type: EvidenceType;
  /** evidence 발생 stationId. seedOverride consecutive 윈도우 일치 비교 + passedStations stamp용. */
  stationId: string;
  /** evidence 발생 시각 (epoch ms). 게이트 #5 lock.expiresAt 비교 + window 산출. */
  ts: number;
  /** device가 upload한 environment vote ([[reference_wifi_ssid_100pct_mapped]] 게이트 #3). */
  environment: EvidenceEnvironment;
  /** arvlcd 계열 evidence의 train identity (E8). lock 활성 시 lock.trainCode와 일치 강제. */
  arvlcdTrainCode?: string;
  /** Seoul API arvlCd 원본 (게이트 #3 arrivalSignalPresent 신호로 매핑). */
  arvlCd?: number | null;
  /** 매핑된 arrival 원본 (caller가 보유 시 forward — 본 함수는 caller가 채워준 가공 신호만 사용). */
  arrivalEntry?: ArrivalEntry;
  /** Seoul realtimePosition entry (caller forward — 본 함수는 type='position-train' weight로만 사용). */
  positionEntry?: PositionEntry;
  /** WiFi SSID 원본 — 진단/observability stamp용. lookup은 caller가 수행. */
  wifiSsid?: string;
  /** consensusGate에 forward할 cellular vote (S10 #1543). */
  cellularTechVote?: CellularTechVote;
  /** accel fingerprint 식별자 (S9, type='accel-fingerprint' 시). */
  accelFingerprint?: string;
}

/** advance 시도 결과. */
export type AdvanceResult = 'advanced' | 'blocked' | 'noop';

/** advance 차단 사유 — production stats 분포 측정용. */
export type AdvanceBlockReason =
  | 'no-seed'
  | 'no-trip'
  | 'motion-stationary'
  | 'env-consensus-fail'
  | 'time-only-forbidden'
  | 'train-mismatch'
  | 'lockless-arvlcd-alone';

/** advance 호출 결과 — caller가 SSoT 후속 작업(fire 발사 등)을 진행할지 결정. */
export interface AdvanceOutcome {
  result: AdvanceResult;
  blockReason?: AdvanceBlockReason;
  ssot: TripPositionSSoT | null;
}

/**
 * 게이트 분포 측정용 stats. production에서 분포 수집 → acceptance 검증.
 */
export interface AdvanceStats {
  advanceTotal: number;
  blockedNoSeed: number;
  blockedNoTrip: number;
  blockedMotionStationary: number;
  blockedEnvConsensus: number;
  blockedTimeOnly: number;
  blockedTrainMismatch: number;
  blockedLocklessArvlcdAlone: number;
  seedOverrideAttempted: number;
  seedOverrideAccepted: number;
}

/** 단일 WiFi SSID → stationId(=stationName canonical) lookup entry. */
export interface WifiSsidEntry {
  stationId: string;
  patterns: readonly string[];
}

/**
 * Evidence environment ('hybrid') → consensusGate environment ('mixed') 변환.
 *
 * device payload 어휘와 backend `StationEnvironment`(E1 #1444 stations.json 필드)가 다르기에
 * 단일 지점에서 매핑. 'unknown'은 보수적으로 'unknown'으로 forward (consensusGate가 mixed 동급으로 다룸).
 */
export function mapEvidenceEnvironment(env: EvidenceEnvironment): StationEnvironment {
  if (env === 'hybrid') return 'mixed';
  return env;
}

/**
 * MotionEvidence ring buffer 내에서 윈도우 [sinceMs, +∞) strong evidence 카운트.
 *
 * `MotionEvidence.signal`은 unknown payload — caller(T3)가 evidence type을 어떤 key로 stamp하는지에
 * 의존. 본 함수는 보수적으로 signal이 객체이면 `.type` 또는 `.evidenceType` 키를 찾아 type 추출.
 * 그 외(원시값 / type 키 부재)는 미카운트 — strong 신호로 보장 못 함.
 */
export function countStrongEvidence(motionEvidence: readonly MotionEvidence[], sinceMs: number): number {
  let count = 0;
  for (const e of motionEvidence) {
    if (e.ts < sinceMs) continue;
    const type = extractEvidenceType(e.signal);
    if (type !== null && STRONG_EVIDENCE_TYPES.has(type)) count += 1;
  }
  return count;
}

function extractEvidenceType(signal: unknown): EvidenceType | null {
  if (signal === null || typeof signal !== 'object') return null;
  const obj = signal as { type?: unknown; evidenceType?: unknown };
  const raw = obj.type ?? obj.evidenceType;
  if (typeof raw !== 'string') return null;
  return raw as EvidenceType;
}

/**
 * 같은 stationId를 가리키는 strong evidence가 끊김 없이 도착한 윈도우의 ts 범위 (max - min).
 *
 * 인접 evidence 사이 gap ≤ 60s를 "연속"으로 본다. 첫 evidence stationId 기준으로 필터한 뒤
 * sort + gap 검증 후 끝-시작 차이를 반환. 연속 끊기면 0.
 *
 * 입력 list가 비어 있거나 단일 entry면 0 (단일은 "연속 윈도우"가 아니므로).
 */
export function consecutiveDurationMs(strongEvidence: readonly AdvanceEvidence[]): number {
  if (strongEvidence.length === 0) return 0;
  const first = strongEvidence[0];
  const sorted = strongEvidence
    .filter((e) => e.stationId === first.stationId)
    .slice()
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length < 2) return 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].ts - sorted[i - 1].ts > 60_000) return 0;
  }
  return sorted[sorted.length - 1].ts - sorted[0].ts;
}

/**
 * AdvanceEvidence → evaluateConsensusGate 신호 변환.
 *
 * `gateOutcome`는 외부에서 산출되어야 하는 9단 AND 게이트 결과 — 본 함수는 caller가 stamp한 값을
 * 그대로 forward한다. arrivalSignalPresent / lockAttachable / positionTrainAgreement /
 * wifiSsidMatch는 evidence type 기반으로 유도.
 */
export function buildSignalsFromEvidence(
  evidence: AdvanceEvidence,
  options: { gatePassed: boolean; lockAttachable: boolean },
): Parameters<typeof evaluateConsensusGate>[1] {
  const arvlCdValid =
    typeof evidence.arvlCd === 'number' && evidence.arvlCd >= 0 && evidence.arvlCd <= 3;
  const arrivalSignalPresent =
    evidence.type === 'arvlcd-confirmed-train' ||
    evidence.type === 'arvlcd-lockless' ||
    arvlCdValid;
  return {
    gateOutcome: options.gatePassed
      ? {
          pass: true,
          metrics: {
            count: 0,
            gpsAvgKmh: 0,
            avgAccuracyMeters: 0,
            motion: 'unknown',
            start: null,
            end: null,
            mapMatchedKmh: null,
          },
          fusedSpeedKmh: 0,
        }
      : { pass: false, reason: 'window-too-small' },
    arrivalSignalPresent,
    lockAttachable: options.lockAttachable,
    positionTrainAgreement: evidence.type === 'position-train' ? true : undefined,
    wifiSsidMatch: evidence.type === 'wifi-ssid-match' ? true : undefined,
    cellularEnvironmentVote: evidence.cellularTechVote,
  };
}

/**
 * WiFi SSID → stationId 조회. 미매칭 시 null.
 *
 * 본 함수는 injectable `entries` 리스트를 받는다 — 실제 매핑 데이터(`subwayWifiSsidMap.json`)는
 * T3 wire-up에서 주입 (본 PR은 함수 logic + 테스트만). pattern은 case-insensitive regex.
 */
export function lookupStationFromWifiSsid(
  ssid: string | null | undefined,
  entries: readonly WifiSsidEntry[],
): string | null {
  if (typeof ssid !== 'string') return null;
  const trimmed = ssid.trim();
  if (trimmed.length === 0) return null;
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        continue;
      }
      if (re.test(trimmed)) return entry.stationId;
    }
  }
  return null;
}

/**
 * advance 시도 — 6단 게이트 통과 시 SSoT mutation + write.
 *
 * @param kv SSOT / Trip KV namespace (둘 다 동일 namespace 가정, T1 + trips.ts 패턴).
 * @param tripKv Trip KV (lock 조회용).
 * @param token APNs device token (SSoT key).
 * @param candidateStationId advance하려는 station identifier.
 * @param evidence advance 후보 evidence (1건).
 * @param options.gatePassed 외부 9단 AND 게이트 결과 (caller가 stamp). 미stamp 시 false.
 * @param options.lockAttachable `pickAutoTrainCode` 단일 수렴 여부. caller stamp.
 *
 * blocked 시 SSoT는 mutate 하지 않음. 'noop'은 현재 게이트에서 발생하지 않지만 향후 reader
 * migration이 idempotent advance(이미 같은 stationId)를 'noop'으로 처리할 수 있는 type slot.
 */
export async function advanceTripPosition(
  kv: KVNamespace,
  token: string,
  candidateStationId: string,
  evidence: AdvanceEvidence,
  options: { gatePassed: boolean; lockAttachable: boolean },
): Promise<AdvanceOutcome> {
  const ssot = await readSsot(kv, token);

  // #1 Seed 게이트
  if (ssot === null || !ssot.currentStationId) {
    return { result: 'blocked', blockReason: 'no-seed', ssot };
  }

  // #5 (lock 조회를 위해 trip을 미리 fetch — #2/#3/#4 검증 비용보다 1건 KV read가 가볍고,
  //      이후 게이트 분기에 활용)
  const trip = await getTrip(kv, token);
  if (trip === null) {
    return { result: 'blocked', blockReason: 'no-trip', ssot };
  }
  const lock = pickActiveLock(trip, evidence.ts);

  // #2 Motion 게이트 — userIntentDeclared trip은 명시 의향이므로 통과 (P8 acceptance).
  if (ssot.motionState === 'stationary' && !ssot.userIntentDeclared) {
    return { result: 'blocked', blockReason: 'motion-stationary', ssot };
  }

  // #3 Environment 게이트
  const consensusOutcome = evaluateConsensusGate(
    mapEvidenceEnvironment(evidence.environment),
    buildSignalsFromEvidence(evidence, {
      gatePassed: options.gatePassed,
      lockAttachable: options.lockAttachable,
    }),
  );
  if (!consensusOutcome.pass) {
    return { result: 'blocked', blockReason: 'env-consensus-fail', ssot };
  }

  // #4 Evidence type 게이트 (ADR-015 §E4 — time-only 절대 거부)
  if (evidence.type === 'time-only') {
    return { result: 'blocked', blockReason: 'time-only-forbidden', ssot };
  }

  // #5 Train identity 게이트
  if (lock !== undefined && evidence.type === 'arvlcd-confirmed-train') {
    if (evidence.arvlcdTrainCode !== lock.trainCode) {
      return { result: 'blocked', blockReason: 'train-mismatch', ssot };
    }
  }

  // #6 Lockless arvlcd 단독 게이트 — 60s 윈도우 내 추가 strong evidence 1+ 필요
  if (lock === undefined && evidence.type === 'arvlcd-lockless') {
    const otherStrong = countStrongEvidence(ssot.motionEvidence, evidence.ts - 60_000);
    if (otherStrong < 1) {
      return { result: 'blocked', blockReason: 'lockless-arvlcd-alone', ssot };
    }
  }

  // Advance — SSoT mutate + write
  const next: TripPositionSSoT = {
    ...ssot,
    passedStations: appendUnique(ssot.passedStations, ssot.currentStationId),
    currentStationId: candidateStationId,
    lastAdvanceAt: evidence.ts,
    lastAdvanceEvidence: evidence.type,
  };

  applyLockSuggestion(next, ssot, {
    lockActive: lock !== undefined,
    candidateStationId,
    evidence,
    waypointLine: trip.waypoints[0]?.line,
  });

  await writeSsot(kv, next, { expiresAt: trip.expiresAt });
  return { result: 'advanced', ssot: next };
}

/**
 * #1534 (S1, T9b) — lockless trip + 강 evidence 합의 시 lockSuggestion 추론.
 *
 * device가 `useLockSuggestion`으로 본 값을 1순위 채택해 lock 없이도 fire path를 활성화한다
 * (lockless 첫 station miss 0 acceptance V2). lock 활성 trip에는 set하지 않음 (기존 lock이
 * SSOT 그대로 forward — 별 reader 정책 불필요).
 *
 * 기존 lockSuggestion이 동일 stationId+trainCode+lineId면 보존 (KV write 비용 최소화 +
 * device cascade picker가 receivedAt drift로 무용한 re-render 방지). 어떤 분기에서도 기존
 * suggestion이 silently dropped되지 않도록 항상 forward.
 */
function applyLockSuggestion(
  next: TripPositionSSoT,
  prev: TripPositionSSoT,
  input: {
    lockActive: boolean;
    candidateStationId: string;
    evidence: AdvanceEvidence;
    waypointLine: string | undefined;
  },
): void {
  const suggestion = deriveLockSuggestion(input);
  if (suggestion && !isSameLockSuggestion(prev.lockSuggestion, suggestion)) {
    setLockSuggestion(next, suggestion);
    return;
  }
  if (prev.lockSuggestion) {
    // 기존 suggestion 보존 — drop 회귀 차단.
    next.lockSuggestion = prev.lockSuggestion;
  }
}

/**
 * #1534 (S1, T9b) — advance 통과 evidence로부터 lockSuggestion 추론.
 *
 * 정책:
 *   - lock 활성 trip: suggestion 미설정 (이미 lock이 source of truth)
 *   - lock 없음 + arvlcd-confirmed-train + arvlcdTrainCode 보유: high confidence suggestion
 *   - lock 없음 + position-train + positionEntry.trainCode 보유: medium confidence
 *   - 그 외 (gps / cellular / wifi 단독 등): 약 evidence — suggestion 없음 (caller가 다른 cycle 기다림)
 *
 * lineId는 waypointLine(trip route 첫 waypoint의 line)을 사용 — Seoul API는 ArrivalEntry/
 * PositionEntry에 line 식별자(subwayId)를 제공하지 않으므로 trip route SSOT를 신뢰한다.
 * 환승 hop 이후 (waypoint shift) 도 첫 waypoint가 현재 leg의 line이라 동일 패턴 적용.
 */
function deriveLockSuggestion(input: {
  lockActive: boolean;
  candidateStationId: string;
  evidence: AdvanceEvidence;
  waypointLine: string | undefined;
}): LockSuggestion | null {
  if (input.lockActive) return null;
  if (!input.waypointLine) return null;
  const { evidence, candidateStationId, waypointLine } = input;
  // 강 (high) — arvlcd-confirmed-train evidence는 trainCode 확정. lineId는 waypoint line.
  if (evidence.type === 'arvlcd-confirmed-train' && evidence.arvlcdTrainCode) {
    return {
      stationId: candidateStationId,
      trainCode: evidence.arvlcdTrainCode,
      lineId: waypointLine,
      confidence: 'high',
      decidedAt: evidence.ts,
    };
  }
  // 중 (medium) — position-train evidence는 Seoul realtimePosition 매칭 trainCode.
  if (evidence.type === 'position-train' && evidence.positionEntry?.trainCode) {
    return {
      stationId: candidateStationId,
      trainCode: evidence.positionEntry.trainCode,
      lineId: waypointLine,
      confidence: 'medium',
      decidedAt: evidence.ts,
    };
  }
  return null;
}

/**
 * Seed override (E5).
 *
 * Strong evidence 2+개가 같은 stationId를 30s 이상 연속 가리키면 currentStationId를 정정.
 * passedStations는 초기화 (잘못 stamp된 station 폐기). seedOverrideCount += 1.
 *
 * @returns 'override' (적용됨) | 'reject' (조건 미달 / SSoT 없음)
 */
export async function trySeedOverride(
  kv: KVNamespace,
  token: string,
  newStationId: string,
  evidenceList: readonly AdvanceEvidence[],
): Promise<'override' | 'reject'> {
  const ssot = await readSsot(kv, token);
  if (ssot === null) return 'reject';
  const strong = evidenceList.filter((e) => STRONG_EVIDENCE_TYPES.has(e.type));
  if (strong.length < 2) return 'reject';
  const duration = consecutiveDurationMs(strong);
  if (duration < 30_000) return 'reject';
  const trip = await getTrip(kv, token);
  const expiresAt = trip?.expiresAt;
  const next: TripPositionSSoT = {
    ...ssot,
    currentStationId: newStationId,
    passedStations: [],
    seedOverrideCount: ssot.seedOverrideCount + 1,
    lastAdvanceEvidence: 'seed-override',
  };
  await writeSsot(kv, next, expiresAt !== undefined ? { expiresAt } : undefined);
  return 'override';
}

/**
 * trip.boardingLock이 evidence 시점에 활성인지 확인 후 반환. 만료/부재 시 undefined.
 */
function pickActiveLock(trip: Trip, ts: number): BoardingLockMeta | undefined {
  const lock = trip.boardingLock;
  if (!lock) return undefined;
  if (lock.expiresAt <= ts) return undefined;
  return lock;
}

function appendUnique(arr: readonly string[], next: string): string[] {
  if (arr.includes(next)) return arr.slice();
  const copy = arr.slice();
  copy.push(next);
  // motionEvidence와 동일한 ring buffer cap을 적용해 KV row 폭주 방지.
  while (copy.length > MOTION_EVIDENCE_CAP) copy.shift();
  return copy;
}
