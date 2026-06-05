/**
 * Trip-ended sentinel storage (#899 Seam C).
 *
 * BG silent push trip-ended 핸들러가 작성하는 키. zustand store에 BG에서 접근할 수
 * 없어 storage cleanup만 수행하는데, FG 복귀 시 useStateRehydration이 이 키를 보고
 * destination/lock store를 reset해 stale UI를 차단한다.
 *
 * SSOT key: storageKeys.TRIP_ENDED_BY_BACKEND_AT_KEY.
 *
 * 모든 함수는 AsyncStorage 실패를 graceful하게 흡수 — sentinel은 보조 채널이므로
 * 실패해도 storage cleanup 자체의 효력은 유지된다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_ENDED_BY_BACKEND_AT_KEY } from '../../../shared/constants/storageKeys';

/** sentinel 작성. trip-ended silent push 수신 시점에 호출. */
export async function setTripEndedSentinel(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_ENDED_BY_BACKEND_AT_KEY, String(at));
  } catch {
    // sentinel 실패는 graceful — storage cleanup은 이미 수행됨.
  }
}

/** sentinel epoch ms 또는 null. 값이 NaN/누락이면 null. */
export async function getTripEndedSentinel(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_ENDED_BY_BACKEND_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** sentinel 처리 완료 시 호출. 다음 trip-ended를 다시 감지할 수 있도록 키 삭제. */
export async function clearTripEndedSentinel(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_ENDED_BY_BACKEND_AT_KEY);
  } catch {
    // graceful — 다음 reset 호출에서 재시도된다.
  }
}
