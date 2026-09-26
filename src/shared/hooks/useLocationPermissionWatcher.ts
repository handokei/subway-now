/**
 * #1454 — 위치 권한 회수 / Always→WhileInUse 강등 감지 훅.
 *
 * 사용자가 시스템 설정에서 위치 권한을 회수하거나(Always/WhileInUse → 거부)
 * Always 권한을 WhileInUse로 낮추면 silent trip(알림 누락)이 발생한다. 게이트 외
 * 영역이므로 사용자 명시 알림(UI 배너)로 원인을 인지하게 한다.
 *
 * 동작:
 *   - 마운트 시 FG + BG 권한을 동시에 조회한다.
 *   - 이후 AppState 'active' 진입 시마다 다시 조회한다 — 사용자가 설정 앱에 다녀온 직후
 *     변화를 감지하는 가장 신뢰 가능한 시점.
 *   - 직전 status 대비 (revoked | downgraded | none) change 종류를 산출한다.
 *
 * 본 훅은 표시 결정을 하지 않는다 — 호출자가 change에 따라 UI(예: PermissionChangeBanner)
 * 노출/dismiss를 결정한다. 책임 분리로 테스트 용이성 + 표시 정책 다양화(banner / push 등)를
 * 모두 지원한다.
 *
 * 의도적으로 LocationPort를 거치지 않는다 — Port가 노출하는 권한 API는 request 한 종(Phase 3
 * 단계). FG/BG 권한 조회는 watcher 한정 책임이라 expo-location 직접 호출이 더 명확하다.
 *
 * 관련: B4 (WhileInUse 권한 정책), feedback_whileinuse_must_work
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Location from 'expo-location';
import { createLogger } from '../utils/logger';

const logger = createLogger('LocationPermissionWatcher');

/** 권한 상태 분류. iOS Always = granted+background, WhileInUse = granted+!background. */
export type LocationPermissionStatus =
  | 'unknown'
  | 'denied'
  | 'granted-whileinuse'
  | 'granted-always';

/** 직전 상태 대비 변화 종류. */
export type LocationPermissionChange = 'none' | 'revoked' | 'downgraded';

export interface LocationPermissionWatcherResult {
  /** 현재 권한 상태. 초기값 'unknown' — 첫 조회 완료 후 갱신된다. */
  status: LocationPermissionStatus;
  /** 직전 status 대비 의미 있는 변화 종류. 표시 정책의 입력 신호. */
  change: LocationPermissionChange;
  /** change를 'none'으로 리셋(사용자가 배너를 dismiss한 시점 등). */
  acknowledge: () => void;
}

async function probePermissionStatus(): Promise<LocationPermissionStatus> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') return 'denied';
    const bg = await Location.getBackgroundPermissionsAsync();
    return bg.status === 'granted' ? 'granted-always' : 'granted-whileinuse';
  } catch (e) {
    logger.warn('권한 조회 실패 — unknown 유지', e);
    return 'unknown';
  }
}

/**
 * 두 status 사이 변화 종류를 분류한다.
 * - granted(any) → denied: revoked
 * - granted-always → granted-whileinuse: downgraded
 * - 그 외(unknown 관여 / 같음 / granted-whileinuse → granted-always 등 상향): none
 */
export function classifyPermissionChange(
  prev: LocationPermissionStatus,
  next: LocationPermissionStatus,
): LocationPermissionChange {
  if (prev === 'unknown' || next === 'unknown') return 'none';
  if (prev === next) return 'none';
  if (next === 'denied' && (prev === 'granted-always' || prev === 'granted-whileinuse')) {
    return 'revoked';
  }
  if (prev === 'granted-always' && next === 'granted-whileinuse') return 'downgraded';
  return 'none';
}

export function useLocationPermissionWatcher(): LocationPermissionWatcherResult {
  const [status, setStatus] = useState<LocationPermissionStatus>('unknown');
  const [change, setChange] = useState<LocationPermissionChange>('none');
  // prev status는 비교 전용 — re-render를 유발하지 않도록 ref로 보관.
  const prevStatusRef = useRef<LocationPermissionStatus>('unknown');

  const refresh = useCallback(async (cancelledRef: { current: boolean }) => {
    const next = await probePermissionStatus();
    if (cancelledRef.current) return;
    const prev = prevStatusRef.current;
    const detected = classifyPermissionChange(prev, next);
    if (detected !== 'none') {
      logger.info('권한 변화 감지', { prev, next, change: detected });
      setChange(detected);
    }
    prevStatusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    const cancelledRef = { current: false };
    // refresh 내부에서 probePermissionStatus가 모든 에러를 흡수하므로 reject 가능성은 없지만,
    // 방어적으로 .catch로 floating promise를 명시적으로 종결한다(SonarCloud S3735 회피).
    const runRefresh = () => {
      refresh(cancelledRef).catch(
        /* istanbul ignore next — probePermissionStatus가 모든 에러를 흡수해 도달 불가 */
        (e: unknown) => logger.warn('refresh 실패 — 무시', e),
      );
    };
    runRefresh();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') runRefresh();
    });
    return () => {
      cancelledRef.current = true;
      sub.remove();
    };
  }, [refresh]);

  const acknowledge = useCallback(() => {
    setChange('none');
  }, []);

  return { status, change, acknowledge };
}
