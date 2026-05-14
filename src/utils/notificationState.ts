import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LAST_NOTIFIED_STATION_KEY,
  FIRED_ALARMS_KEY,
  LAST_FIRED_ALARM_STATION_NAME_KEY,
} from '../constants/storageKeys';
import { createLogger } from './logger';

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

export function getLastNotifiedStationId(): Promise<string | null> {
  return safeGetItem(LAST_NOTIFIED_STATION_KEY);
}

export function setLastNotifiedStationId(id: string): Promise<void> {
  return safeSetItem(LAST_NOTIFIED_STATION_KEY, id);
}

export function clearLastNotifiedStationId(): Promise<void> {
  return safeRemoveItem(LAST_NOTIFIED_STATION_KEY);
}

// firedAlarms: 알람 phase 중복 발화 dedup 단일 출처.
// Foreground 훅(useStationAlarm)과 Background task(backgroundLocationTask)가
// 같은 키를 공유해, BG fired 알람이 FG 복귀 후 재발화되지 않도록 한다.
export async function getFiredAlarms(): Promise<Set<string>> {
  const raw = await safeGetItem(FIRED_ALARMS_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (e) {
    logger.error(`${FIRED_ALARMS_KEY} 파싱 실패:`, e);
    return new Set();
  }
}

export function setFiredAlarms(keys: Set<string>): Promise<void> {
  return safeSetItem(FIRED_ALARMS_KEY, JSON.stringify([...keys]));
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
