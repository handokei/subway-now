# Plan: #1833 Fixture Chain Simulation 인프라

작성: 2026-06-25  
브랜치: `feat/#1833-fixture-chain-runner`

---

## 문제

매 chain validation이 외부 실기기 trip에 의존.  
Day 2 dump (`received=0`, `environment=unknown`, `boardingPrompt=blocked`) 같은 raw evidence가 있어도  
각 chain stage가 정확히 어디서 막혔는지 자동으로 재현할 수 없다.

---

## 채택 방향

**A + B + C 조합** — fixture runner + vitest mock + chain assertion DSL

- Day 2 dump 텍스트/JSON을 `DumpFixture` 파싱 → `ChainStageResult[]` 산출
- `runChainFromDump(fixture)` → `ChainReport` (전체 pass/stuck 판정)
- `expect(chain).toReach('lock-attach')` 같은 matcher로 acceptance 테스트 표현
- 새 chain stage는 `CHAIN_STAGES` 배열 1줄 추가로 확장 (data-driven)

MSW는 도입 부담 대비 ROI가 낮다. backend mock은 jest.fn() + 타입 안전 factory로 충분.

---

## 파일 구조

```
src/testUtils/
  fixtures/
    day2/
      morning-trip.txt        ← 6:25-오전.txt (privacy hash 적용)
      afternoon-debug.txt     ← 6:25 오후.txt
      backend-morning.json    ← logs-2026-06-25T08_30_12.817Z.json (요약)
  chainReport.ts              ← ChainReport, ChainStageResult, CHAIN_STAGES
  dumpParser.ts               ← parseDumpFixture(txt) → DumpFixture
  fixtureChainRunner.ts       ← runChainFromDump(fixture) → ChainReport
  chainMatchers.ts            ← toReach / stuckAt custom matcher
  __tests__/
    chainReport.test.ts       ← unit: CHAIN_STAGES 정의, ChainReport 타입
    dumpParser.test.ts        ← unit: 파싱 정확도
    fixtureChainRunner.test.ts ← acceptance 5건
```

---

## Chain Stage 정의

```ts
// CHAIN_STAGES order = 가치 흐름 순서
const CHAIN_STAGES = [
  'trip-registered',           // trip 등록 (destinationId 존재)
  'environment-classified',    // environment != 'unknown' (or unknown_warmup pass)
  'boardingPrompt-displayed',  // boarding-prompt alarm log에 1건 이상
  'lock-attach',               // boardingLock active=yes
  'silent-push-received',      // received > 0
  'station-passed-fired',      // notifications fired에 station-passed 존재
] as const;
```

---

## DumpFixture 파싱

DebugModal dump 텍스트에서 추출:

| 필드 | 파싱 위치 |
|------|-----------|
| `tripStartedAt` | `## Trip` → `tripStartedAt=` |
| `lifecyclePhase` | `## Trip` → `lifecyclePhase=` |
| `silentPushReceived` | `## Silent Push` → `received=N` |
| `boardingLockActive` | `## BoardingLock` → `active=yes/no` |
| `environment` | `## Fusion` → `confidence=`, `subsurface=` |
| `alarmLogSources` | `## Alarm log` → `sources:` 한 줄 파싱 |
| `notificationsFired` | `## Notifications fired (N)` → 건수 |

---

## ChainReport 데이터 모델

```ts
export type ChainStageId =
  | 'trip-registered'
  | 'environment-classified'
  | 'boardingPrompt-displayed'
  | 'lock-attach'
  | 'silent-push-received'
  | 'station-passed-fired';

export interface ChainStageResult {
  stage: ChainStageId;
  passed: boolean;
  evidence: string;  // 파싱한 값 ("received=6", "active=yes" 등)
}

export interface ChainReport {
  stages: ChainStageResult[];
  firstStuck: ChainStageId | null;   // null = 전 stage pass
  allPassed: boolean;
}
```

---

## Acceptance 5건 (테스트 시나리오)

| # | 시나리오 | 기대 결과 | 커버하는 fix |
|---|----------|-----------|-------------|
| 1 | lockless + 의향 없음 → `station-passed-fired=0` | chain stuck at `lock-attach` | #1819 |
| 2 | boardingPrompt=0, lock=no | chain stuck at `boardingPrompt-displayed` | #1822 |
| 3 | environment=unknown (오전 trip 시작 직후) | chain stuck at `environment-classified` | #1823 |
| 4 | silent push received=0 (오후 dump) | chain stuck at `silent-push-received` | #1832 audit |
| 5 | 오전 trip (fix 적용 결과) | chain.allPassed=true | 전체 |

---

## Privacy Hash 정책

dump txt에 포함된 개인정보 필드:
- `apnsToken=…35b3502c` → 마지막 8자리만 보존 (이미 `…` 마스킹됨)
- `lat=`, `lng=` → 소수점 2자리로 round (예: `lat=37.54`)
- `tripToken` → SHA-256 첫 8자 (없으면 그대로)

GPS 좌표 round는 역 수준(~500m) 정확도라 chain 재현에 무관.

---

## Wire-completion 5단

1. **Orphan**: `runChainFromDump`, `parseDumpFixture`, `ChainReport` — 테스트 파일이 직접 호출. `scripts/check-orphan-exports.sh` IGNORE_PATTERN에 추가 불필요 (testUtils는 이미 ignored).
2. **V/X dashboard**: lab only. 외부 관찰 불필요.
3. **의존 PR**: 독립. 머지된 fix (#1819/#1822/#1823/#1825/#1827) 효과를 시뮬하는 것이지 의존하지 않음.
4. **측정 plan**: chain runner가 CI에서 매 PR 자동 수행 → `station-passed-fired` 0건 regression 즉시 탐지.
5. **Device verify**: N/A — lab only (type + unit).

---

## Out of scope

- iOS Simulator E2E
- Backend mock 서버 (MSW) — jest.fn() + factory로 충분
- 자동 dump → fixture 변환 파이프라인 (수동 commit으로 시작)
