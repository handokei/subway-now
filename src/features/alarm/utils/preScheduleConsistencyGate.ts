/**
 * #1389 — preschedule 시점 정합성 게이트 evaluator (boardingLockScheduler / tripBoundScheduler 공통).
 *
 * 두 호출자 모두 OS local notification 사전 예약 직전, WiFi가 boardingStation과 다른 station을
 * 확증하면 schedule 거부해야 하는 동일 요구사항을 가진다. 본 helper가 두 호출자가 공유하는
 * single source of truth — 호출자는 boardingStation 정보를 정규화해서 넘기기만 한다.
 *
 * 평가 본문은 `pushConsistency.evaluatePushConsistency`에 위임.
 * 본 helper는 그 결과를 boolean으로 변환 + 차단 시 `logLocalFireConsistencyBlocked` 적재 + logger.info.
 *
 * 호출자가 boardingStation을 모르면(lockless / 컨텍스트 부재) `null`을 전달 — helper가 자연 allow.
 * helper의 fallback 정책상 WiFi 미상(SSID 매핑 없음/권한 X)이면 자연 allow → graceful.
 */

// eslint-disable-next-line import/no-restricted-paths -- WiFi SSOT는 nearest-station feature.
import { getCurrentWifiSsid } from '../../nearest-station/utils/wifiSsidNative';
// eslint-disable-next-line import/no-restricted-paths -- WiFi → station 매핑 SSOT.
import { lookupStationBySsid } from '../../nearest-station/utils/wifiSsidLookup';
import { evaluatePushConsistency } from './pushConsistency';
import { extractDeviceSignal } from './pushConsistencyContext';
import { logLocalFireConsistencyBlocked } from './alarmLog';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('PreScheduleConsistencyGate');

export interface PreScheduleConsistencyInput {
  /**
   * preschedule 시점에 사용자가 있어야 할 station. null이면 lockless / 컨텍스트 부재로
   * 게이트 자연 allow.
   */
  boardingStation: { stationName: string; line: string } | null;
  /** 진입 시점 motion=stationary 여부. helper의 motion 신호 입력으로 사용. */
  motionStationary: boolean;
  /** preschedule 호출 채널 — log 식별. boardingLockScheduler='bl', tripBoundScheduler='tba'. */
  channel: 'bl' | 'tba';
  /** 목적지 이름 — logger 식별용. 미상이면 'unknown'. */
  destinationName: string | undefined;
}

/**
 * preschedule 시점 정합성 게이트 평가.
 *
 * 반환:
 *  - true: schedule 진행 (allow / boardingStation 없음 / WiFi 미상 / fresh signal 모두 정상)
 *  - false: schedule 거부 (WiFi != target && motion=stationary 등 명백한 모순)
 *
 * 차단 시 `logLocalFireConsistencyBlocked` + logger.info — 호출자는 boolean 결과만 사용한다.
 */
export async function evaluatePreScheduleConsistency(
  input: PreScheduleConsistencyInput,
): Promise<boolean> {
  if (!input.boardingStation) return true;

  let wifiStation = null;
  try {
    const ssid = await getCurrentWifiSsid();
    wifiStation = lookupStationBySsid(ssid);
  } catch {
    // graceful — WiFi 미상.
  }

  const deviceSignal = extractDeviceSignal({
    currentStation: input.boardingStation.stationName,
    motionStationary: input.motionStationary,
    wifiStation,
    lastUpdateMs: Date.now(),
  });
  const result = evaluatePushConsistency(
    deviceSignal,
    input.boardingStation,
    { deviceHopsBehindTarget: null },
    Date.now(),
  );
  if (result.allowed) return true;

  logLocalFireConsistencyBlocked({
    source: 'bg-scheduled',
    stationName: input.boardingStation.stationName,
    reason: result.reason,
  });
  logger.info(
    `preschedule consistency skip channel=${input.channel} reason=${result.reason} destination=${input.destinationName ?? 'unknown'}`,
  );
  return false;
}
