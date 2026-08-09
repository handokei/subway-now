/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2/P0-2a/P0-2b) —
 * fusionReplayDriver 단위 테스트 + red/positive/synthetic fixture 재생.
 *
 * fake timer 강제(ADR-030 §CI 비용/게이팅) — real timer 사용 금지.
 */
import {
  replayFusionCycles,
  findSurfaceInUndergroundViolations,
  findOffRouteJumpViolations,
  findStaleGpsUndergroundViolations,
  OFF_ROUTE_JUMP_THRESHOLD_KM,
  STALE_GPS_UNDERGROUND_THRESHOLD_MS,
  type ReplayCycleResult,
} from '../fusionReplayDriver';
import { parseRawSignalCycles } from '../rawSignalCycleParser';
import { RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT } from '../fixtures/replay/replay_20260809_g4_env_lock';
import { SYNTHETIC_STALE_GPS_UNDERGROUND_DUMP_TEXT } from '../fixtures/replay/replay_20260809_g4_stale_gps_synthetic';
import { SYNTHETIC_SURFACE_DEADZONE_POSITIVE_DUMP_TEXT } from '../fixtures/replay/replay_20260809_g4_surface_deadzone_positive';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('replayFusionCycles', () => {
  it('빈 시퀀스 → 빈 결과', () => {
    expect(replayFusionCycles([])).toEqual([]);
  });

  it('stationId 미해결(null) → groundTruthEnvironment null, jump 계산 skip', () => {
    const cycles = parseRawSignalCycles(
      '## Raw Signal (1)\n12:00:00 | cycle | - | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=-\n',
    );
    const [result] = replayFusionCycles(cycles);
    expect(result.groundTruthEnvironment).toBeNull();
    expect(result.jumpFromPrevKm).toBeNull();
  });

  it('stations.json에 없는 stationId → groundTruthEnvironment null', () => {
    const cycles = parseRawSignalCycles(
      '## Raw Signal (1)\n12:00:00 | cycle | 99-999 | gps/gps-only | gps(-/-) | - | sub=— | arvlCd=- | arc=- | cell=-\n',
    );
    const [result] = replayFusionCycles(cycles);
    expect(result.groundTruthEnvironment).toBeNull();
  });

  it('subsurface=true인 지하역 → inferEnvironment가 underground 채택 (정상 케이스, violation 없음)', () => {
    const cycles = parseRawSignalCycles(
      '## Raw Signal (1)\n12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | - | sub=true | arvlCd=- | arc=- | cell=-\n',
    );
    const results = replayFusionCycles(cycles);
    expect(results[0].inferredEnvironment).toBe('underground');
    expect(results[0].groundTruthEnvironment).toBe('underground');
    expect(findSurfaceInUndergroundViolations(results)).toEqual([]);
  });

  it('동일 station 연속 → jumpFromPrevKm null(이동 없음)', () => {
    const cycles = parseRawSignalCycles(
      [
        '## Raw Signal (2)',
        '12:00:05 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=-',
        '12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=-',
      ].join('\n'),
    );
    const results = replayFusionCycles(cycles);
    expect(results[1].jumpFromPrevKm).toBeNull();
  });

  it('다른 station으로 이동 → haversine 거리 계산', () => {
    const cycles = parseRawSignalCycles(
      [
        '## Raw Signal (2)',
        '12:00:05 | cycle | 1-021 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=-',
        '12:00:00 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=-',
      ].join('\n'),
    );
    const results = replayFusionCycles(cycles);
    expect(results[1].jumpFromPrevKm).not.toBeNull();
    expect(results[1].jumpFromPrevKm as number).toBeGreaterThan(0);
  });

  it('gpsFixAtMs 없으면 gpsFixAgeMs null', () => {
    const cycles = parseRawSignalCycles(
      '## Raw Signal (1)\n12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | - | sub=false | arvlCd=- | arc=- | cell=- | hpa=- | fix=-\n',
    );
    const [result] = replayFusionCycles(cycles);
    expect(result.gpsFixAgeMs).toBeNull();
  });

  it('첫 fix 관측 cycle은 age 계산 없음(직전 기록 없음)', () => {
    const cycles = parseRawSignalCycles(
      '## Raw Signal (1)\n12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | - | sub=false | arvlCd=- | arc=- | cell=- | hpa=1010.0 | fix=12:00:00\n',
    );
    const [result] = replayFusionCycles(cycles);
    expect(result.gpsFixAgeMs).toBeNull();
  });

  it('fix가 갱신되면(다른 값) age 계산 없음', () => {
    const cycles = parseRawSignalCycles(
      [
        '## Raw Signal (2)',
        '12:00:10 | cycle | 7-015 | gps/gps-only | gps(19m/-) | - | sub=false | arvlCd=- | arc=- | cell=- | hpa=1010.0 | fix=12:00:10',
        '12:00:00 | cycle | 7-015 | gps/gps-only | gps(19m/-) | - | sub=false | arvlCd=- | arc=- | cell=- | hpa=1010.0 | fix=12:00:00',
      ].join('\n'),
    );
    const results = replayFusionCycles(cycles);
    expect(results[1].gpsFixAgeMs).toBeNull();
  });
});

describe('불변식 헬퍼', () => {
  const base: ReplayCycleResult = {
    input: {
      ts: 0,
      kind: 'cycle',
      stationId: null,
      source: null,
      confidence: null,
      accM: null,
      speedMps: null,
      motion: null,
      subsurface: null,
      arvlCd: null,
      arcProgress: null,
      cellularTech: null,
      cellularVote: null,
      barometerHpa: null,
      gpsFixAtMs: null,
    },
    inferredEnvironment: 'surface',
    groundTruthEnvironment: null,
    jumpFromPrevKm: null,
    gpsFixAgeMs: null,
  };

  it('findSurfaceInUndergroundViolations — underground ground truth + surface 채택만 위반', () => {
    const violating = { ...base, groundTruthEnvironment: 'underground' as const, inferredEnvironment: 'surface' as const };
    const ok1 = { ...base, groundTruthEnvironment: 'underground' as const, inferredEnvironment: 'underground' as const };
    const ok2 = { ...base, groundTruthEnvironment: 'surface' as const, inferredEnvironment: 'surface' as const };
    expect(findSurfaceInUndergroundViolations([violating, ok1, ok2])).toEqual([violating]);
  });

  it('findOffRouteJumpViolations — 임계 초과만 위반, 정확히 임계값은 통과', () => {
    const violating = { ...base, jumpFromPrevKm: OFF_ROUTE_JUMP_THRESHOLD_KM + 0.01 };
    const atThreshold = { ...base, jumpFromPrevKm: OFF_ROUTE_JUMP_THRESHOLD_KM };
    const noJump = { ...base, jumpFromPrevKm: null };
    expect(findOffRouteJumpViolations([violating, atThreshold, noJump])).toEqual([violating]);
  });

  it('findStaleGpsUndergroundViolations — underground + 임계 초과만 위반', () => {
    const violating = {
      ...base,
      groundTruthEnvironment: 'underground' as const,
      gpsFixAgeMs: STALE_GPS_UNDERGROUND_THRESHOLD_MS + 1,
    };
    const surfaceStale = {
      ...base,
      groundTruthEnvironment: 'surface' as const,
      gpsFixAgeMs: STALE_GPS_UNDERGROUND_THRESHOLD_MS + 1,
    };
    const undergroundFresh = {
      ...base,
      groundTruthEnvironment: 'underground' as const,
      gpsFixAgeMs: STALE_GPS_UNDERGROUND_THRESHOLD_MS - 1,
    };
    const noAge = { ...base, groundTruthEnvironment: 'underground' as const, gpsFixAgeMs: null };
    expect(
      findStaleGpsUndergroundViolations([violating, surfaceStale, undergroundFresh, noAge]),
    ).toEqual([violating]);
  });
});

describe('P0-2a red fixture — 2026-08-09 실기기 evidence (env 고착 + off-route jump)', () => {
  it('현재 코드에서 red 재현 — 지하 구간 env=surface 채택 위반 다수 발생', () => {
    const cycles = parseRawSignalCycles(RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT);
    expect(cycles.length).toBeGreaterThan(0);
    const results = replayFusionCycles(cycles);
    const envViolations = findSurfaceInUndergroundViolations(results);
    // 이 fixture 구간은 전 stationId가 canonical underground인데 subsurface=false가 지배적 —
    // ADR-030 증상 1·3 root(inferEnvironment.ts:87 우선순위 4)가 그대로 surface를 채택한다.
    expect(envViolations.length).toBeGreaterThan(0);
  });

  it('현재 코드에서 red 재현 — off-route(>500m) 점프 다수 발생', () => {
    const cycles = parseRawSignalCycles(RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT);
    const results = replayFusionCycles(cycles);
    const jumpViolations = findOffRouteJumpViolations(results);
    // 실측 evidence(15:44:02~03 부근 3-021↔5-034↔5-025 6.5km대 왕복 등) — 증상 5의 관측
    // 가능한 부분(불변식 2). Phase 1(A+C) 적용 후에는 이 fixture가 green으로 flip돼야 한다.
    expect(jumpViolations.length).toBeGreaterThan(0);
  });
});

describe('P0-2a synthetic mechanism-demo — stale GPS underground (실측 아님, fix= 계측 P0-1 신규)', () => {
  it('같은 fix가 5분 넘게 재사용되면 findStaleGpsUndergroundViolations가 잡아낸다', () => {
    const cycles = parseRawSignalCycles(SYNTHETIC_STALE_GPS_UNDERGROUND_DUMP_TEXT);
    const results = replayFusionCycles(cycles);
    const violations = findStaleGpsUndergroundViolations(results);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('P0-2b positive fixture (stub, 합성) — 지상 dead-zone 정상 trip', () => {
  it('현재 코드에서 green — 지상 station에서 위반 0건', () => {
    const cycles = parseRawSignalCycles(SYNTHETIC_SURFACE_DEADZONE_POSITIVE_DUMP_TEXT);
    const results = replayFusionCycles(cycles);
    expect(findSurfaceInUndergroundViolations(results)).toEqual([]);
    expect(findOffRouteJumpViolations(results)).toEqual([]);
    expect(findStaleGpsUndergroundViolations(results)).toEqual([]);
  });
});
