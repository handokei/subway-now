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
import {
  TRIP_LIFECYCLE_SILENCE_MS,
  TRIP_LIFECYCLE_FORCE_END_MS,
} from '../../../shared/constants/realtime';
import { refreshCorrId } from '../../../shared/utils/backendCallBuffer';

/**
 * #1573 (T10) — trip lifecycle 단계 판정 helper.
 *
 * 입력: 마지막 trip 시작 시각(epoch ms) — null이면 'none'.
 * 본 PR에서 silence/force-end만 wire. opt-in extend(12h)는 후속 토글 sub-task에서.
 *
 *  - 'none'      — trip 없음. 호출자 skip.
 *  - 'normal'    — 정상 운행 (6h 미만). backstop 동작 없음.
 *  - 'silence'   — 6h~9h. alarm/notify 차단만 (UI는 유지). KTX/장거리 trip 보호.
 *  - 'force-end' — 9h+. runTripBoundCleanups + sentinel. lockless 9h+ 잔존 #1346 차단.
 */
export type TripLifecyclePhase = 'none' | 'normal' | 'silence' | 'force-end';

export function tripLifecyclePhase(
  startedAt: number | null,
  now: number = Date.now(),
): TripLifecyclePhase {
  if (startedAt === null) return 'none';
  const elapsed = now - startedAt;
  if (elapsed >= TRIP_LIFECYCLE_FORCE_END_MS) return 'force-end';
  if (elapsed >= TRIP_LIFECYCLE_SILENCE_MS) return 'silence';
  return 'normal';
}

/** Trip 시작 시각 기록. setDestination switch 분기에서 호출. */
export async function setTripStartedAt(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_STARTED_AT_KEY, String(at));
    // #1518 — backend call 로그 corrId 캐시 즉시 갱신. write와 동일 cycle에 hydrate해
    // 다음 fetch부터 새 trip의 corrId가 entry에 박힌다.
    void refreshCorrId();
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
    // #1518 — corrId 캐시도 즉시 비워 trip 종료 후 호출(LA clear, telemetry flush 등)에는
    // corrId=null로 entry가 박힌다. trip 식별성 유지 + 누설 차단.
    void refreshCorrId();
  } catch {
    // graceful — 다음 cleanup에서 재시도.
  }
}
