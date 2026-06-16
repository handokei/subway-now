/**
 * #1389 — silent push 수신 시점 정합성 게이트 evaluator.
 *
 * silentPushTask가 fire 직전 호출. 분리 의도:
 *   - 호출자(silentPushTask)는 result를 보고 ack/log/cancel 라우팅만 처리한다.
 *   - 본 helper가 WiFi 신호 수집 + helper 호출 + 결과 반환에 집중.
 *
 * BG 컨텍스트:
 *   - WiFi: 비동기 `getCurrentWifiSsid` + lookup. 실패 시 null (helper의 자연 fallback 허용).
 *   - currentStationName: BG에선 fused nearest 부재 → null (helper의 hops=null fallback 경로 진입).
 *   - lastUpdateMs: Date.now() — fresh 신호로 간주.
 */

// eslint-disable-next-line import/no-restricted-paths -- WiFi SSOT는 nearest-station feature.
import { getCurrentWifiSsid } from '../../nearest-station/utils/wifiSsidNative';
// eslint-disable-next-line import/no-restricted-paths -- WiFi → station 매핑 SSOT.
import { lookupStationBySsid } from '../../nearest-station/utils/wifiSsidLookup';
import {
  evaluatePushConsistency,
  type ConsistencyResult,
} from './pushConsistency';
import { extractDeviceSignal } from './pushConsistencyContext';

export interface SilentPushConsistencyInput {
  targetStationName: string;
  targetLine: string;
  motionStationary: boolean;
}

/**
 * silent push 수신 시점 정합성 평가.
 *
 * `evaluatePushConsistency` 결과를 그대로 전달 — caller가 ack/log/cancel 처리.
 */
export async function evaluateSilentPushConsistency(
  input: SilentPushConsistencyInput,
): Promise<ConsistencyResult> {
  let wifiStation = null;
  try {
    const ssid = await getCurrentWifiSsid();
    wifiStation = lookupStationBySsid(ssid);
  } catch {
    // graceful — WiFi 미상이면 helper가 다른 신호로 평가.
  }

  const deviceSignal = extractDeviceSignal({
    currentStation: null, // BG에서는 fused nearest station 부재 — hops=null fallback 경로.
    motionStationary: input.motionStationary,
    wifiStation,
    lastUpdateMs: Date.now(),
  });
  const target = { stationName: input.targetStationName, line: input.targetLine };
  return evaluatePushConsistency(
    deviceSignal,
    target,
    { deviceHopsBehindTarget: null },
    Date.now(),
  );
}
