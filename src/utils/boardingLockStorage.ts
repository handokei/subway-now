import AsyncStorage from '@react-native-async-storage/async-storage';
import { BOARDING_LOCK_KEY } from '../shared/constants/storageKeys';
import { createLogger } from './logger';
import type { BoardingLock } from '../types/boardingLock';

const logger = createLogger('BoardingLockStorage');

/**
 * AsyncStorage BoardingLock CRUD (#584 PR A).
 * 단일 Lock만 유지 — trip은 한 번에 하나, multi-transfer는 새 Lock으로 교체.
 *
 * Lock 구조 변경(필드 추가) 시 isBoardingLock 가드를 함께 갱신해야 한다. 파싱 실패한
 * 레거시 페이로드는 빈 결과(null)로 처리 — 잘못된 상태로 dedup/예약 시스템이 오염되는 것을 차단한다.
 */
function isBoardingLock(value: unknown): value is BoardingLock {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.destinationId === 'string' &&
    typeof v.trainCode === 'string' &&
    typeof v.boardingStationId === 'string' &&
    typeof v.boardingLine === 'string' &&
    typeof v.boardedAt === 'number' &&
    typeof v.expectedDurationMs === 'number'
  );
}

export async function getBoardingLock(): Promise<BoardingLock | null> {
  try {
    const raw = await AsyncStorage.getItem(BOARDING_LOCK_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isBoardingLock(parsed)) {
      logger.error(`${BOARDING_LOCK_KEY} 형식 손상 — 무시`);
      return null;
    }
    return parsed;
  } catch (e) {
    // 일시적 I/O 실패는 warn — 다음 호출에서 자연 복구.
    logger.warn(`${BOARDING_LOCK_KEY} 읽기 실패:`, e);
    return null;
  }
}

export async function setBoardingLock(lock: BoardingLock): Promise<void> {
  try {
    await AsyncStorage.setItem(BOARDING_LOCK_KEY, JSON.stringify(lock));
  } catch (e) {
    logger.warn(`${BOARDING_LOCK_KEY} 저장 실패:`, e);
  }
}

export async function clearBoardingLock(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BOARDING_LOCK_KEY);
  } catch (e) {
    logger.warn(`${BOARDING_LOCK_KEY} 삭제 실패:`, e);
  }
}
