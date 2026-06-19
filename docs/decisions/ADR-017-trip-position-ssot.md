# ADR-017 — Backend Trip Position SSoT + 단일 advance 진입점

## 상태

Proposed (2026-06-20). Foundation: T1 (Sub #1554) 머지 후 T2~T8 차례 머지로 acceptance close.

## 배경 — 분산 fire path 회귀

2026-06-19 트립 evidence:
- backend log `15:53:09 ~ 15:58:10` 매분 `arvlcd-fire: station-passed push` + `boarding-lock: waypoint advanced` 반복 (사용자 11분 정지)
- 16:00:01 device가 `transfer imminent 건대입구` 잘못 받음
- 사용자 보고: "정적 misfire 또. 저번에도 계속 수정한다고 했던 건데 왜 계속 이러냐"

memory `project_2026_06_17_p01_epic_lockless_overfire_7day` 동일 회귀 7일 잔존. PR #1382 / #1386 / #1363 / #1408 모두 fail.

### 근본 원인

backend가 **fire 결정을 여러 path에서 독립 수행** → patch가 1개 path만 막고 다음 회귀가 다른 path로 샘:

| Fire path | 현재 게이트 | 누락 |
|---|---|---|
| `scheduled.ts:795 evaluateArvlCdFireGate` | lock 활성 + arvlCd ARRIVED/ENTERING | motion, train identity, env |
| `scheduled.ts:1525 advanceBoardingLockWaypoint` | (cron 호출 직후 무조건) | 합의 게이트 |
| `scheduled.ts:1705 maybeReschedulePush` | 임계치 변동 | motion |
| `boardingPrompt.ts:95 evaluateBoardingPromptGates` | 9-AND (GPS series 5개) | env 분기 |
| `consensusGate.ts:107 evaluateConsensusGate` | env + signals | 호출자가 적용 안 함 |

= **"lock 활성 = fire OK"라는 잘못된 동치**. lock은 fire의 전제일 뿐.

## 결정

### 원칙 1 — Single Source of Truth (`TripPositionSSoT`)

trip별 단일 state row를 KV(`ssot:<token>`)에 보관. trip 위치/모션/사용자 의향을 분산 mutation에서 응집:

```ts
interface TripPositionSSoT {
  tripToken: string;
  currentStationId: string;
  motionState: 'moving' | 'stationary' | 'unknown';
  motionEvidence: Array<{ source: EvidenceSource; ts: number; signal: unknown }>;
  lastAdvanceAt: number;
  lastAdvanceEvidence: EvidenceType;
  passedStations: string[];
  userIntentDeclared: boolean; // C 토글 / boardingPrompt 응답 / BoardingTrainList tap
  seedOverrideCount: number;
  schemaVersion: 1;
}
```

KV 정책:
- prefix `ssot:`. row TTL은 trip lifecycle 정합 (`putTrip` 패턴, `trips.ts:42`).
- `motionEvidence` ring buffer **50건 cap** (`MOTION_EVIDENCE_CAP`). 단일 row ≤5KB.
- 모든 read는 `assertKvCacheTtl`로 Cloudflare KV runtime floor(30s) 강제 ([[lesson_cron_cachettl_runtime_constraint]]).

### 원칙 2 — 단일 mutation 진입점 (T2 #1555)

`advanceTripPosition(token, candidate, evidence, env): 'advanced' | 'blocked' | 'noop'`

내부 6단 게이트 (위에서 거부되면 아래 안 봄):

1. **Seed 게이트** — SSoT.currentStation 있어야 (S1 GAP A)
2. **Motion 게이트** — `motionState !== 'stationary'`
3. **Environment 게이트** — `evaluateConsensusGate(env, signals)` 통과
4. **Evidence type 게이트** — `time-only` 거부 (ADR-015 E4 enforce)
5. **Train identity 게이트** — lock 활성 시 arvlcd `btrainNo == lock.trainCode` (Seoul API `seoul.ts:165`)
6. **Lockless arvlcd 단독 게이트** — lockless면 arvlcd 단독 advance X

추가:
- **Seed override (E5)** — 강 신호 2개 이상 + 30s 연속 일치 시 currentStationId 정정 (`seedOverrideCount++`)
- **WiFi SSID evidence (E6)** — `subwayWifiSsidMap.json` 445/445 매핑 활용

### 원칙 3 — fire path는 reader only

기존 fire path 모두 `advanceTripPosition`을 통해서만 advance. advance 발생 시만 fire:

```ts
// Before (분산):
const gate = evaluateArvlCdFireGate(lock, arvlCd, now);
if (gate === 'fire') await fireArvlCdStationPush(...);
await advanceBoardingLockWaypoint(...);

// After (수렴):
const result = await advanceTripPosition(token, candidate, { type: 'arvlcd', arvlcdTrainCode, lock }, env);
if (result === 'advanced') await fireStationPassedPush(token, SSoT.currentStationId);
```

### 원칙 4 — Motion strict update (T3 #1556)

`/position` POST 수신 시:
- GPS displacement > 50m within 60s → `moving`
- speed > 1m/s sustained → `moving`
- 5분 동안 GPS displacement < 10m AND no arvlcd train-progress → `stationary`
- 그 외 → `unknown` (보수적 보류)

## Sub-task 매핑 (T1~T8)

| Task | 내용 | 의존성 | 본 ADR 원칙 |
|---|---|---|---|
| **T1 #1554** | `TripPositionSSoT` 스키마 + KV helpers + 본 ADR doc | (선행 X) | 원칙 1 |
| **T2 #1555** | `advanceTripPosition` + 6단 게이트 + seedOverride(E5) + WiFi evidence(E6) + train identity(E8) | T1 | 원칙 2 |
| **T3 #1556** | Motion state machine (`/position` 수신부) | T1 | 원칙 4 |
| **T4 #1557** | `arvlcdFire` → `advanceTripPosition` 호출로 refactor | T2, T3 | 원칙 3 |
| **T5 #1558** | `advanceBoardingLockWaypoint` → 통합 | T2, T3 | 원칙 3 |
| **T6 #1559** | `maybeReschedulePush` → SSoT ETA 사용 | T2 | 원칙 3 |
| **T7 #1560** | transferImminent + destinationImminent → SSoT 도달 시만 | T2, T5 | 원칙 3 |
| **T8 #1561** | silent push payload `currentStationId` 권위 필드 (S2 #1535 통합) + cascade picker contract | T2 | 원칙 1 |

## T1 (본 PR) 스코프

본 ADR foundation. **새 게이트 추가도, 다른 fire path 변경도 하지 않는다**:

- `backend/alarm-worker/src/tripPositionSsot.ts` 신설:
  - `TripPositionSSoT` + `EvidenceType` + `EvidenceSource` + `MotionEvidence` + `MotionState` 타입
  - `readSsot` / `writeSsot` / `deleteSsot` KV CRUD
  - `seedSsot()` — S1 GAP A 수신부
  - `pushMotionEvidence()` — ring buffer 50건 cap helper
  - `migrateTripPassedStationsToSsot()` — S6 #1551 read-only fallback (T7 이후 제거)
  - `MOTION_EVIDENCE_CAP = 50` 상수
  - `SSOT_CRON_READ_CACHE_TTL_SEC` (cron read 30s 박제)
- 본 ADR doc

후속 T2~T8이 본 SSOT 위에 게이트/머지/리더-only refactor를 쌓는다.

## ADR-016과의 관계 (보완 / 의존성)

ADR-017이 ADR-016을 대체하지 않음. backend 구조를 잡고 ADR-016 sub들이 그 구조 안에 채워짐:

| ADR-016 sub | ADR-017 통합 |
|---|---|
| S1 #1534 GAP A | T1 SSoT.seed 데이터 필수 (`seedSsot`) |
| S2 #1535 silent push currentStationId + cascade | **T8에 흡수** |
| S3 #1536 9-AND gate env | T2 게이트 #3에 흡수 |
| S4 #1537 realtimePosition 폴링 | T3에 evidence 공급 |
| S5 #1538 pre-scheduled window | 그대로 (device-side) |
| S6 #1539 → #1551 passedStations + cron jitter (머지됨) | T1 `migrateTripPassedStationsToSsot` → T7 이후 통합 |
| S7~S13 | device-side / docs, ADR-017과 독립 |

## Acceptance (close 조건 — 1주 실기기 + production 측정)

### 양방향 시나리오 15건

**Positive (fire 되어야 정상)**:
- P1 lock active + moving + surface + arvlcd + trainCode 일치 → FIRE
- P2 lock active + moving + underground + 다중 신호 → FIRE
- P3 lockless + moving + (gps disp + cellular 변화 + arvlcd) → FIRE
- P4 환승 waypoint 도달 + motion 확정 → transfer-imminent FIRE
- P5 destination + motion 확정 → destination FIRE
- P6 LA Interactive (trip 등록 즉시, lockless train 선택 UI)
- P7 boardingPrompt (lockless + single candidate + moving)
- P8 C 토글 ON / boardingPrompt 응답 → SSoT 통과 (lock 동급, ADR-014 § 사용자 명시 의향 trip)
- P9 환승 후 새 line 새 lock → 새 hop fire 재개

**Negative (fire 되면 안 됨)**:
- N1 **정지 trip + lock active + arvlcd → BLOCK** (2026-06-19 회귀)
- N2 정지 + lockless + arvlcd → BLOCK
- N3 정지 + 어떤 evidence이든 → BLOCK
- N4 moving but arvlcd train != lock.trainCode → BLOCK
- N5 lockless + arvlcd 단독 → BLOCK
- N6 underground + only-gps → BLOCK

### Production 측정 (1주)

1. wrong fire 0건 (오늘 같은 정지 transfer-imminent)
2. lockless trip 첫 station miss ≤ 2
3. cron 4.6s 이상치 / 동시 3중 race가 fire에 영향 0건
4. SSoT.advance blocked 사유 분포 (Sentry breadcrumb)
5. boardingPrompt + autoLock 발사율 (현재 0건 → 정상)
6. 양방향 시나리오 15건 모두 1주 통과

## 사용자 vision 매핑

| 원칙 | SSoT 구현 |
|---|---|
| "정답은 backend가 안다" | SSoT가 backend 단일 SSOT |
| "device는 받기만 한다" | silent push payload에 SSoT.currentStationId forward (T8) |
| "GPS는 결정 권한 X" | gps 단독은 evidence 1개. 다른 신호 동의 필요 (게이트 #3) |
| "시간 적분 fire 권한 박탈" | evidence='time-only' → 게이트 #4 거부 |
| "사용자 명시 의향 trip = lock 동급" | userIntentDeclared=true → lock 활성과 동치 |
| "alarm ≠ notification" | SSoT.advance = alarm 결정. notification은 device 측 banner |
| "한 번 lock 잡으면 X" | 강 신호 2개 + 30s → seedOverride |

## 참고

- Epic #1553
- 회귀 history: memory `project_2026_06_17_p01_epic_lockless_overfire_7day`
- 선행 ADR: ADR-013 (lockless supplementation), ADR-014 (decision process), ADR-015 (multi-signal consensus gate)
- KV runtime 제약: memory `lesson_cron_cachettl_runtime_constraint` + `backend/alarm-worker/src/kvConsistency.ts`
