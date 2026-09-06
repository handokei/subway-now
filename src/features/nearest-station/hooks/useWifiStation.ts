/**
 * #913 (Epic #912 — F2) — Wifi SSID → 현재 역 매칭 React hook.
 *
 * 동작:
 *   1. mount 시 즉시 1회 + 인터벌(POLL_INTERVAL_MS)로 `getCurrentWifiSsid()` 호출
 *   2. SSID → `lookupStationBySsid` → Station 또는 null
 *   3. 결과를 state로 노출 → HomeScreen이 `useCurrentStationConfirmModal`의 `wifiStation` prop로 전달
 *
 * 폴링 주기: 15초.
 *   - 너무 짧으면 native 호출 부하 + battery
 *   - 너무 길면 지하 진입 직후 매칭 지연 (사용자 체감 누락)
 *   - 알람 평가 주기(30초)의 절반 — 한 주기 안에 1회 이상 갱신 보장
 *
 * Graceful:
 *   - native 부재 / 권한 없음 → 결과 항상 null (suppress 안 함, GPS fallback)
 *   - SSID 매칭 실패 → null (다른 신호로 fallback)
 *   - unmount 시 polling cleanup
 *
 * #2006 (ADR-022 Phase 4-4) — `isSimpleArchEnabled()` 활성 시 폴링 자체 skip. arrival API 가
 * 지하도 SSOT 로 커버하므로 WiFi 대체 신호는 dormant. native SSID 조회는 배터리·권한 비용이
 * 있어 `lookupStationBySsid` 게이트만으로는 부족 — hook 자체가 tick 을 skip 한다.
 * flag OFF (default) 시 기존 15s 폴링 그대로.
 */

import { useEffect, useState } from 'react';
import { getCurrentWifiSsid } from '../utils/wifiSsidNative';
import { lookupStationBySsid } from '../utils/wifiSsidLookup';
import { isSimpleArchEnabled } from '../../../shared/config/archFlag';
import type { Station } from '../../../shared/types/station';

/** 폴링 주기 — 알람 평가(30s)의 절반. native 부하와 갱신 지연의 절충점. */
const POLL_INTERVAL_MS = 15_000;

export function useWifiStation(): Station | null {
  const [station, setStation] = useState<Station | null>(null);

  useEffect(() => {
    // #2006 (ADR-022 Phase 4-4) — flag ON 시 폴링 자체 skip. 배터리·권한 비용 0.
    // flag toggle 은 재빌드/remount 이 트리거하므로 effect deps 는 유지 (mount time 판정).
    if (isSimpleArchEnabled()) {
      return;
    }
    let cancelled = false;

    const tick = async () => {
      const ssid = await getCurrentWifiSsid();
      if (cancelled) return;
      const matched = lookupStationBySsid(ssid);
      // 같은 결과면 setState skip — 참조 안정성 위해 name 비교.
      setStation((prev) => {
        if (prev?.name === matched?.name) return prev;
        return matched;
      });
    };

    void tick();
    const intervalId = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return station;
}
