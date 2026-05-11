import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_NOTIFIED_STATION_KEY } from '../constants/storageKeys';
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
