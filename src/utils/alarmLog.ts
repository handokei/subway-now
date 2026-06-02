import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';
import { ALARM_LOG_KEY } from '../constants/storageKeys';
import { createLogger } from './logger';
import type { AlarmEvent } from './stationAlarm';
import type { AlarmPhaseId } from './alarmPhases';
import type { Station } from '../types/station';

// 알람 발사/억제 이벤트를 AsyncStorage ring buffer로 적재한다.
// false alarm 인지(B2) 및 차후 임계값 측정 기반 재조정(A)·GPS+Arrival fusion(C)의
// 측정 인프라. 정책 변경 없이 관찰만 한다.
//
// Buffer 크기는 ALARM_LOG_BUFFER_SIZE 상수로 분리 — 늘리려면 한 곳만 수정.
export const ALARM_LOG_BUFFER_SIZE = 200;

// #735 — appendAlarmLog 배치 정책.
// 기존: 매 호출마다 AsyncStorage RMW(get → parse → push → stringify → set) → JS thread 점유 (10-50ms × N).
// 변경: in-memory pending에 push 후 debounce + max-delay로 1회 RMW 일괄 처리.
//
// FLUSH_DEBOUNCE_MS: 마지막 push로부터 이 시간 동안 추가 push가 없으면 flush.
// FLUSH_MAX_DELAY_MS: 가장 오래된 pending이 이 시간에 도달하면 즉시 flush — 정상 종료가 아닌
//   경로(앱 강제종료, BG task 만료)에서 손실 cap.
//
// AppState 'background'/'inactive' 진입 시 즉시 flush — OS suspend 전 적재 보장.
// silentPushTask는 종료 직전 명시적으로 await flushAlarmLog() 호출 (BG task 시간 제약).
export const FLUSH_DEBOUNCE_MS = 1_000;
export const FLUSH_MAX_DELAY_MS = 5_000;

// 'fg' / 'bg'는 v1 (FG GPS 평가 / BG location task gate). 'fg-evaluated' / 'bg-scheduled'는
// v2 (#372)로 의미 명확화. 두 값 모두 union에 유지해 과거 저장 데이터를 손실 없이 읽는다.
// 'silent-push-received'는 #478 측정 인프라 — silent push 도달 시점 기록.
// 'silent-push-fired'/'silent-push-skipped'는 #478 PR 1-2 — 위치 게이트 통과/실패 발사.
// 'alert-fallback-fired'는 #564 — 채널 2 alert fallback 도달률 측정용.
// (채널 3 Region Monitoring 슬롯은 #593/ADR-007 폐기 → #618에서 제거)
export type AlarmLogSource =
  | 'fg'
  | 'bg'
  | 'fg-evaluated'
  | 'bg-scheduled'
  | 'silent-push-received'
  | 'silent-push-fired'
  | 'silent-push-skipped'
  | 'alert-fallback-fired'
  // #580: useStationAlarm 하이드레이션 1회당 1엔트리. destinationId + 복원된 fired set 크기 기록.
  // 두 번째 fire 직전에 ref가 비워졌는지 직접 관찰 — race 가설 확인용.
  | 'fg-hydrate';
export type AlarmLogOutcome = 'fired' | 'suppressed' | 'received';
// 'dedup-alarm'(#580): evaluateAlarmPhase의 firedAlarms 적중. destination/transfer phase alarm dedup
// 발생 관찰. station-passed는 별도 메커니즘(lastNotifiedStationId)이라 'dedup-station' 사용.
// 'gate-unknown-station' / 'gate-no-location' / 'gate-stale-location' / 'gate-out-of-range'는
// #478 PR 1-2 silent push 위치 게이트 skip 사유.
// 'payload-missing-kind'는 구 백엔드 payload에 kind 필드가 없어 발사 본문 결정 불가 → skip.
// 'lock-line-mismatch'는 BoardingLock 활성 시 nextWaypoint가 lock.boardingLine에 정차하지
// 않는 다른 leg/노선의 silent push로 판정돼 차단된 케이스 (#707).
export type AlarmLogReason =
  | 'dedup-station'
  | 'dedup-alarm'
  | 'gate-age'
  | 'gate-accuracy'
  | 'gate-jump'
  | 'gate-unknown-station'
  | 'gate-no-location'
  | 'gate-stale-location'
  | 'gate-out-of-range'
  | 'lock-line-mismatch'
  | 'payload-missing-kind'
  // #727 — 정적 misfire 가드(movementGate.ts)가 차단한 발사.
  // #733 — 'movement-static-position'은 speed 미측정 시 위치 이력(usePositionStability) 기반 정적 차단.
  // #728 — 'movement-motion-stationary'는 CMMotionActivity(iOS) motion=stationary 신호 기반.
  | 'movement-no-location'
  | 'movement-stale-timestamp'
  | 'movement-low-accuracy'
  | 'movement-static-speed'
  | 'movement-static-position'
  | 'movement-motion-stationary'
  // #750 — 공통 sleep 룰 게이트(shouldSuppressBySleepRule)가 차단한 발사.
  // scheduler/FG/BG 3개 path 어디서든 같은 reason으로 적재 — 정책 단일 출처.
  | 'sleep-first-transfer';
export type AlarmLogKind = 'destination' | 'transfer' | 'station-passed';
export type AlarmLogDirection = 'up' | 'down';
// #396 — imminent 발사 신호 출처. 'api'는 도착정보 arrivalCode 신호, 'eta'는 기존 ETA 임계.
// early phase 등 imminent 외 발사에선 미설정.
export type AlarmLogTrigger = 'api' | 'eta';

export interface AlarmLogLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  ageMs: number;
}

/**
 * 사전 예약 알람에 첨부되는 컨텍스트 stamp (#372).
 * "이 알람이 어떤 입력값으로 산출됐는가?"를 발사 시점 진단 없이도 알 수 있게 한다.
 *
 * 모든 필드는 null 허용 — caller가 모르면 그대로 null. (예: silent push BG는
 * 방향/trainCode를 모른다.)
 *
 * 시점 주의:
 *   - 사전 예약 알람은 expo-notifications OS 레벨로 발사되므로 fire-time hook이 없다.
 *   - 따라서 `actualLastNotifiedStation`은 발사 시점 값이 아닌 **예약 시점 스냅샷**이다.
 *   - 이름은 이슈 #372 스펙(`actualLastNotifiedStation`)을 유지하지만, 진단 시
 *     "예약 직후 알고 있던 가장 최신 위치"로 해석해야 한다.
 */
export interface AlarmLogStamp {
  direction: AlarmLogDirection | null;
  usedTrainCode: string | null;
  selectedArrivalSeconds: number | null;
  expectedStationAtFire: string | null;
  actualLastNotifiedStation: string | null;
}

export interface AlarmLogEntry {
  ts: number;
  source: AlarmLogSource;
  outcome: AlarmLogOutcome;
  reason?: AlarmLogReason;
  stationName?: string;
  kind?: AlarmLogKind;
  phaseId?: AlarmPhaseId;
  location?: AlarmLogLocation;
  // #372 — 사전 예약 알람 stamp. 모두 optional (구버전/일부 caller 호환).
  direction?: AlarmLogDirection | null;
  usedTrainCode?: string | null;
  selectedArrivalSeconds?: number | null;
  expectedStationAtFire?: string | null;
  actualLastNotifiedStation?: string | null;
  // #478 — silent push 측정 인프라. silent-push-received 엔트리에서만 사용.
  // sentAt: 백엔드 발사 시점(payload), receivedAt: 클라 수신 시점.
  // 두 시각 차로 도달 지연 분포 측정.
  sentAt?: number;
  receivedAt?: number;
  // #396 — imminent phase 발사 trigger 출처. 미설정은 트리거 무관(early 등) 또는 구버전 로그.
  trigger?: AlarmLogTrigger;
  // #478 PR 1-2 — silent push 위치 게이트 결과.
  // silent-push-fired / silent-push-skipped 엔트리에서 사용.
  distanceM?: number;
  thresholdM?: number;
  locationSource?: 'cache' | 'fresh';
  locationAgeMs?: number;
  // #580: fg-hydrate 엔트리 — destinationId + 복원된 fired set 크기.
  destinationId?: string | null;
  firedAlarmsCount?: number;
}

const logger = createLogger('AlarmLog');

// ── 적재 helper ──
// 호출자는 `void log*(...)` 한 줄로 적재한다. ts/source/outcome 등 필드는
// helper가 채운다 — 호출부에서 누락하거나 잘못 채우는 사고를 차단.
// 모든 helper는 fire-and-forget: 실패해도 후속 정합성에 영향 없음(이미 swallow).

export function logFiredAlarm(
  source: AlarmLogSource,
  event: AlarmEvent,
  trigger?: AlarmLogTrigger,
): void {
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
    trigger,
  });
}

/**
 * 사전 예약(BG) 알람 1건의 stamp 컨텍스트를 적재한다 (#372).
 * source는 항상 'bg-scheduled', outcome은 'fired'(사전 예약된 발사 예정 기록).
 * 발사 자체는 expo-notifications가 처리하므로 별도 fire-time 로그는 없다.
 */
export function logScheduledAlarm(event: AlarmEvent, stamp: AlarmLogStamp): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg-scheduled',
    outcome: 'fired',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
    direction: stamp.direction,
    usedTrainCode: stamp.usedTrainCode,
    selectedArrivalSeconds: stamp.selectedArrivalSeconds,
    expectedStationAtFire: stamp.expectedStationAtFire,
    actualLastNotifiedStation: stamp.actualLastNotifiedStation,
  });
}

export function logFiredStationPassed(source: AlarmLogSource, station: Station): void {
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: station.name,
    kind: 'station-passed',
  });
}

export function logSuppressedDedupStation(source: AlarmLogSource, station: Station): void {
  appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'suppressed',
    reason: 'dedup-station',
    stationName: station.name,
    kind: 'station-passed',
  });
}

/**
 * #580: useStationAlarm 하이드레이션 1회당 1엔트리. dedup race 진단용.
 *
 * 두 번째 fire 발생 시점 직전에 ref가 비워졌는지(=fired set이 비어있었는지) 직접 관찰한다.
 * 정상 동작: 하이드레이션 후 firedAlarmsCount는 이전 trip의 fired 누적치(>0)이거나 0(새 trip).
 * 회귀 패턴: fire 이후 destinationId 변동 없이 다시 0이 찍히면 storage write 손실/race 정황.
 */
export function logFiredAlarmsHydrate(destinationId: string | null, firedAlarmsCount: number): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'fg-hydrate',
    outcome: 'received',
    destinationId,
    firedAlarmsCount,
  });
}

/**
 * #580: phase alarm dedup 적중 1건 적재. destination/transfer phase가 firedAlarms로
 * 이미 발화된 것을 evaluateAlarmPhase가 인지해 재발화하지 않을 때 호출.
 * 발사 횟수 vs dedup 횟수 비율로 dedup이 정상 동작 중인지 운영 데이터로 확인 가능.
 *
 * #626: in-memory time-window dedup. FG polling cycle이 매초 같은 phase를 평가해
 * dedup-alarm 로그가 alarmLog 버퍼를 채우는 회귀 차단 (alarmLog 46개 중 41개가 같은
 * 이벤트인 케이스 관측). 같은 (source/type/phaseId/stationName)이 DEDUP_LOG_WINDOW_MS
 * 안에 재호출되면 drop — dedup이 동작 중인지 운영 신호는 첫 1건으로 충분.
 *
 * 키에 type 포함 — 환승역에서 같은 phaseId가 destination/transfer 두 type으로 동시
 * 평가될 때 한쪽이 다른 쪽을 silence하지 않게 (실제 firedAlarms도 type까지 구분함).
 */
export const DEDUP_LOG_WINDOW_MS = 5_000;
const lastDedupLogTs = new Map<string, number>();

/**
 * Map 무한 성장 방지. size가 cap을 넘으면 윈도우 만료된 엔트리 일괄 정리.
 * 정상 trip(소스 × type × phase × 역 ~수십)에선 트리거 안 됨 — 비정상 입력 안전망.
 */
const DEDUP_LOG_MAP_CAP = 64;
function sweepExpiredDedupEntries(now: number): void {
  if (lastDedupLogTs.size <= DEDUP_LOG_MAP_CAP) return;
  for (const [k, ts] of lastDedupLogTs) {
    if (now - ts >= DEDUP_LOG_WINDOW_MS) lastDedupLogTs.delete(k);
  }
}

export function logSuppressedDedupAlarm(
  source: AlarmLogSource,
  event: Pick<AlarmEvent, 'phaseId' | 'type' | 'stationName'>,
): void {
  const now = Date.now();
  const key = `${source}|${event.type}|${event.phaseId}|${event.stationName}`;
  const last = lastDedupLogTs.get(key);
  if (last !== undefined && now - last < DEDUP_LOG_WINDOW_MS) return;
  lastDedupLogTs.set(key, now);
  sweepExpiredDedupEntries(now);
  appendAlarmLog({
    ts: now,
    source,
    outcome: 'suppressed',
    reason: 'dedup-alarm',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
  });
}

/** 테스트용 — 윈도우 캐시 리셋. */
export function _resetDedupAlarmWindowForTests(): void {
  lastDedupLogTs.clear();
}

/**
 * silent push 수신 1건 적재 (#478 측정 인프라).
 * sentAt(백엔드 payload)와 receivedAt(클라 수신 시점) 차로 도달 지연 측정.
 * sentAt이 없으면(구 백엔드) undefined로 기록 — 추후 백엔드 배포 전후 분리 분석 가능.
 * 동작 변경 없음 — 데이터만 모은다.
 */
export function logSilentPushReceived(input: {
  stationName: string;
  kind: AlarmLogKind | 'intermediate' | undefined;
  phaseId: AlarmPhaseId;
  sentAt: number | undefined;
  receivedAt: number;
}): void {
  // 'intermediate'는 station-passed에 매핑 (#416 silent push intermediate 흐름).
  // kind 미상(구 백엔드)이면 kind 필드 자체를 비워둔다.
  const mappedKind: AlarmLogKind | undefined =
    input.kind === 'intermediate' ? 'station-passed' : input.kind;
  appendAlarmLog({
    ts: input.receivedAt,
    source: 'silent-push-received',
    outcome: 'received',
    stationName: input.stationName,
    kind: mappedKind,
    phaseId: input.phaseId,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

/**
 * Reschedule silent push 수신 1건 적재 (#725).
 *
 * 일반 silent push와 source가 같지만(`silent-push-received` — DebugModal `lastReceivedAt`이
 * 자동 갱신되도록), kind/phaseId는 reschedule 의미상 미적용. 추적은 stationName(=nextStation)과
 * sentAt/receivedAt 지연 측정으로 충분.
 *
 * 별도 helper로 분리한 이유: AlarmLogKind/AlarmPhaseId 타입에 'reschedule'을 끼워 넣으면
 * 호출자(다른 logSilentPush*)에 cascade 영향이 발생. 분리하면 reschedule만 isolated 경로.
 */
export function logSilentPushRescheduleReceived(input: {
  nextStation: string;
  sentAt: number | undefined;
  receivedAt: number;
}): void {
  appendAlarmLog({
    ts: input.receivedAt,
    source: 'silent-push-received',
    outcome: 'received',
    stationName: input.nextStation,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
  });
}

/**
 * silent push가 위치 게이트 통과 → 즉시 발사한 1건 (#478 PR 1-2).
 */
export function logSilentPushFired(input: {
  stationName: string;
  kind: AlarmLogKind;
  phaseId: AlarmPhaseId;
  distanceM: number;
  thresholdM: number;
  locationSource: 'cache' | 'fresh';
  locationAgeMs: number;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'silent-push-fired',
    outcome: 'fired',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
    distanceM: input.distanceM,
    thresholdM: input.thresholdM,
    locationSource: input.locationSource,
    locationAgeMs: input.locationAgeMs,
  });
}

/**
 * silent push 위치 게이트 실패 → 발사 skip 한 1건 (#478 PR 1-2).
 * reason은 게이트 사유: gate-unknown-station / gate-no-location /
 * gate-stale-location / gate-out-of-range.
 */
export function logSilentPushSkipped(input: {
  stationName: string;
  kind: AlarmLogKind | undefined;
  phaseId: AlarmPhaseId;
  reason: AlarmLogReason;
  distanceM?: number;
  thresholdM?: number;
  locationSource?: 'cache' | 'fresh';
  locationAgeMs?: number;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'silent-push-skipped',
    outcome: 'suppressed',
    reason: input.reason,
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
    distanceM: input.distanceM,
    thresholdM: input.thresholdM,
    locationSource: input.locationSource,
    locationAgeMs: input.locationAgeMs,
  });
}

/**
 * 채널 2 alert fallback 발사 1건 적재 (#564).
 * 백엔드 ACK 타임아웃 후 alert push가 전달돼 발사된 경우. silent push와 다르게
 * 클라 위치 게이트 없이 OS가 즉시 표시하므로 distance/threshold는 기록하지 않는다.
 */
export function logAlertFallbackFired(input: {
  stationName: string;
  kind: AlarmLogKind;
  phaseId: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'alert-fallback-fired',
    outcome: 'fired',
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

/**
 * 로그 엔트리들을 source별로 카운트한다 (#564).
 * DebugModal 헤더/dump에 채널별 도달률 요약을 표기하기 위한 측정 인프라.
 * 결과는 카운트가 0이 아닌 source만 포함 — 노이즈 줄이고 새 source가 추가돼도
 * 코드 수정 없이 자동 반영된다 (UI는 데이터 주도).
 */
export function summarizeAlarmLogBySource(
  entries: readonly AlarmLogEntry[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.source] = (counts[entry.source] ?? 0) + 1;
  }
  return counts;
}

export function logSuppressedGate(
  reason: 'gate-age' | 'gate-accuracy' | 'gate-jump',
  location: AlarmLogLocation,
): void {
  appendAlarmLog({
    ts: Date.now(),
    source: 'bg',
    outcome: 'suppressed',
    reason,
    location,
  });
}

/**
 * 정적 misfire 가드(movementGate.ts)가 차단한 발사 1건 적재 (#727).
 * source는 호출자에 따라 fg/silent-push-skipped/bg-scheduled 등 — 정적 회귀의 출처를 좁히기 위해.
 * stationName/kind/phaseId는 차단된 알람 컨텍스트. reason은 'movement-*' 4종 중 하나.
 */
export function logSuppressedMovement(input: {
  source: AlarmLogSource;
  stationName: string;
  kind?: AlarmLogKind;
  phaseId?: AlarmPhaseId;
  reason: Extract<AlarmLogReason, `movement-${string}`>;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: input.reason,
    stationName: input.stationName,
    kind: input.kind,
    phaseId: input.phaseId,
  });
}

/**
 * 취침모드 첫 환승 알람 누수 차단 1건 적재 (#750).
 * source는 호출 path를 식별: scheduler 사전예약은 'bg-scheduled', FG polling은 'fg',
 * BG silent push 등은 'bg' / 'silent-push-skipped' 중 호출자가 결정.
 * 알람 유형은 항상 transfer이므로 kind 고정 — 호출자가 다시 채울 필요 없음.
 */
export function logSuppressedSleepFirstTransfer(input: {
  source: AlarmLogSource;
  stationName: string;
  phaseId?: AlarmPhaseId;
}): void {
  appendAlarmLog({
    ts: Date.now(),
    source: input.source,
    outcome: 'suppressed',
    reason: 'sleep-first-transfer',
    stationName: input.stationName,
    kind: 'transfer',
    phaseId: input.phaseId,
  });
}

// ── CRUD ──

// 모듈 스코프 mutable state (#735 batched write).
// 단일 프로세스 단일 인스턴스 가정 — React Native 앱 1 process.
//
// 동시성: JS는 single-thread지만 *await 사이*에 다른 microtask가 끼어든다 → RMW race 가능.
// flushInFlight Promise mutex로 두 개 이상의 flush가 동시에 getItem/setItem 사이클을 돌지 않도록
// 직렬화한다. 단순 single-thread 가정만으론 lost-update가 발생한다 (review #1 발견).
let pendingEntries: AlarmLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let oldestPendingTs: number | null = null;
let flushInFlight: Promise<void> | null = null;

/**
 * 알람 로그 1건 적재 (#735 — 동기 in-memory push).
 *
 * 기존 RMW 동작에서 변경: 즉시 storage write 안 함. 메모리 pending에 push하고 debounce/max-delay
 * 정책에 따라 일괄 flush. UI(DebugModal)는 getAlarmLog()가 pending 병합해 반환하므로 즉시 가시.
 *
 * 호출자는 await 불필요 (void). 손실 cap을 더 줄여야 하는 critical 경로(silent push BG task 종료
 * 직전 등)에서는 await flushAlarmLog() 명시 호출.
 */
export function appendAlarmLog(entry: AlarmLogEntry): void {
  pendingEntries.push(entry);
  oldestPendingTs ??= Date.now();
  scheduleFlush();
}

function fireAndForgetFlush(): void {
  // flushAlarmLog는 doFlushOnce 내부 try/catch로 모든 storage 에러를 swallow하므로 reject 안 함.
  // 따라서 별도 .catch가 dead branch라 생략 — Promise floating은 의도된 fire-and-forget.
  flushAlarmLog();
}

function scheduleFlush(): void {
  // 가장 오래된 pending이 MAX_DELAY 도달했으면 즉시 flush.
  // 기존 flushTimer는 doFlushOnce에서 클리어 — 본 위치에서 중복 클리어 불필요.
  if (oldestPendingTs != null && Date.now() - oldestPendingTs >= FLUSH_MAX_DELAY_MS) {
    fireAndForgetFlush();
    return;
  }
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    fireAndForgetFlush();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * 메모리 pending을 storage에 1회 RMW로 일괄 적재 (#735).
 *
 * 호출 시점:
 *   1) scheduleFlush의 debounce timer 만료
 *   2) MAX_DELAY 즉시 flush
 *   3) AppState 'background'/'inactive' 진입 (모듈 스코프 listener)
 *   4) silentPushTask 종료 직전 명시 호출 (BG task 시간 만료 직전 손실 방지)
 *   5) 테스트
 *
 * 동시성 안전 (review P1 fix):
 *   - 첫 호출자만 doFlushOnce()를 실제 실행하고, 그 promise를 flushInFlight에 저장.
 *   - 중첩 호출자(다른 트리거가 동시에 flush 요청)는 같은 flushInFlight를 await한 뒤,
 *     자신이 추가한 pending이 남아있으면 재귀 호출로 다음 RMW 사이클을 보장.
 *   - JS single-thread는 동기 구간만 보호 — await 사이엔 다른 microtask가 끼어들어
 *     두 doFlushOnce가 같은 storage 상태를 보고 서로의 write를 덮는 lost-update가 발생.
 *     본 mutex 패턴이 RMW를 직렬화.
 */
export async function flushAlarmLog(): Promise<void> {
  if (flushInFlight) {
    await flushInFlight;
    // 직전 flush 중에 우리(다른 caller)가 추가한 entry가 남아있으면 다음 cycle로 적재 보장.
    if (pendingEntries.length > 0) await flushAlarmLog();
    return;
  }
  if (pendingEntries.length === 0) return;
  flushInFlight = doFlushOnce();
  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

async function doFlushOnce(): Promise<void> {
  const toFlush = pendingEntries;
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOG_KEY);
    const existing: AlarmLogEntry[] = raw ? safeParse(raw) : [];
    const next = [...existing, ...toFlush];
    // FIFO: 가장 오래된 것부터 drop
    const trimmed = next.length > ALARM_LOG_BUFFER_SIZE
      ? next.slice(next.length - ALARM_LOG_BUFFER_SIZE)
      : next;
    await AsyncStorage.setItem(ALARM_LOG_KEY, JSON.stringify(trimmed));
  } catch (e) {
    logger.error('알람 로그 적재 실패:', e);
  }
}

export async function getAlarmLog(): Promise<AlarmLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOG_KEY);
    const persisted: AlarmLogEntry[] = raw ? safeParse(raw) : [];
    // #735 — pending 병합. UI는 최신 상태를 즉시 봐야 한다(flush 전 적재 entry 포함).
    // pending은 시간순으로 push되므로 persisted 뒤에 concat.
    if (pendingEntries.length === 0) return persisted;
    const merged = [...persisted, ...pendingEntries];
    return merged.length > ALARM_LOG_BUFFER_SIZE
      ? merged.slice(merged.length - ALARM_LOG_BUFFER_SIZE)
      : merged;
  } catch (e) {
    logger.error('알람 로그 읽기 실패:', e);
    // storage 실패해도 pending은 노출 — 진단 가시성 유지.
    return [...pendingEntries];
  }
}

export async function clearAlarmLog(): Promise<void> {
  // #735 — pending도 초기화. flush race로 storage 비운 후 pending이 다시 적재되지 않도록.
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await AsyncStorage.removeItem(ALARM_LOG_KEY);
  } catch (e) {
    logger.error('알람 로그 삭제 실패:', e);
  }
}

/**
 * 테스트 전용 — 모듈 스코프 상태 초기화 (#735).
 * pendingEntries / flushTimer / oldestPendingTs를 reset해 테스트 간 격리.
 * production 호출 금지.
 */
export function resetAlarmLogForTest(): void {
  pendingEntries = [];
  oldestPendingTs = null;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushInFlight = null;
}

function safeParse(raw: string): AlarmLogEntry[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.error('알람 로그 형태 손상(비배열) — 빈 로그로 초기화');
      return [];
    }
    return parsed;
  } catch {
    logger.error('알람 로그 JSON 손상 — 빈 로그로 초기화');
    return [];
  }
}

// #735 — AppState 'background'/'inactive' 진입 시 자동 flush. OS suspend 전 pending 손실 방지.
// 모듈 로드 시 1회 등록 (singleton). subscription.remove는 production에서 불필요 (앱 lifetime 동일).
function handleAppStateChange(state: AppStateStatus): void {
  if (state === 'background' || state === 'inactive') {
    fireAndForgetFlush();
  }
}
AppState.addEventListener('change', handleAppStateChange);

/**
 * 테스트 전용 — AppState 전환 시뮬레이트 (#735).
 * 모듈 스코프 listener 등록은 jest.mock 호이스팅과 race 발생하기 쉬워, 캡처된 listener를
 * 외부에서 호출하기 어렵다. 테스트는 본 helper로 handleAppStateChange를 직접 트리거.
 * production 호출 금지.
 */
export function _simulateAppStateForTest(state: AppStateStatus): void {
  handleAppStateChange(state);
}
