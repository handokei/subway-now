import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LAST_NOTIFIED_STATION_KEY,
  FIRED_ALARMS_KEY,
  LAST_FIRED_ALARM_STATION_NAME_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

// Foreground/Background 양쪽에서 호출되는 알림 상태 저장소.
// React 라이프사이클 외부(TaskManager 콜백)에서도 동작해야 하므로
// 순수 함수 + AsyncStorage 단일 출처 구조를 유지한다.
//
// 새 알림 상태(예: 마지막 알람 phase)를 추가할 때는 storageKeys.ts에 키만 추가하고
// 아래 generic helper를 통해 thin wrapper만 정의한다. try/catch 보일러플레이트 복붙 금지.
const logger = createLogger('NotificationState');

async function safeGetItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch (e) {
    logger.error(`${key} 읽기 실패:`, e);
    return null;
  }
}

async function safeSetItem(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch (e) {
    logger.error(`${key} 저장 실패:`, e);
  }
}

async function safeRemoveItem(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (e) {
    logger.error(`${key} 삭제 실패:`, e);
  }
}

// #1011: lastNotifiedStationId를 destination tuple로 scoping.
// 저장 포맷: `{ destinationId, stationId }`. read 시점 destinationId가 저장된 것과
// 다르면 stale로 간주하고 null을 반환한다. destinationId가 null이면 항상 null.
interface LastNotifiedRecord {
  destinationId: string;
  stationId: string;
}

function isLastNotifiedRecord(value: unknown): value is LastNotifiedRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LastNotifiedRecord).destinationId === 'string' &&
    typeof (value as LastNotifiedRecord).stationId === 'string'
  );
}

export async function getLastNotifiedStationId(
  destinationId: string | null,
): Promise<string | null> {
  if (!destinationId) return null;
  const raw = await safeGetItem(LAST_NOTIFIED_STATION_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isLastNotifiedRecord(parsed)) return null;
    if (parsed.destinationId !== destinationId) return null;
    return parsed.stationId;
  } catch (e) {
    logger.error(`${LAST_NOTIFIED_STATION_KEY} 파싱 실패:`, e);
    return null;
  }
}

export function setLastNotifiedStationId(
  destinationId: string,
  stationId: string,
): Promise<void> {
  const record: LastNotifiedRecord = { destinationId, stationId };
  return safeSetItem(LAST_NOTIFIED_STATION_KEY, JSON.stringify(record));
}

export function clearLastNotifiedStationId(): Promise<void> {
  return safeRemoveItem(LAST_NOTIFIED_STATION_KEY);
}

// firedAlarms: 알람 phase 중복 발화 dedup 단일 출처.
// Foreground 훅(useStationAlarm)과 Background task(backgroundLocationTask)가
// 같은 키를 공유해, BG fired 알람이 FG 복귀 후 재발화되지 않도록 한다.
//
// #462: destinationId로 entry를 격리해 cross-trip leak을 차단한다. 저장 포맷은
// `{ destinationId, alarms }` 객체. read 시점 destinationId가 저장된 것과 다르면
// stale로 간주하고 빈 set을 반환한다. destinationId가 null이면 항상 빈 set.
interface FiredAlarmsRecord {
  destinationId: string;
  alarms: string[];
}

function isFiredAlarmsRecord(value: unknown): value is FiredAlarmsRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as FiredAlarmsRecord).destinationId === 'string' &&
    Array.isArray((value as FiredAlarmsRecord).alarms)
  );
}

export async function getFiredAlarms(destinationId: string | null): Promise<Set<string>> {
  if (!destinationId) return new Set();
  const raw = await safeGetItem(FIRED_ALARMS_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isFiredAlarmsRecord(parsed)) return new Set();
    if (parsed.destinationId !== destinationId) return new Set();
    return new Set(parsed.alarms);
  } catch (e) {
    logger.error(`${FIRED_ALARMS_KEY} 파싱 실패:`, e);
    return new Set();
  }
}

export function setFiredAlarms(destinationId: string, keys: Set<string>): Promise<void> {
  const record: FiredAlarmsRecord = { destinationId, alarms: [...keys] };
  return safeSetItem(FIRED_ALARMS_KEY, JSON.stringify(record));
}

export function clearFiredAlarms(): Promise<void> {
  return safeRemoveItem(FIRED_ALARMS_KEY);
}

// 사전 예약 alarm: 발화 시 갱신되는 마지막 발화 역 이름.
// id 기반 LAST_NOTIFIED_STATION_KEY와 분리한다(storageKeys.ts 주석 참고).
export function getLastFiredAlarmStationName(): Promise<string | null> {
  return safeGetItem(LAST_FIRED_ALARM_STATION_NAME_KEY);
}

export function setLastFiredAlarmStationName(name: string): Promise<void> {
  return safeSetItem(LAST_FIRED_ALARM_STATION_NAME_KEY, name);
}

/** #799: trip 종료/전환 시 호출. 사전 예약 alarm state는 trip-bound. */
export function clearLastFiredAlarmStationName(): Promise<void> {
  return safeRemoveItem(LAST_FIRED_ALARM_STATION_NAME_KEY);
}
