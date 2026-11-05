# fusion replay fixture 라이브러리

`#2247` (Epic `#2239` Phase 1, `ADR-030` §Replay harness backbone) — 실기기 dump("Raw Signal")
로부터 뽑아낸 **결정론적 재생 fixture**의 standing 라이브러리. Phase 0(`#2241`)이 만든 harness
(`rawSignalCycleParser.ts` + `fusionReplayDriver.ts`) 위에서 회귀 ratchet으로 상시 재생된다.

## 구조

```
src/testUtils/fixtures/replay/
├── index.ts                              # REPLAY_FIXTURE_LIBRARY SSOT — 신규 fixture는 여기 1개 entry만 추가
├── replay_20260809_g4_env_lock.ts        # 실기기 dump (device-dump)
├── replay_20260809_g4_stale_gps_synthetic.ts        # mechanism-demo (synthetic)
├── replay_20260809_g4_surface_deadzone_positive.ts  # positive stub (synthetic)
└── __tests__/
    └── replayLibrary.full.test.ts        # 라이브러리 전량을 index.ts 기준으로 데이터 주도 재생
```

`src/testUtils/__tests__/fusionReplayDriver.test.ts`는 드라이버 자체의 단위 테스트 + 위 3개
fixture에 대한 **개별 named 단언**(핵심 앵커, 항상 PR 게이트에서 실행)을 담는다.
`replayLibrary.full.test.ts`는 그 위에 얹는 **일반화된 재생 엔진**으로, 향후 라이브러리가 커져도
entry 등록만으로 자동 편입된다.

## 2단 CI 게이트 (ADR-030 §CI 비용/게이팅)

| 게이트 | 실행 시점 | 범위 | 워크플로 |
| --- | --- | --- | --- |
| **PR 게이트(core)** | 모든 PR/push | `tier: 'core'` entry만 재생 | `.github/workflows/ci.yml` → `Type Check & Test` (`npm test`) |
| **nightly(전량)** | 매일 04:00 KST + 수동 | `tier` 무관 라이브러리 전량 재생 | `.github/workflows/e2e.yml` → `Fusion Replay — Full Library` (`REPLAY_FULL_LIBRARY=1`) |

- fake timer 강제 — `replayLibrary.full.test.ts`/`fusionReplayDriver.test.ts` 모두
  `jest.useFakeTimers()`로만 재생한다. real timer(실경과 `setTimeout`)는 금지.
- `extended` tier entry라도 `index.ts`가 무조건 import하므로 PR 게이트에서 coverage 100%는
  항상 만족된다(순수 데이터 상수 import는 비용이 없다) — 비싼 것은 `replayFusionCycles` 재생
  호출인데 그것만 nightly로 미룬다. 자세한 근거는 `index.ts`/`replayLibrary.full.test.ts` 헤더
  참고.
- 현재(2026-08-09 기준) 라이브러리 전량이 3건뿐이라 전부 `core`다. 신규 fixture 승격 시 저렴하면
  `core`(회귀 가치가 크고 개당 ~ms), 그렇지 않으면 `extended`로 등록한다.

## 신규 실덤프 → fixture 승격 절차

1. **캡처**: 앱 DebugModal 7-tap → dump 텍스트 복사(`## Raw Signal (N)` 섹션 포함해야 함).
2. **파일 생성**: `src/testUtils/fixtures/replay/replay_<YYYYMMDD>_<짧은설명>.ts`에 dump 텍스트를
   `export const XXX_DUMP_TEXT = \`...\`;` 형태로 그대로 옮긴다. **조작/합성 금지**(CLAUDE.md
   정직 제약) — 관측된 그대로. 파일 헤더에 캡처 세션/시각, 관측된 stationId와 canonical
   `environment`(`stations.json` 대조), 재현하려는 증상을 기록한다(기존 3개 파일 헤더가 예시).
3. **불변식 확인**: `parseRawSignalCycles` + `replayFusionCycles`(REPL 또는 임시 테스트)로 어떤
   불변식(`surfaceInUnderground` / `offRouteJump` / `staleGpsUnderground`)이 위반/충족되는지
   확인한다.
4. **등록**: `index.ts`의 `REPLAY_FIXTURE_LIBRARY` 배열에 entry 1개 추가 — `id`(파일
   basename), `tier`, `provenance`(`device-dump`|`synthetic`), `capturedAt`, `description`,
   `dumpText`, `expectations`(3단계에서 확인한 불변식·기대값).
5. **검증**: `npx jest src/testUtils` 로 core 재생 확인, `REPLAY_FULL_LIBRARY=1 npx jest
   src/testUtils/fixtures/replay/__tests__/replayLibrary.full.test.ts` 로 전량 재생 확인.

## 미보유 (정직 명시, fabricate 금지)

- **fusion raw-signal dump는 2026-08-09 1건만 존재**(`replay_20260809_g4_env_lock.ts`). 과거
  사건(07-03/08-04/08-07 등)의 backend `evidence_2026*_replay.test.ts`는 trip/push replay
  (backend 계층)이며 fusion raw-signal 시퀀스가 아니다 — 이 라이브러리 입력으로 억지 변환하지
  않는다.
- **stale GPS fix 재사용(`fix=` 필드) 실측 evidence 없음** — `fix=` 토큰은 `#2241` P0-1에서
  신설됐다. 이전 dump는 이 필드가 없어 `replay_20260809_g4_stale_gps_synthetic.ts`는 mechanism-
  demo(합성)로만 존재한다. P0-1 배포 후 다음 실기기 trip부터 실측 승격 가능.
- **지상 dead-zone positive fixture도 합성 stub** — 실기기 지상 dead-zone dump가 수집되면
  `replay_20260809_g4_surface_deadzone_positive.ts`를 실측으로 교체한다.
