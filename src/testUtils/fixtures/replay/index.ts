/**
 * #2247 (Epic #2239 Phase 1, ADR-030 §Replay harness backbone) — replay fixture **standing
 * 라이브러리** 인덱스.
 *
 * #2241(G4 Phase 0)이 만든 dump→fixture 파서(`rawSignalCycleParser.ts`)와 replay 드라이버
 * (`fusionReplayDriver.ts`)는 이미 존재한다. 본 파일은 그 위에 얹는 **표준 등록 지점**이다 —
 * 이후 새 실덤프가 fixture로 승격될 때마다(README.md §신규 dump ingestion 참고) 이 배열에
 * entry 하나만 추가하면 라이브러리에 편입된다. `fusionReplayDriver.test.ts`(coreAnchor 개별
 * 단언)와 `__tests__/replayLibrary.full.test.ts`(전량 데이터 주도 재생)가 둘 다 이 인덱스를
 * SSOT로 참조한다.
 *
 * ## tier: 'core' vs 'extended' (ADR-030 §CI 비용/게이팅 — 2단 게이팅)
 * - `core`: PR 게이트(기존 `npm test` / CI `Type Check & Test`)에서 **항상** 재생·단언된다.
 *   빠르고(개당 ~ms) 회귀 시 사용자 가치가 큰 앵커만 core로 유지한다.
 * - `extended`: PR 게이트에서는 **로드만**(import라 trivial coverage) 되고 재생 단언은
 *   nightly(`e2e.yml` 계열, `REPLAY_FULL_LIBRARY=1`)에서만 수행한다. 라이브러리가 수백+ 로
 *   커져도 PR CI 상한을 고정하기 위한 분리 — `__tests__/replayLibrary.full.test.ts` 헤더 참고.
 *
 * 현재(2026-08-09 기준) 라이브러리 전량이 3건뿐이라 전부 `core`다 — 3건 재생은 nightly로
 * 미룰 이유가 없을 만큼 저렴하다(ADR-030 실측: ~100ms/개). 향후 fixture가 누적되면 신규
 * entry부터 `extended`로 등록해 PR 비용을 고정한다.
 */

import { RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT } from './replay_20260809_g4_env_lock';
import { SYNTHETIC_STALE_GPS_UNDERGROUND_DUMP_TEXT } from './replay_20260809_g4_stale_gps_synthetic';
import { SYNTHETIC_SURFACE_DEADZONE_POSITIVE_DUMP_TEXT } from './replay_20260809_g4_surface_deadzone_positive';
import { RED_FIXTURE_20260826_UNDERGROUND_SURFACE_MISCLASSIFY_DUMP_TEXT } from './replay_20260826_underground_surface_misclassify';

/** fixture가 PR 게이트(core)에서 항상 재생되는지, nightly 전용(extended)인지. */
export type ReplayFixtureTier = 'core' | 'extended';

/** fixture가 실기기 dump 그대로인지 mechanism-demo 합성인지 (CLAUDE.md 정직 제약 명시). */
export type ReplayFixtureProvenance = 'device-dump' | 'synthetic';

/** `fusionReplayDriver.ts`의 3개 불변식 헬퍼 이름 — expectation이 참조하는 키. */
export type ReplayInvariant = 'surfaceInUnderground' | 'offRouteJump' | 'staleGpsUnderground';

/** 이 fixture를 재생했을 때 해당 불변식에서 위반이 관측돼야 하는지(true) 0건이어야 하는지(false). */
export interface ReplayFixtureExpectation {
  invariant: ReplayInvariant;
  expectViolations: boolean;
}

export interface ReplayFixtureLibraryEntry {
  /** 고유 id — 파일 basename과 동일하게 유지 (grep 가능성). */
  id: string;
  tier: ReplayFixtureTier;
  provenance: ReplayFixtureProvenance;
  /** 캡처 일자(device-dump) 또는 'synthetic'(합성). */
  capturedAt: string;
  description: string;
  dumpText: string;
  expectations: readonly ReplayFixtureExpectation[];
}

export const REPLAY_FIXTURE_LIBRARY: readonly ReplayFixtureLibraryEntry[] = [
  {
    id: 'replay_20260809_g4_env_lock',
    tier: 'core',
    provenance: 'device-dump',
    capturedAt: '2026-08-09',
    description:
      'G4 env 고착 + off-route 유령 점프 실기기 evidence(F649AAFF9331, 15:15:26~16:17:43). ' +
      'ADR-030 증상 1·3·5 red 재현.',
    dumpText: RED_FIXTURE_G4_ENV_LOCK_DUMP_TEXT,
    expectations: [
      { invariant: 'surfaceInUnderground', expectViolations: true },
      { invariant: 'offRouteJump', expectViolations: true },
    ],
  },
  {
    id: 'replay_20260809_g4_stale_gps_synthetic',
    tier: 'core',
    provenance: 'synthetic',
    capturedAt: 'synthetic',
    description:
      '지하 5분+ stale GPS fix 재사용 mechanism-demo. 실측 fix= 필드가 P0-1 신설이라 아직 ' +
      '실기기 red evidence 없음 — 드라이버 불변식 3 로직 자체 검증용.',
    dumpText: SYNTHETIC_STALE_GPS_UNDERGROUND_DUMP_TEXT,
    expectations: [{ invariant: 'staleGpsUnderground', expectViolations: true }],
  },
  {
    id: 'replay_20260809_g4_surface_deadzone_positive',
    tier: 'core',
    provenance: 'synthetic',
    capturedAt: 'synthetic',
    description:
      '지상 dead-zone 정상 trip positive fixture(stub). Phase 1 A+C 적용 후 miss 트레이드오프 ' +
      '계측용 회귀 가드 — 현재 코드에서 3개 불변식 모두 0건이어야 한다.',
    dumpText: SYNTHETIC_SURFACE_DEADZONE_POSITIVE_DUMP_TEXT,
    expectations: [
      { invariant: 'surfaceInUnderground', expectViolations: false },
      { invariant: 'offRouteJump', expectViolations: false },
      { invariant: 'staleGpsUnderground', expectViolations: false },
    ],
  },
  {
    id: 'replay_20260826_underground_surface_misclassify',
    tier: 'core',
    provenance: 'device-dump',
    capturedAt: '2026-08-26',
    description:
      '2026-08-26 검증탑승 지하 미작동 실기기 evidence(E05A4F244EEB, 17:14:47~20:42:05). ' +
      '7-015(용마산)/7-019(건대입구 7호선) 지하 구간에서 surface 오분류 red 재현 — #2384가 ' +
      '이 오분류를 뚫고 올바른 역을 발사하는지는 bgPositionTrainFire.dumpReplay.test.ts가 검증.',
    dumpText: RED_FIXTURE_20260826_UNDERGROUND_SURFACE_MISCLASSIFY_DUMP_TEXT,
    expectations: [{ invariant: 'surfaceInUnderground', expectViolations: true }],
  },
];
