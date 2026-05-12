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

export type AlarmLogSource = 'fg' | 'bg';
export type AlarmLogOutcome = 'fired' | 'suppressed';
// 'dedup-alarm'(evaluateAlarmPhase의 firedAlarms 적중 케이스)은 후속 이슈에서 추가.
// 그때까지 union에 선언하지 않아 "구현됐다"는 거짓 시그널을 피한다.
export type AlarmLogReason = 'dedup-station' | 'gate-age' | 'gate-accuracy';
export type AlarmLogKind = 'destination' | 'transfer' | 'station-passed';

export interface AlarmLogLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  ageMs: number;
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
}

const logger = createLogger('AlarmLog');

// ── 적재 helper ──
// 호출자는 `void log*(...)` 한 줄로 적재한다. ts/source/outcome 등 필드는
// helper가 채운다 — 호출부에서 누락하거나 잘못 채우는 사고를 차단.
// 모든 helper는 fire-and-forget: 실패해도 후속 정합성에 영향 없음(이미 swallow).

export function logFiredAlarm(source: AlarmLogSource, event: AlarmEvent): void {
  void appendAlarmLog({
    ts: Date.now(),
    source,
    outcome: 'fired',
    stationName: event.stationName,
    kind: event.type,
    phaseId: event.phaseId,
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
