/**
 * #3191 PR-1 — "마지막 fix L을 나이와 무관하게 계속 유지해도 되는가" 순수 술어.
 *
 * 지상에서 정지하면 iOS가 fix를 15초 넘게 새로 주지 않는다. L이 지상 품질 정지 fix이고 L 이후
 * 이동 증거가 없으면 사용자는 L 위치에 그대로 있다 — 나이로 버리지 않는다.
 * 이동 증거는 셋뿐: 새 fix / 기압 하강(subsurface) / 기압 수직 변화(ΔP 이벤트).
 *
 * PR-1은 판정 결과를 Raw에 기록만 했고, PR-2가 결정 tier 거리 게이트 입력으로 배선한다.
 * PR-2에서 "지상" 판별자 G2(최근접역 거리 >= 150m)를 술어에 더했다 — acc<=30 만으로는 지하 승강장
 * fix(acc 24~27)를 지상으로 오인했다(W 덤프, plan pr2-final §0.2).
 */
import {
  STATIONARY_HOLD_BARO_FAILURE_REASONS,
  STATIONARY_HOLD_BARO_FRESH_MS,
  STATIONARY_HOLD_BARO_LOOKBACK_MS,
  STATIONARY_HOLD_BARO_WARMUP_MS,
  STATIONARY_HOLD_MAX_ACCURACY_M,
  STATIONARY_HOLD_MAX_SPEED_MPS,
  STATIONARY_HOLD_MIN_NEAREST_STATION_M,
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
  /**
   * G2 — fix와 GPS 최근접역 사이 거리(m). 모르면 null(fail-closed: 지상임을 확인할 수 없다).
   * 150m 미만이면 역사·승강장 안으로 보고 hold하지 않는다.
   */
  nearestStationDistanceM: number | null;
}

/** hold가 꺼진 첫 조건의 이름 (Raw `holdBlock` 기록용). 조건 평가 순서 = 이 union의 선언 순서. */
export type StationaryHoldBlock =
  | 'no-fix'
  | 'lock'
  | 'baro-unavailable'
  | 'newer-fix'
  | 'subsurface'
  | 'accuracy'
  | 'speed'
  | 'distance-unknown'
  | 'near-station'
  | 'baro-event';

export function stationaryHoldBlock(input: StationaryHoldInput): StationaryHoldBlock | null {
  const { fix, hasNewerFix, subsurface, baroEventAtMs, barometerAvailable, lockActive, nearestStationDistanceM } =
    input;
  if (fix === null) return 'no-fix';
  if (lockActive) return 'lock';
  if (!barometerAvailable) return 'baro-unavailable';
  if (hasNewerFix) return 'newer-fix';
  if (subsurface === true) return 'subsurface';

  const { accuracyMeters, speedMps, atMs } = fix;
  if (accuracyMeters === null || accuracyMeters > STATIONARY_HOLD_MAX_ACCURACY_M) return 'accuracy';
  if (speedMps !== null && speedMps >= STATIONARY_HOLD_MAX_SPEED_MPS) return 'speed';
  if (nearestStationDistanceM === null) return 'distance-unknown';
  if (nearestStationDistanceM < STATIONARY_HOLD_MIN_NEAREST_STATION_M) return 'near-station';

  // 가장 최근 ΔP 이벤트가 L − lookback 이후면 [L − lookback, now] 안에 이벤트가 있다 = 이동 증거.
  // 나이(now − L)는 입력이 아니다 — 이동 증거가 없으면 몇 분이 지나도 L을 유지한다.
  const hasBaroEvidence = baroEventAtMs !== null && baroEventAtMs >= atMs - STATIONARY_HOLD_BARO_LOOKBACK_MS;
  return hasBaroEvidence ? 'baro-event' : null;
}

export function shouldHoldStationaryFix(input: StationaryHoldInput): boolean {
  return stationaryHoldBlock(input) === null;
}

export interface BarometerObservableInput {
  /** useBarometer signal.unavailableReason (undefined = 정상). */
  unavailableReason: string | undefined;
  /** 세션 첫 reading 시각(barometerState.firstHpaAtMs). reading이 한 번도 없으면 null. */
  firstReadingAtMs: number | null;
  /** 마지막 reading 시각. 없으면 null. */
  lastReadingAtMs: number | null;
  nowMs: number;
}

/**
 * D2(b) — 기압계가 "수직 이동(하강)을 볼 수 있는" 상태인가.
 * 센서·권한 실패 없음 AND 첫 reading 후 30초 경과 AND 마지막 reading이 30초 이내.
 * stop verdict 30초 baseline(`unavailableReason==='readings'`)에는 의존하지 않는다 — 그 값은 reset·DebugModal
 * 닫힘 뒤 30초 동안 hold를 꺼뜨렸다.
 */
export function isBarometerObservable({
  unavailableReason,
  firstReadingAtMs,
  lastReadingAtMs,
  nowMs,
}: BarometerObservableInput): boolean {
  if (unavailableReason !== undefined && STATIONARY_HOLD_BARO_FAILURE_REASONS.includes(unavailableReason)) {
    return false;
  }
  if (firstReadingAtMs === null || lastReadingAtMs === null) return false;
  return (
    nowMs - firstReadingAtMs >= STATIONARY_HOLD_BARO_WARMUP_MS &&
    nowMs - lastReadingAtMs <= STATIONARY_HOLD_BARO_FRESH_MS
  );
}
