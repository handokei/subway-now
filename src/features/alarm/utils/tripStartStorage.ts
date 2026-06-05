/**
 * Trip 시작 시각 storage (#919, Epic #912 A4).
 *
 * trip-end recall KPI 계산을 위해 trip이 시작한 순간을 epoch ms로 기록한다.
 * `tripStart`는 recall 계산에서 alarmLog 윈도우의 exclusive lower bound로 사용된다
 * (이전 trip 의 잔여 entries가 새 trip 의 recall에 섞이지 않도록).
 *
 * Writers: `useDestinationStore.setDestination(non-null)` (FG, isSwitch 분기).
 * Reader: trip-end recall trigger (silent push trip-ended / FG setDestination(null)).
 * Cleanup: `tripBoundCleanups` — 새 trip 시작 또는 trip 종료 시 함께 제거.
 *
 * 모든 함수는 AsyncStorage 실패를 graceful 흡수 — 기록 실패는 recall 측정 가능 여부만
 * 영향, 알람 발사 흐름에는 무영향.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_STARTED_AT_KEY } from '../../../shared/constants/storageKeys';

/** Trip 시작 시각 기록. setDestination switch 분기에서 호출. */
export async function setTripStartedAt(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_STARTED_AT_KEY, String(at));
  } catch {
    // graceful — recall 측정만 영향, trip 흐름 무관.
  }
}

/** Trip 시작 epoch ms 또는 null. 키 부재/NaN 모두 null. */
export async function getTripStartedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_STARTED_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Trip 시작 시각 제거. tripBoundCleanups에서 호출. */
export async function clearTripStartedAt(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_STARTED_AT_KEY);
  } catch {
    // graceful — 다음 cleanup에서 재시도.
  }
}
