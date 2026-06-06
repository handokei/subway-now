/**
 * #875 — 기압계 ring buffer ambient state.
 *
 * useBarometer hook이 sensor reading마다 push → 평가 시점에 readings 전체를 evaluate.
 * BG task가 latest verdict를 snapshot으로 첨부할 수 있도록 ambient 모듈 패턴 사용
 * (accelMotionState와 동형 — CLAUDE.md §3 재사용성).
 *
 * 정책:
 *   - 메모리 ring buffer만 (60s ≤ 60 entry @ 1Hz, 매우 가벼움).
 *   - hook unmount → reset. 영속화 필요 시 후속 sub-issue.
 *
 * #920 — 절대값 narrow 함수 추가.
 *   - dP/dt(상대 변화)와 별개로, 깊이별 평균 절대 압력을 비교해 후보 역을 ±2역 narrow.
 *   - F2(wifi) 매칭이 실패한 지하에서 fallback.
 */

import {
  BAROMETER_ABS_TOLERANCE_HPA,
  BAROMETER_ETA_TOLERANCE_SEC,
  DEPTH_TO_PRESSURE_HPA_PER_M,
} from '../constants/barometer';
import stationAbsolutePressureData from '../../data/stationAbsolutePressure.json';
import stationTravelTimesJson from '../../data/stationTravelTimes.json';
import type { LineNumber, Station } from '../types/station';
import {
  evaluateBarometerStop,
  evaluateSubsurfaceEnter,
  pruneStaleReadings,
  type BarometerReading,
  type SubsurfaceVerdict,
} from './barometerSubsurface';

/**
 * 역별 절대 압력 entry. 지하 깊이(m) 기반 — 표준 대기 모델로 압력 환산.
 *
 * 실측 압력값을 직접 보관하지 않는 이유: 지역 기준 압력은 일별 ±5 hPa 변동.
 * surfacePressure를 외부에서 주입받고 깊이만 비교하는 방식이 단순하고 안정적이다
 * (CLAUDE.md §2 단순성). 후속 PR에서 실측 보정이 필요하면 그 때 필드 추가.
 *
 * CLAUDE.md §3 데이터 주도: 새 역 추가 시 코드 수정 없이 JSON 항목만 추가.
 */
export interface StationAbsolutePressureEntry {
  readonly stationId: string;
  readonly stationName: string;
  readonly line: LineNumber;
  readonly depth_m: number;
}

const ABS_PRESSURE_ENTRIES: readonly StationAbsolutePressureEntry[] =
  stationAbsolutePressureData as readonly StationAbsolutePressureEntry[];

const TRAVEL_TIMES = stationTravelTimesJson as Record<string, number>;

/**
 * stationTravelTimes.json은 인접 hop만 등록. 인접이 아니면 undefined → 본 narrow에서 신호 미사용.
 * `${line}|${fromId}|${toId}` 키는 `stationRoute.ts`와 동일하게 양방향 모두 등록되어 있다.
 */
function lookupAdjacentHopSeconds(
  line: LineNumber,
  fromId: string,
  toId: string,
): number | null {
  const key = `${line}|${fromId}|${toId}`;
  return TRAVEL_TIMES[key] ?? null;
}

/**
 * stationAbsolutePressure.json에서 stationId로 depth_m 조회. 없으면 null.
 * 단발 lookup이라 Map 캐시는 oversimplification — 호출 빈도(1초당 1회 미만)에서는 선형이 충분히 빠르다.
 */
function lookupDepthMeters(stationId: string): number | null {
  const entry = ABS_PRESSURE_ENTRIES.find((e) => e.stationId === stationId);
  return entry ? entry.depth_m : null;
}

let readings: BarometerReading[] = [];

/**
 * 새 reading을 추가하고, stale entry를 제거한다.
 * 호출자(useBarometer)가 센서 콜백마다 호출.
 */
export function appendBarometerReading(reading: BarometerReading): void {
  readings = pruneStaleReadings([...readings, reading], reading.t);
}

/**
 * 현재 보관 중인 readings의 readonly 스냅샷. 디버그/테스트용.
 */
export function getBarometerReadings(): readonly BarometerReading[] {
  return readings;
}

/**
 * 현재 시점 기준 dP/dt 평가 결과를 반환. readings 부족이면 null.
 * BG task가 position upload 직전에 호출.
 */
export function evaluateLatestSubsurface(now: number): SubsurfaceVerdict | null {
  return evaluateSubsurfaceEnter(readings, now);
}

/**
 * #921 — 현재 시점 기준 정차 패턴 평가 결과를 반환. readings 부족이면 null.
 * useFusedStationDetection이 fusion 신호 'barometer-stop' 입력으로 사용.
 */
export function evaluateLatestStop(now: number): SubsurfaceVerdict | null {
  return evaluateBarometerStop(readings, now);
}

/**
 * Ring buffer 초기화. hook unmount / 권한 거절 / 미지원 디바이스에서 호출.
 */
export function resetBarometerState(): void {
  readings = [];
}

/**
 * #920 — 절대 압력 측정값으로 후보 역을 narrow.
 *
 * @param measuredPressureHpa 단말 기압계 절대값 (hPa).
 * @param surfacePressureHpa 같은 지역 지상 기준 압력 (hPa). 일별 기상 변동을 흡수하기 위해
 *   호출자가 GPS + 날씨/지상 baseline에서 주입한다 (본 PR 외부 — 임시 1013 default 가능).
 * @param candidates 사전 후보 역(예: GPS top-N). 빈 배열이면 빈 결과.
 * @param toleranceHpa 일치 허용 폭. 기본 `BAROMETER_ABS_TOLERANCE_HPA`.
 * @returns 추정 압력이 측정값과 tolerance 안인 후보 역의 부분집합.
 *
 * 정책:
 *   - 후보 안에서만 필터 — F2 실패 시 GPS top-N narrow 용도.
 *   - 환승역(같은 이름 다중 노선)도 깊이가 다르면 다른 entry → 자연스럽게 분리됨.
 *   - 데이터에 없는 stationId는 자동 제외 (점진적 데이터 보강).
 */
export function narrowStationsByPressure(
  measuredPressureHpa: number,
  surfacePressureHpa: number,
  candidates: readonly Station[] = [],
  toleranceHpa: number = BAROMETER_ABS_TOLERANCE_HPA,
): Station[] {
  if (candidates.length === 0) return [];

  const matchedIds = new Set<string>();
  for (const entry of ABS_PRESSURE_ENTRIES) {
    const expected =
      surfacePressureHpa + entry.depth_m * DEPTH_TO_PRESSURE_HPA_PER_M;
    if (Math.abs(measuredPressureHpa - expected) <= toleranceHpa) {
      matchedIds.add(entry.stationId);
    }
  }

  return candidates.filter((s) => matchedIds.has(s.id));
}

/**
 * #920 후속 — 깊이+ETA 결합 narrow.
 *
 * `narrowStationsByPressure`가 2~3개의 모호한 후보를 돌려줬을 때, 직전 확정역에서 측정된 경과
 * 시간과 데이터상의 인접 hop 운행시간(`stationTravelTimes.json`)을 비교해 한 후보로 좁힌다.
 *
 * 정책:
 *   - candidates ≤ 1 → no-op (이미 단일 또는 비어 있음).
 *   - candidate 중 `previousStation`과 같은 노선이며 인접 hop인 것만 평가 대상.
 *     비인접/다른 노선 후보는 ETA 신호로 가를 수 없으므로 평가에서 제외하되 fallback 후보에는 남긴다.
 *   - depthError(hPa) + etaError(sec) 양쪽 데이터가 모두 있는 후보만 점수화 (graceful skip).
 *   - 점수 = depthError/toleranceHpa + etaError/etaToleranceSec — 단위 정규화한 합.
 *   - 점수 정렬 후 winner가 runner-up과 충분히 갈리면(winner score < runner_up - 1.0) winner만 반환.
 *     gap 미달이면 baseline candidates 그대로 (오판 방지 — F3는 보조 신호).
 *   - 평가 가능한 후보가 0개면 baseline 그대로.
 *
 * @returns 단일 후보 1개(승자) 또는 입력 candidates 그대로(no-op).
 */
export interface DepthEtaNarrowInput {
  readonly measuredPressureHpa: number;
  readonly surfacePressureHpa: number;
  readonly candidates: readonly Station[];
  readonly previousStation: Station;
  /** 직전 확정역 통과 후 경과 시간(초). 음수면 평가 skip. */
  readonly secondsSincePrevious: number;
  readonly toleranceHpa?: number;
  readonly etaToleranceSec?: number;
  /**
   * #920 wave 2 — 사용자 정지 신호(CMMotionActivity). true면 도착역에 멈춰 있을 가능성 ↑.
   * `barometerStable`과 함께 true일 때 결정 gap을 완화해 winner 선택을 허용한다.
   * 미제공/false이면 기존 동작.
   */
  readonly motionStationary?: boolean;
  /**
   * #920 wave 2 — 기압 변화 없음 신호(`evaluateBarometerStop` detected).
   * true면 압력이 안정 → 같은 깊이에 머무름(정차 후보). motion과 결합 시 결정 gap 완화.
   * 한쪽만 true면 TOO_WEAK만 완화(약한 가중치), 둘 다 true면 GAP+TOO_WEAK 모두 완화.
   */
  readonly barometerStable?: boolean;
}

const DEPTH_ETA_DECISIVE_GAP = 1.0;
/**
 * #920 wave 2 — motion+barometer 두 신호 모두 true일 때 적용하는 완화 gap.
 * 1.0 → 0.5. winner와 runner-up이 가깝게 붙어 baseline fallback되던 케이스에서 winner 선택 허용.
 * 0.5는 점수 단위계(depthError/tolerance + etaError/tolerance) 절반 — 한 차원이 명확히 갈리면 충분.
 */
const DEPTH_ETA_DECISIVE_GAP_REINFORCED = 0.5;
const DEPTH_ETA_TOO_WEAK = 2.0;
/**
 * #920 wave 2 — motion 또는 barometer 한 신호라도 true일 때 적용하는 완화 TOO_WEAK.
 * 2.0 → 3.0. 측정 잡음으로 점수가 약간 높아져도 winner 선택 허용. 둘 다 false/미제공이면 기본값.
 */
const DEPTH_ETA_TOO_WEAK_REINFORCED = 3.0;

export function narrowStationsByDepthAndEta(
  input: DepthEtaNarrowInput,
): Station[] {
  const {
    measuredPressureHpa,
    surfacePressureHpa,
    candidates,
    previousStation,
    secondsSincePrevious,
    toleranceHpa = BAROMETER_ABS_TOLERANCE_HPA,
    etaToleranceSec = BAROMETER_ETA_TOLERANCE_SEC,
    motionStationary = false,
    barometerStable = false,
  } = input;

  if (candidates.length <= 1) return [...candidates];
  if (secondsSincePrevious < 0) return [...candidates];

  type Scored = { station: Station; score: number };
  const scored: Scored[] = [];

  for (const cand of candidates) {
    if (cand.line !== previousStation.line) continue;
    const hopSec = lookupAdjacentHopSeconds(
      cand.line,
      previousStation.id,
      cand.id,
    );
    if (hopSec === null) continue;
    const depth = lookupDepthMeters(cand.id);
    if (depth === null) continue;

    const expectedPressure =
      surfacePressureHpa + depth * DEPTH_TO_PRESSURE_HPA_PER_M;
    const depthError = Math.abs(measuredPressureHpa - expectedPressure);
    const etaError = Math.abs(secondsSincePrevious - hopSec);
    const score = depthError / toleranceHpa + etaError / etaToleranceSec;
    scored.push({ station: cand, score });
  }

  if (scored.length === 0) return [...candidates];
  scored.sort((a, b) => a.score - b.score);

  // #920 wave 2 — 신호 강도에 따라 임계 완화:
  //   - 둘 다 true(정지+압력 안정) = 도착역 근거 강함 → GAP + TOO_WEAK 모두 완화
  //   - 한쪽만 true = 부분 신호 → TOO_WEAK만 완화 (약한 가중치)
  //   - 둘 다 false/미제공 = 기존 동작 (회귀 X)
  const bothReinforced = motionStationary && barometerStable;
  const anyReinforced = motionStationary || barometerStable;
  const tooWeak = anyReinforced ? DEPTH_ETA_TOO_WEAK_REINFORCED : DEPTH_ETA_TOO_WEAK;
  const decisiveGap = bothReinforced
    ? DEPTH_ETA_DECISIVE_GAP_REINFORCED
    : DEPTH_ETA_DECISIVE_GAP;

  // 평가 가능한 후보가 단 1개라도 점수가 형편없으면 baseline로 fallback.
  if (scored[0].score > tooWeak) return [...candidates];

  // 평가 가능한 후보가 1개뿐 → 그 후보를 반환 (다른 후보는 신호 결정 불가).
  if (scored.length === 1) return [scored[0].station];

  // 2개 이상 — winner가 runner-up과 충분히 갈리면 winner만, 아니면 baseline.
  const gap = scored[1].score - scored[0].score;
  if (gap >= decisiveGap) return [scored[0].station];
  return [...candidates];
}
