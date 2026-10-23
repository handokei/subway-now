/**
 * #3191 PR-1 — "마지막 fix L을 나이와 무관하게 계속 유지해도 되는가" 순수 술어.
 *
 * 지상에서 정지하면 iOS가 fix를 15초 넘게 새로 주지 않는다. L이 지상 품질 정지 fix이고 L 이후
 * 이동 증거가 없으면 사용자는 L 위치에 그대로 있다 — 나이로 버리지 않는다.
 * 이동 증거는 셋뿐: 새 fix / 기압 하강(subsurface) / 기압 수직 변화(ΔP 이벤트).
 *
 * 이 PR(PR-1)은 판정 결과를 Raw에 기록만 한다. 게이트 배선은 PR-2.
 */
import {
  STATIONARY_HOLD_BARO_LOOKBACK_MS,
  STATIONARY_HOLD_MAX_ACCURACY_M,
  STATIONARY_HOLD_MAX_SPEED_MPS,
} from '../../../shared/constants/stationaryFixHold';

export interface StationaryHoldFix {
  accuracyMeters: number | null;
  speedMps: number | null;
  /** L의 수신 시각(ms). */
  atMs: number;
}

export interface StationaryHoldInput {
  /** 마지막 fix L. 없으면 유지 불가. */
  fix: StationaryHoldFix | null;
  /** L보다 새로운 fix가 이미 있는가. */
  hasNewerFix: boolean;
  /** 기압 하강 중(현재 subsurface). */
  subsurface: boolean | undefined;
  /** 가장 최근 기압 ΔP 이벤트 시각(30s 창 |ΔP|>=0.3 또는 공백 건넌 ΔP). 없으면 null. */
  baroEventAtMs: number | null;
  /** 기압계가 볼 수 있는 상태(signal 존재 + unavailableReason 없음). */
  barometerAvailable: boolean;
  /** BoardingLock 활성 — lock 범위는 이 규칙 밖(현행 유지). */
  lockActive: boolean;
}

export function shouldHoldStationaryFix(input: StationaryHoldInput): boolean {
  const { fix, hasNewerFix, subsurface, baroEventAtMs, barometerAvailable, lockActive } = input;
  if (fix === null || lockActive || !barometerAvailable) return false;
  if (hasNewerFix || subsurface === true) return false;

  const { accuracyMeters, speedMps, atMs } = fix;
  if (accuracyMeters === null || accuracyMeters > STATIONARY_HOLD_MAX_ACCURACY_M) return false;
  if (speedMps !== null && speedMps >= STATIONARY_HOLD_MAX_SPEED_MPS) return false;

  // 가장 최근 ΔP 이벤트가 L − lookback 이후면 [L − lookback, now] 안에 이벤트가 있다 = 이동 증거.
  // 나이(now − L)는 입력이 아니다 — 이동 증거가 없으면 몇 분이 지나도 L을 유지한다.
  const hasBaroEvidence = baroEventAtMs !== null && baroEventAtMs >= atMs - STATIONARY_HOLD_BARO_LOOKBACK_MS;
  return !hasBaroEvidence;
}
