import AsyncStorage from '@react-native-async-storage/async-storage';
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

// 'fg' / 'bg'는 v1 (FG GPS 평가 / BG location task gate). 'fg-evaluated' / 'bg-scheduled'는
// v2 (#372)로 의미 명확화. 두 값 모두 union에 유지해 과거 저장 데이터를 손실 없이 읽는다.
// 'silent-push-received'는 #478 측정 인프라 — silent push 도달 시점 기록.
// 'silent-push-fired'/'silent-push-skipped'는 #478 PR 1-2 — 위치 게이트 통과/실패 발사.
export type AlarmLogSource =
  | 'fg'
  | 'bg'
  | 'fg-evaluated'
  | 'bg-scheduled'
  | 'silent-push-received'
  | 'silent-push-fired'
  | 'silent-push-skipped';
export type AlarmLogOutcome = 'fired' | 'suppressed' | 'received';
// 'dedup-alarm'(evaluateAlarmPhase의 firedAlarms 적중 케이스)은 후속 이슈에서 추가.
// 그때까지 union에 선언하지 않아 "구현됐다"는 거짓 시그널을 피한다.
// 'gate-unknown-station' / 'gate-no-location' / 'gate-stale-location' / 'gate-out-of-range'는
// #478 PR 1-2 silent push 위치 게이트 skip 사유.
// 'payload-missing-kind'는 구 백엔드 payload에 kind 필드가 없어 발사 본문 결정 불가 → skip.
export type AlarmLogReason =
  | 'dedup-station'
  | 'gate-age'
  | 'gate-accuracy'
  | 'gate-unknown-station'
  | 'gate-no-location'
  | 'gate-stale-location'
  | 'gate-out-of-range'
  | 'payload-missing-kind';
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
  void appendAlarmLog({
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
  void appendAlarmLog({
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
  void appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: station.name,
    kind: 'station-passed',
  });
}

export function logSuppressedDedupStation(source: AlarmLogSource, station: Station): void {
  void appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'suppressed',
    reason: 'dedup-station',
    stationName: station.name,
    kind: 'station-passed',
  });
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
  void appendAlarmLog({
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
  void appendAlarmLog({
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
  void appendAlarmLog({
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

export function logSuppressedGate(
  reason: 'gate-age' | 'gate-accuracy',
  location: AlarmLogLocation,
): void {
  void appendAlarmLog({
    ts: Date.now(),
    source: 'bg',
    outcome: 'suppressed',
    reason,
    location,
  });
}

// ── CRUD ──

export async function appendAlarmLog(entry: AlarmLogEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(ALARM_LOG_KEY);
    const existing: AlarmLogEntry[] = raw ? safeParse(raw) : [];
    const next = [...existing, entry];
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
    return raw ? safeParse(raw) : [];
  } catch (e) {
    logger.error('알람 로그 읽기 실패:', e);
    return [];
  }
}

export async function clearAlarmLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(ALARM_LOG_KEY);
  } catch (e) {
    logger.error('알람 로그 삭제 실패:', e);
  }
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
