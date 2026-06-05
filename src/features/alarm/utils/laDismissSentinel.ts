/**
 * #926 (Seam E3) — LA dismiss sentinel storage + 정책.
 *
 * 사용자가 Live Activity를 dismiss하면 `markLaDismissed()`를 호출해 sentinel을 기록한다.
 * silent push 핸들러(`refreshLiveActivityFromBackgroundContext`)는 호출 직전에
 * `isLaDismissed(now)`로 확인하고, 활성이면 LA refresh를 skip한다.
 *
 * 정책:
 *  - sentinel TTL = `LA_DISMISS_SENTINEL_TTL_MS` (30분). TTL 경과 후 자동 만료 → LA 재상승 OK.
 *  - 명시적 reset(destination 재설정 / 앱 진입)은 `clearLaDismissSentinel()`로 즉시 해제(후속 PR).
 *
 * SSOT key: `storageKeys.LA_DISMISSED_AT_KEY`.
 *
 * 모든 함수는 AsyncStorage 실패를 graceful하게 흡수 — sentinel은 보조 채널이라
 * 실패해도 silent push의 핵심 흐름(알람 발사/ACK)은 영향받지 않아야 한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LA_DISMISSED_AT_KEY } from '../../../shared/constants/storageKeys';
import { LA_DISMISS_SENTINEL_TTL_MS } from '../../../shared/constants/laDismiss';

/** sentinel 작성. LA dismiss 이벤트 수신 시점에 호출. 기본값은 Date.now(). */
export async function markLaDismissed(at: number = Date.now()): Promise<void> {
  try {
    await AsyncStorage.setItem(LA_DISMISSED_AT_KEY, String(at));
  } catch {
    // sentinel 실패는 graceful — 다음 dismiss 이벤트에서 재시도된다.
  }
}

/**
 * sentinel 활성 여부. now 기준으로 TTL 안의 sentinel이 있으면 true.
 *  - 키 부재 / NaN / TTL 만료 → false (LA refresh 허용)
 *  - 키 존재 + TTL 안 → true (LA refresh 차단)
 */
export async function isLaDismissed(now: number = Date.now()): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LA_DISMISSED_AT_KEY);
    if (raw === null) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    const elapsed = now - at;
    // clock-skew 방어: at이 미래(elapsed < 0)면 sentinel 무효 — NTP 보정으로 시각이 뒤로 점프해도
    // LA refresh가 무기한 차단되는 회귀 방지. 양의 elapsed + TTL 안일 때만 활성.
    if (elapsed < 0) return false;
    return elapsed < LA_DISMISS_SENTINEL_TTL_MS;
  } catch {
    return false;
  }
}

/** sentinel 명시적 reset. destination 재설정 / 앱 진입 트리거에서 호출(후속 PR). */
export async function clearLaDismissSentinel(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LA_DISMISSED_AT_KEY);
  } catch {
    // graceful — 다음 clear 호출 또는 TTL 만료로 자연 정리된다.
  }
}
