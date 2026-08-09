/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2) — 시퀀스 replay 드라이버.
 *
 * `parseRawSignalCycles`(rawSignalCycleParser.ts)가 만든 `FusionCycleInput[]`를 실제
 * `inferEnvironment`(nearest-station/utils/inferEnvironment.ts, **런타임 로직 미변경 — import만**)
 * 에 사이클별로 흘려 environment 판정을 재현하고, `stations.json` ground-truth(canonical
 * `station.environment` + 좌표)와 대조해 ADR-030 불변식을 단언한다.
 *
 * ## 왜 `pickFusionTier` 전체가 아니라 `inferEnvironment`만 재생하는가 (정직 제약)
 * `pickFusionTier`는 11-tier cascade가 lock 상태·route·wifi·drift 등 dump raw signal 라인에
 * 없는 다수 pre-computed gate를 입력받는다. 이 값을 dump에서 파생 불가능한데 임의로 채우면
 * "가짜 근거"(CLAUDE.md 결정 룰)가 된다. `inferEnvironment`는 dump가 직접 제공하는
 * `subsurface` 단일 필드로 완전히 재현 가능해 정직하게 replay 가능한 범위다. 이슈 #2241 증상
 * 1·3·5("env 고착 + 지하 stale GPS")의 root(ADR-030 표)가 정확히 이 함수(`inferEnvironment.ts:87`)
 * 이므로 범위 축소가 red fixture 재현력을 해치지 않는다. SSOT(surfaceSSOT/undergroundSSOT)와
 * tripActive/barometerStop/qualityDegraded는 dump에 없어 `false`/`undefined`로 고정 — 이는
 * `inferEnvironment` 우선순위 4번 분기("SSOT 미판정 시 raw subsurface 신뢰")만 타는 것과
 * 동치이며, 실제 증상 재현 경로와 일치한다(ADR-030 §Root A).
 *
 * ## fake timer 강제 (ADR-030 §CI 비용/게이팅)
 * 본 드라이버는 순수 함수 호출이라 timer 자체에 의존하지 않지만, 호출 전 `jest.setSystemTime`
 * 으로 `Date.now()`를 사이클 시각에 맞춰 전진시킨다 — 향후 timer 의존 로직(sticky window 등)이
 * replay 대상에 편입되어도 즉시 정확히 재현되도록 하기 위한 backbone 계약이다. real timer 사용
 * (`setTimeout` 실경과)은 금지 — replay가 분 단위로 실시간 실행되면 CI 비용이 폭발한다.
 */

import { inferEnvironment, type Environment } from '../features/nearest-station/utils/inferEnvironment';
import type { FusionCycleInput } from './rawSignalCycleParser';
import { haversine } from '../shared/utils/haversine';
import stationsData from '../data/stations.json';
import type { Station } from '../shared/types/station';

const STATIONS = stationsData as readonly Station[];
const STATION_BY_ID = new Map<string, Station>(STATIONS.map((s) => [s.id, s]));

/** cycle 1개 replay 결과. */
export interface ReplayCycleResult {
  input: FusionCycleInput;
  /** `inferEnvironment` 판정 결과. */
  inferredEnvironment: Environment;
  /** `stations.json`의 canonical environment (stationId 미해결이면 null). */
  groundTruthEnvironment: 'surface' | 'underground' | 'mixed' | 'unknown' | null;
  /** 직전 사이클과 다른 station으로 이동했다면 haversine 거리(km). 동일/미해결이면 null. */
  jumpFromPrevKm: number | null;
  /** 직전 GPS fix로부터 몇 ms 경과했는지(fix 재사용 depth). fix 정보 없으면 null. */
  gpsFixAgeMs: number | null;
}

/**
 * `FusionCycleInput[]`를 시간순으로 흘려 `inferEnvironment`를 재생.
 *
 * jest fake timer 필수 — 호출 전 `jest.useFakeTimers()`가 활성화돼 있어야 한다(그렇지 않으면
 * `jest.setSystemTime`이 no-op 경고 없이 무시될 수 있어 replay가 "재현 안 됐는데 통과"하는
 * 조용한 회귀를 유발한다). 호출자가 실수로 real timer 상태에서 부르는 사고를 막기 위해
 * `jest.isMockFunction`으로 검증하지 않고 **문서/컨벤션으로 강제** — jest 내부 fake-timer
 * 활성 여부를 공개 API로 조회할 안정된 방법이 없어(private state), 과잉 방어보다 backbone
 * 문서화가 CLAUDE.md §2 단순성 원칙에 부합한다.
 */
export function replayFusionCycles(cycles: readonly FusionCycleInput[]): ReplayCycleResult[] {
  const results: ReplayCycleResult[] = [];
  let prevStation: Station | null = null;
  let prevGpsFixAtMs: number | null = null;

  for (const cycle of cycles) {
    jest.setSystemTime(cycle.ts);

    const inferredEnvironment = inferEnvironment({
      subsurface: cycle.subsurface ?? undefined,
      // dump에 SSOT/trip/barometer-stop/quality-degraded 신호가 없다 — 정직하게 미판정으로 고정
      // (파일 헤더 §왜 inferEnvironment만 재생하는가 참고).
      surfaceSSOT: false,
      undergroundSSOT: false,
    }).label;

    const station = cycle.stationId !== null ? STATION_BY_ID.get(cycle.stationId) ?? null : null;
    const groundTruthEnvironment = station?.environment ?? null;

    let jumpFromPrevKm: number | null = null;
    if (station !== null && prevStation !== null && station.id !== prevStation.id) {
      jumpFromPrevKm = haversine(prevStation.lat, prevStation.lng, station.lat, station.lng);
    }

    const gpsFixAtMs = cycle.gpsFixAtMs;
    const gpsFixAgeMs =
      gpsFixAtMs !== null && prevGpsFixAtMs !== null && gpsFixAtMs === prevGpsFixAtMs
        ? cycle.ts - gpsFixAtMs
        : null;

    results.push({ input: cycle, inferredEnvironment, groundTruthEnvironment, jumpFromPrevKm, gpsFixAgeMs });

    if (station !== null) prevStation = station;
    if (gpsFixAtMs !== null) prevGpsFixAtMs = gpsFixAtMs;
  }

  return results;
}

/**
 * 불변식 1 (ADR-030 §Replay harness backbone) — 지하 구간(ground truth
 * `station.environment === 'underground'`)에서 `inferEnvironment`가 `'surface'`를 채택하면 안
 * 된다. 위반 cycle 목록 반환(빈 배열 = 위반 없음).
 */
export function findSurfaceInUndergroundViolations(
  results: readonly ReplayCycleResult[],
): readonly ReplayCycleResult[] {
  return results.filter(
    (r) => r.groundTruthEnvironment === 'underground' && r.inferredEnvironment === 'surface',
  );
}

/** 한 사이클에서 관측된 station 간 거리가 이 값(km)을 넘으면 "route-라인 밖 점프"로 간주. */
export const OFF_ROUTE_JUMP_THRESHOLD_KM = 0.5;

/**
 * 불변식 2 — 한 사이클(연속 replay step) 안에서 이전 station과 500m를 초과해 점프하면 안 된다
 * (phantom jump). 위반 cycle 목록 반환.
 */
export function findOffRouteJumpViolations(
  results: readonly ReplayCycleResult[],
): readonly ReplayCycleResult[] {
  return results.filter(
    (r) => r.jumpFromPrevKm !== null && r.jumpFromPrevKm > OFF_ROUTE_JUMP_THRESHOLD_KM,
  );
}

/** 이 값(ms)을 넘겨 재사용된 동일 GPS fix가 지하 구간에서 채택되면 stale-GPS over-accept. */
export const STALE_GPS_UNDERGROUND_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * 불변식 3 — 지하 구간에서 5분 이상 갱신되지 않은(동일 `gpsFixAtMs` 재사용) GPS fix가 채택되면
 * 안 된다. 위반 cycle 목록 반환.
 */
export function findStaleGpsUndergroundViolations(
  results: readonly ReplayCycleResult[],
): readonly ReplayCycleResult[] {
  return results.filter(
    (r) =>
      r.groundTruthEnvironment === 'underground' &&
      r.gpsFixAgeMs !== null &&
      r.gpsFixAgeMs > STALE_GPS_UNDERGROUND_THRESHOLD_MS,
  );
}
