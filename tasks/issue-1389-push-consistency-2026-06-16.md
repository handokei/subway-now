# Issue #1389 — 모든 알람/알림 발사 경로 통합 정합성 게이트

> **이 문서는 /clear 후에도 동일 작업을 재개할 수 있는 SSOT 입니다.**
> 변경이 생기면 본 문서를 먼저 갱신하고, 그 다음 코드/PR을 만집니다.

- **이슈**: https://github.com/handokei/subway-now/issues/1389
- **생성**: 2026-06-16
- **브랜치(첫 PR)**: `fix/#1389-push-consistency-helper`
- **base**: `dev`
- **분류**: P0 design (fix label)
- **선행 PR**: #1384 (frontend lock-interp motion guard), #1388 (backend fallback advance motion guard) — partial coverage. 본 epic은 full integration.

---

## 1. 문제 확인 (Evidence)

### 1-1. 사용자 trip evidence (2026-06-16 20:06:54 KST)

용마산역 정지(motion=stationary, GPS=용마산, WiFi 중곡 미매칭) 상태에서 backend가 중곡 imminent push를 발사. device gate가 차단했지만 backend는 헛 발사.

```
20:06:54 | silent-push-received   | received    | station-passed | imminent | 중곡   ← backend 발사
20:06:54 | silent-push-skipped    | suppressed  | gate-out-of-range          | 중곡   ← device 차단
```

- backend는 trainCode arvlCd만 추적 → 중곡 imminent 판단 → 무조건 push 발사
- device는 GPS=용마산 / WiFi 중곡 미매칭 / motion=stationary → "중곡 아님" 신호 모두 무시당함

### 1-2. 사용자 명시 요구

> "지금 모든 알람 발사는 이러한 조건을 가지고 각 분기처리해서 발사가 되어야해"
> "alarm뿐만 아니라 notification도 마찬가지야"

→ 발사 경로 종류 무관(backend push / device 사전예약 / Live Activity / FG fire / boarding-prompt) **모두** 동일 정합성 룰 적용.

### 1-3. 영향 범위 (사이트 inventory)

| Layer | Site | 현재 동작 |
|---|---|---|
| backend | `scheduled.ts:854` trainCode arvlCd → station-passed/imminent push | 무조건 발사 |
| backend | `scheduled.ts:949` rescheduleByDelta | 무조건 발사 |
| backend | `scheduled.ts:1502` boarding-prompt push | 9단 게이트만(별 layer) |
| backend | `scheduled.ts:1758` LA update | 무조건 발사 (별 정책) |
| backend | `scheduled.ts:2041` reschedule fired | 무조건 발사 |
| backend | `#1386` fallback advance station-passed push | motion 가드만 |
| frontend | `useStationAlarm` fg fired | motion-stationary + dedup + warmup |
| frontend | `boardingLockScheduler.ts` `bl:` fire | motion-stationary suppress |
| frontend | `tripBoundScheduler.ts` `tba:` fire | motion-stationary suppress |
| frontend | `silentPushTask.ts` 수신 push 처리 | `gate-out-of-range` 가드 (사용자 evidence가 잡힌 곳) |
| frontend | Live Activity rendering | result.station + lock 표시 (정합성 위반시 fallback display 필요) |

---

## 2. 원인 파악 (Root Cause)

### 2-1. backend layer
- 위치(`currentStationName`)는 log 진단용으로만 추출됨. `scheduled.ts:1693` (`pickLatestCurrentStationName`) 이후 게이트로 연결되지 않음.
- backend는 trainCode arvlCd만 신뢰 → device-side mismatch 정보 없음.
- 사용자가 정지해 있어도 backend는 trip 진행 가정으로 push 발사.

### 2-2. frontend layer
- device 수신 push 단에서 `gate-out-of-range`만 차단. 하지만 device 사전예약(`bl:`/`tba:`) 자체에는 motion gate만 있고 GPS 거리/WiFi 검증 없음.
- LA는 `result.station + lock`을 그대로 표시. 정합성 위반(예: lock=중곡인데 device=용마산)에서도 "다음 역 중곡"이 그대로 노출됨.

### 2-3. 공통 빈틈
- 각 발사 사이트가 자체 가드를 가지지만 **단일 정합성 정의가 없음** → 사이트마다 가드 빠짐/중복.
- 새 발사 경로 추가 시 누락 위험 (안티-누락 게이트 부재).

---

## 3. 해결 방안 (Option 비교)

### Option A — 각 발사 사이트 inline 가드 (최소 surgical)
- 각 사이트에 `if (!allowed) { log + return; }` 직접 추가
- 장점: 빠른 적용, 명확
- 단점: 사이트 분산. 새 경로 추가 시 누락

### Option B — 통합 wrapper (`safeFire(target, device, fireFn)`)
- 모든 발사를 wrapper 경유로 통일
- 장점: 단일 진입점, 누락 차단
- 단점: 큰 리팩토링. LA 같은 다른 정책 분기 어려움

### Option C (권장) — A 후 B
- 즉시: Option A로 inline 적용 → 사용자 영향 빠른 차단
- 후속: Option B로 wrapper 통일 → 신규 경로 누락 방지

### Option D — 통합 게이트 자체 미적용
- 현재 device-side gate(`gate-out-of-range`)에만 의존
- 단점: backend 헛 push 지속, KV/APNs quota 낭비, device gate 회귀 시 false alarm 직격

**선택: Option C — Helper 먼저 박제(이번 PR), backend → frontend 순으로 inline 적용 후 wrapper로 통일.**

---

## 4. 코드 명세

### 4-1. Helper 위치
- backend: `backend/alarm-worker/src/pushConsistency.ts`
- frontend: `src/features/alarm/utils/pushConsistency.ts`
- 동일 로직 mirror. Backend는 vitest, frontend는 jest (각자 환경).
- **mirror 동기화 가드**: `src/features/alarm/utils/__tests__/pushConsistency.mirror.test.ts` 가 첫 doc 주석을 잘라낸 본문 string을 두 파일에서 비교 (reviewer P1-2). 한쪽만 수정하면 jest fail.

### 4-2. 타입

```ts
export type Motion = 'stationary' | 'walking' | 'automotive' | 'unknown';

export type DeviceSignal = {
  currentStationName: string | null;
  motion: Motion;
  wifiStation: { stationName: string; line: string } | null;
  lastUpdateMs: number;
};

export type PushTarget = {
  stationName: string;
  line: string;
};
// Note: phase 필드는 helper 평가 입력이 아니므로 제외(reviewer P1-1).
// callsite가 metric/log 컨텍스트로 phase 정보를 따로 부착한다.

export type TripContext = {
  /**
   * target 기준 device current 위치 hop count.
   *  - 0  : device == target station
   *  - >0 : device가 target보다 N hop behind
   *  - <0 : device가 target보다 N hop ahead
   *  - null: trip context 부재 / 다른 라인 등 산출 불가 → 게이트는 허용으로 fallback
   *
   * callsite에서 trip stopSequence + device currentStationName으로 계산해 주입.
   * helper는 trip 구조에 의존하지 않는다 (backend/frontend Trip 타입 분리 정책).
   */
  deviceHopsBehindTarget: number | null;
};

export type ConsistencyResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'wifi-mismatch'
        | 'motion-stationary-far-behind'
        | 'device-station-mismatch'
        | 'device-ahead-of-target';
    };

/** signal age 컷오프 — 이보다 오래되면 stale 처리해 게이트 fallback(허용). */
export const SIGNAL_STALE_MS = 5 * 60_000;
```

### 4-3. 9-branch 결정 매트릭스

> 평가 순서는 위에서 아래. 먼저 매치되는 분기가 결과를 결정.

| # | device 상태 | push target | 결정 | reason |
|---|---|---|---|---|
| 1 | WiFi == target station/line | * | allow | (강 확증, 지하 정확) |
| 2 | WiFi != target, motion=stationary | target | block | `wifi-mismatch` |
| 3 | now - lastUpdateMs > 5분 | * | allow | (signal-stale, 정보 없음) |
| 4 | currentStationName==null && motion=='unknown' && wifi==null | * | allow | (지하 보호) |
| 5 | trip.deviceHopsBehindTarget == null | * | allow | (trip 모름, fallback) |
| 6 | hops == 0 (device == target) | * | allow | 정상 |
| 7 | hops < 0 (device ahead of target) | target | block | `device-ahead-of-target` |
| 8 | hops == 1 && motion=='stationary' | target | block | `motion-stationary-far-behind` |
| 9 | hops == 1 && motion in {walking, automotive, unknown} | target | allow | 추격 중 |
| 10 | hops >= 2 | target | block | `device-station-mismatch` |

> 결과 분기는 9가지지만 평가 노드는 10개 (분기 #9는 #8의 보완). unit test는 각 노드 + edge 케이스로 작성.

### 4-4. 호출 패턴 (후속 PR)

```ts
import { evaluatePushConsistency } from './pushConsistency';

const consistency = evaluatePushConsistency(deviceSignal, target, tripCtx, now);
if (!consistency.allowed) {
  logSuppressed(consistency.reason, { target, deviceSignal });
  return;
}
// existing fire logic
```

---

## 5. PR 분할 계획

> 첫 PR scope은 **helper + unit test만**. 적용은 후속 PR에서 점진.

| PR | 범위 | base | 머지 조건 |
|---|---|---|---|
| **PR-1 (이번)** | helper + 9-branch unit test (backend + frontend mirror) | dev | type-check + npm test + reviewer agent |
| PR-2 | backend scheduled.ts 5개 발사 사이트에 inline 가드 + `pushConsistencyBlocked` 카운터 | dev | 위 + backend 1358+ tests |
| PR-3 | frontend fire site 5개에 inline 가드 + `localFireConsistencyBlocked` 카운터 | dev | 위 + frontend 5694+ tests |
| PR-4 | Live Activity fallback display (정합성 위반시 "현재 위치 미확정") | dev | UI 검증 |
| PR-5 (선택) | Option B wrapper(`safeFire`)로 통일 | dev | 신규 경로 누락 방지 게이트 |

---

## 6. Acceptance

### 자동화 (PR-1 머지 게이트)
- [ ] `evaluatePushConsistency` unit test — 10개 분기 노드 + WiFi 우선/stale/hops null fallback
- [ ] backend vitest + frontend jest 모두 pass
- [ ] type-check pass
- [ ] coverage 100% (lines/functions/branches/statements)

### 운영 (close 게이트, 1주, PR-2~4 완료 후)
- [ ] 정지 trip(motion=stationary, currentStation 무변경 10분+)에서 backend가 다른 station push 발사 0건
- [ ] device 사전예약 `tba:`/`bl:` 가 정합성 위반 상태 fire 0건
- [ ] LA가 정확하지 않은 station 표시 0건 (fallback display로 fallback)
- [ ] 정상 운행(motion=walking/automotive) 회귀 0건
- [ ] `pushConsistencyBlocked` / `localFireConsistencyBlocked` 카운터 측정 가능

---

## 7. 진행 상태

| 단계 | 상태 |
|---|---|
| 이슈 #1389 발행 | ✅ |
| SSOT 문서 작성 (본 문서) | ✅ |
| 브랜치 생성 `fix/#1389-push-consistency-helper` | ✅ (origin/dev 기준) |
| backend helper + test (22 tests) | ✅ |
| frontend helper + test (22 tests) | ✅ |
| frontend mirror sync test (2 tests) | ✅ (reviewer P1-2 대응) |
| type-check + npm test (100% coverage) | ✅ |
| reviewer agent 1차 + P1 반영 (phase 제거 + mirror 가드) | ✅ |
| PR-1 생성 | ⏳ |
| PR-2 backend inline (worktree) | ⏳ |
| PR-3 frontend inline (worktree) | ⏳ |
| PR-4 LA fallback | ⏳ |
| PR-5 wrapper 통일 (선택) | ⏳ |

---

## 8. /clear 후 재개 가이드

세션을 잃었다면 이 문서를 따라 동일하게 진행할 수 있다.

1. 본 문서 읽기 (`tasks/issue-1389-push-consistency-2026-06-16.md`)
2. 이슈 본문 확인: `gh issue view 1389`
3. 브랜치 확인:
   ```bash
   git fetch origin
   # 신규 시작이면:
   git checkout -b fix/#1389-push-consistency-helper origin/dev
   # 이어가기:
   git checkout fix/#1389-push-consistency-helper
   git merge origin/dev   # CLAUDE.md dev 동기화 룰
   ```
4. 코드 명세(§4)와 9-branch 매트릭스(§4-3)대로 helper 작성:
   - `backend/alarm-worker/src/pushConsistency.ts`
   - `backend/alarm-worker/src/__tests__/pushConsistency.test.ts` (vitest)
   - `src/features/alarm/utils/pushConsistency.ts`
   - `src/features/alarm/utils/__tests__/pushConsistency.test.ts` (jest)
5. 검증:
   ```bash
   npm run type-check
   npm test
   (cd backend/alarm-worker && npm test)
   ```
6. CLAUDE.md 룰대로 reviewer agent 실행 (커밋 전 자동).
7. 커밋 + PR(`base=dev`, body에 `Closes #1389`, label fix, assignee handokei).

### 후속 PR
PR-1 머지 후 본 문서 §5 표를 따라 PR-2(backend inline) → PR-3(frontend inline) → PR-4(LA fallback) → 선택 PR-5(wrapper) 진행.

---

## refs

- 메모리: `project_2026_06_16_session_end_22kst`, `project_2026_06_16_evening_double_fix`, `feedback_acceptance_drives_code`, `feedback_decision_no_false_binary`
- 관련 PR: #1384 (frontend lock-interp motion guard), #1388 (backend fallback motion 가드) — partial coverage
- 코드 참조:
  - `backend/alarm-worker/src/scheduled.ts:854,949,1502,1758,2041` — backend 발사 사이트
  - `backend/alarm-worker/src/scheduled.ts:1692-1727` — currentStationName log only (게이트 적용 안 됨)
  - `backend/alarm-worker/src/positionSeries.ts` — device signal storage (PositionPoint.currentStationName)
  - `src/features/alarm/hooks/useStationAlarm.ts` — FG fire site
  - `src/features/alarm/utils/boardingLockScheduler.ts` — `bl:` schedule
  - `src/features/alarm/utils/tripBoundScheduler.ts` — `tba:` schedule
  - `src/features/alarm/tasks/silentPushTask.ts` — push 수신 처리 (gate-out-of-range 위치)
  - `src/features/nearest-station/api/positionUpload.ts:56` — PositionMotion 타입 SSOT
