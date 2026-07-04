/**
 * Last silent push received epoch ms storage (#2045, Signal 4 / Issue #2043 β 후속).
 *
 * `silentPushTask.handleSilentPush`가 유효 payload 진입 시점(receivedAt stamp)에 write,
 * `useLaunchTripReconciliation`이 launch 시점에 read해 backend-timeout self-end 판정에 사용.
 *
 * 관찰 22 (BG kill 6h+ 방치 후 launch) 커버. FG 전용 3-signal(#2044)과 상호 보완:
 *   - #2044: HomeScreen mount 3-signal (fusion + arc + ETA) — FG 유지 시 backstop
 *   - #2045: launch reconciliation 확장 — BG kill 시나리오 커버
 *
 * SSOT key: storageKeys.LAST_SILENT_PUSH_RECEIVED_AT_KEY.
 *
 * 모든 함수는 AsyncStorage 실패를 graceful 흡수 — signal 4 판정은 보조 backstop이라
 * 실패해도 기존 recall/sentinel chain 및 force-end backstop(9h)이 자연 흡수한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAST_SILENT_PUSH_RECEIVED_AT_KEY } from '../../../shared/constants/storageKeys';

/** last-received stamp 저장. silent push handler 진입점에서 호출 (kind 무관). */
export async function setLastSilentPushReceivedAt(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_SILENT_PUSH_RECEIVED_AT_KEY, String(at));
  } catch {
    // graceful — 다음 push 수신에서 재갱신 시도. 판정 실패해도 9h force-end backstop이 흡수.
  }
}

/** last-received epoch ms 또는 null. 키 부재/NaN 모두 null. */
export async function getLastSilentPushReceivedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_SILENT_PUSH_RECEIVED_AT_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** last-received stamp 제거. tripBoundCleanups에서 새 trip 시작 또는 종료 시 호출. */
export async function clearLastSilentPushReceivedAt(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_SILENT_PUSH_RECEIVED_AT_KEY);
  } catch {
    // graceful — 다음 cleanup에서 재시도.
  }
}
