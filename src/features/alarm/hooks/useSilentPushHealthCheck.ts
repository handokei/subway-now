/**
 * #1677 — silent push 수신 건강 상태 체크 (device self-contained fallback prereq).
 *
 * alarmLog의 `silent-push-received` 최신 entry 시각을 기준으로 backend silent push
 * 파이프라인이 정상인지 판단한다.
 *
 * - `healthy = true`  → 최근 SILENT_PUSH_HEALTH_THRESHOLD_MS(60s) 내 수신 기록 있음.
 * - `healthy = false` → 60s 이상 미수신 (backend outage / APNs drop / cooldown 등).
 * - `lastReceivedAt = null` → alarmLog에 기록 없음(최초 실행 / log 초기화 후).
 *
 * **신규 폴링 없음**: AppState 'active' 전환 + 30s interval로 alarmLog 재조회.
 * trip 활성 여부는 호출자(useFusedNearestStation)가 tripActive 조건과 결합해 판단.
 *
 * AppState 'background'/'inactive' 시에는 false positive 방지를 위해 healthy 판정을
 * 유지(healthy 갱신 X) — FG fallback은 FG 상태에서만 의미 있으므로 호출자가
 * `AppState === 'active'` 조건과 AND로 적용한다.
 *
 * caller: HomeScreen → useFusedNearestStation(`silentPushHealthy` prop).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getAlarmLog } from '../utils/alarmLog';

/** alarmLog에 silent-push-received가 없거나 이 시간 이상 경과 시 unhealthy. */
export const SILENT_PUSH_HEALTH_THRESHOLD_MS = 60_000;

/** AppState active 시 alarmLog 재조회 interval (30s). */
export const SILENT_PUSH_HEALTH_POLL_INTERVAL_MS = 30_000;

export interface SilentPushHealthState {
  /** false = silent push 60s+ 미수신 → backendSsotAccepts 강제 false 권장. */
  healthy: boolean;
  /** 가장 최근 silent-push-received entry의 ts. alarmLog 없으면 null. */
  lastReceivedAt: number | null;
}

/** alarmLog에서 silent-push-received 최신 ts를 추출. */
async function readLastSilentPushReceivedAt(now: number): Promise<{
  healthy: boolean;
  lastReceivedAt: number | null;
}> {
  const entries = await getAlarmLog();
  let latest: number | null = null;
  for (const e of entries) {
    if (e.source !== 'silent-push-received') continue;
    if (latest === null || e.ts > latest) latest = e.ts;
  }
  // latest=null → 기록 없음(최초 실행 / log 초기화). 수신 이력 자체가 없는 것은
  // "unhealthy"가 아니라 "알 수 없음" — healthy=true로 간주해 cascade 강등 방지.
  // healthy=false는 수신 이력이 있는데 60s+ 경과한 경우만 설정 (명확한 outage 신호).
  const healthy = latest === null || now - latest <= SILENT_PUSH_HEALTH_THRESHOLD_MS;
  return { healthy, lastReceivedAt: latest };
}

export function useSilentPushHealthCheck(): SilentPushHealthState {
  const [state, setState] = useState<SilentPushHealthState>({
    healthy: true, // 초기값 true — 실측 전 cascade 강등 방지.
    lastReceivedAt: null,
  });

  // interval id를 ref로 보관해 cleanup에서 정확히 clear.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const now = Date.now();
    const next = await readLastSilentPushReceivedAt(now);
    setState((prev) => {
      // 불필요한 re-render 방지 — healthy + lastReceivedAt 모두 같으면 skip.
      if (prev.healthy === next.healthy && prev.lastReceivedAt === next.lastReceivedAt) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();

    intervalRef.current = setInterval(() => {
      void refresh();
    }, SILENT_PUSH_HEALTH_POLL_INTERVAL_MS);

    const sub = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') void refresh();
    });

    return () => {
      clearInterval(intervalRef.current!);
      intervalRef.current = null;
      sub.remove();
    };
  }, [refresh]);

  return state;
}
