/**
 * Arrival API SSOT Feature Flag — remote 조회 hook (Phase 0, ADR-022 / #1982).
 *
 * mount 시 1회 `/admin/arch-flag` 를 조회하고 5분 주기로 refresh. 배터리를 위해 지속 polling
 * 없이 5분 간격만 유지 — DebugModal 표시 / Phase 1 이후 caller 가 이 값을 env 와 OR 조건으로
 * 판정한다.
 *
 * DebugModal 이나 다른 컴포넌트에서 다음과 같이 사용한다:
 *   ```ts
 *   const remote = useArchFlagRemote();
 *   const active = isSimpleArchEnabled(remote.value);
 *   ```
 *
 * ADMIN_TOKEN / ALARM_BACKEND_URL 미설정 환경은 `kind: 'unconfigured'` 그대로 유지 —
 * `isSimpleArchEnabled` 는 undefined 로 remote 를 취급해 env 판정만 사용한다.
 */

import { useEffect, useState } from 'react';
import { fetchArchFlag, type FetchArchFlagResult } from './archFlagRemote';

/** 5분 refresh 주기. */
export const ARCH_FLAG_REMOTE_REFRESH_MS = 5 * 60 * 1000;

/** hook 반환 shape. `value` 는 `'on' | 'off' | undefined` — undefined 시 env 만 판정. */
export interface ArchFlagRemoteState {
  /** 최근 fetch 성공 시 flag 값. 실패/미조회 시 undefined. */
  value: 'on' | 'off' | undefined;
  /** fetch 결과 kind. UI 진단(에러 메시지 등) 용도. */
  kind: FetchArchFlagResult['kind'] | 'loading';
  /** 마지막 fetch 시각 (ms epoch). 미조회 시 null. */
  lastFetchedAt: number | null;
}

const INITIAL_STATE: ArchFlagRemoteState = {
  value: undefined,
  kind: 'loading',
  lastFetchedAt: null,
};

/**
 * `useArchFlagRemote` — mount 시 1회 fetch + 5분 주기 refresh.
 *
 * cancel guard: unmount 이후 setState 방지. 첫 fetch 가 5분 이상 걸리면 다음 tick 과 겹치지만
 * setInterval 사이클마다 fresh promise 를 생성하므로 마지막 결과가 최종 반영된다.
 */
export function useArchFlagRemote(): ArchFlagRemoteState {
  const [state, setState] = useState<ArchFlagRemoteState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const result = await fetchArchFlag();
      if (cancelled) return;
      const value =
        result.kind === 'ok' ? result.value : undefined;
      setState({
        value,
        kind: result.kind,
        lastFetchedAt: Date.now(),
      });
    };

    void load();
    const timerId = setInterval(() => {
      void load();
    }, ARCH_FLAG_REMOTE_REFRESH_MS);

    return (): void => {
      cancelled = true;
      clearInterval(timerId);
    };
  }, []);

  return state;
}
