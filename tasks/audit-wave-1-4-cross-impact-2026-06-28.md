# Audit — Wave 1-4 cross-impact + side-effect (2026-06-28)

## 개요

2026-06-28 단일 세션에서 머지된 16 PR (#1937~#1953) 중 13 PR (#1937~#1953 sans #1951 자체)에 대한 cross-impact + side-effect 사전 박제. 사용자 step 2 실기기 trip 전에 발견 가능한 회귀를 RC + acceptance + fix 위치까지 self-contained로 정리한다.

머지 순서 (`dev` first-parent):
```
#1937 → #1938 → #1939 → #1940 → #1941 → #1942 → #1943 → #1944 →
#1945 → #1946 → #1947 → #1948 → #1949 → #1950 → #1952 → #1953
```

---

## 1. 동일 파일 다중 PR 충돌 (자동 처리 + 잔존 logical risk)

`git merge`가 텍스트 충돌은 해결했어도 **논리적 가정 충돌은 그대로 통과**한다. 다음 표는 동일 파일을 만진 PR 그룹과 각각의 영향 면.

| 파일 | 머진 PR | 핵심 변경 (수직 stack) | 잔존 risk |
| --- | --- | --- | --- |
| `src/screens/HomeScreen.tsx` | #1942 #1944 #1947 #1950 #1952 | infoModeEnabled wire + widget tripContext 4곳 wire + currentHopStrategy 전달 + boardingLock+route wire + barometer warmup quorum | 5 PR 모두 controller 본체에 props 추가. 1 cycle에 5 신규 prop 추가 = 회귀 측정 시 책임 분리 불가. dependency 결합 ↑ |
| `src/features/nearest-station/hooks/useFusedNearestStation.ts` | #1949 #1950 #1953 | inferEnvironment SSOT 단일화 + positionTrainResult 4-signal consensus + cascade 11-tier extract | 같은 useMemo 안에 3 종류 게이트 (env, consensus, progression). dep array 5개 신규 — 1 cycle 안에 환경/모션/위치 신호 동시 갱신 시 memo 재계산 빈도 ↑ → CPU 부담 측정 plan 누락 |
| `src/features/alarm/hooks/useApnsTripRegistration.ts` | #1940 #1941 #1942 | warmupConfirmedApnsEnv priming + lock 동봉 buildBoardingPromptContext + infoModeEnabled forward | **Cl-1**: token-refresh 경로(line 314-340)가 main register 경로(line 416) 대비 `buildBoardingPromptContext` 재호출 안 함. `lock` 인자 fix는 main만 적용 — token rotation 시 stale context 잔존 가능 |
| `src/features/alarm/hooks/useBoardingLockController.ts` | #1942 #1950 | createLockFromTrain 진입 시 setInfoModeEnabled stamp + autoLock fast path consensus | autoLock 경로가 consensus 미달 시 idempotency ref 미설정 → 다음 cycle에서도 시도. consensus와 stamp 분리(consensus는 lock 차단, stamp는 BoardingTrainList 탭 시점) — autoLock 차단됐는데 사용자 의향은 stamp되는 경로 부재 (consistent — 의도된 차단) |
| `src/features/debug/components/DebugModal.tsx` | #1940 #1953 | apnsEnvStamped row + cascade tier `fusionTierAdopted` + env reject counter | 신규 row 2 group 추가 — UI 길이 ↑. DebugModal 자체가 cross-feature observer라 V/X dashboard 핵심이므로 부담 적음 |
| `src/shared/constants/realtime.ts` | #1947 #1953 | LOCKLESS_TIME_INTEGRATION_STUCK_TIMEOUT_MS 추가 + MAX_FUSION_DELTA_UNDERGROUND_KM 추가 | 두 PR 모두 상수 추가만 — 가산이라 충돌 없음. 단, 두 PR이 동일 sub-system(fusion realtime)을 다른 paradigm으로 동시에 보강 (gate-hop 4-mitigation + cascade reorder) — fusion 동작 변경이 2 차원에서 동시에 발생 |
| `backend/alarm-worker/src/scheduled.ts` | #1941 #1946 | boardingPromptSkippedLockActive F2 defense + cron LA heartbeat 5min auto-end | 두 PR 모두 stats counter 추가 + cron 루프 mutate. #1941 F2 defense는 lockMissing 진입 후 트랜드 분기, #1946 LA heartbeat는 lockMissing 진입 시점 분기 — 같은 분기에서 두 stat 동시 증가 가능 케이스(예: lock 만료 + LA 침묵 동시) 시 두 종료 경로 race? **검증 필요** |

---

## 2. Cross-impact 매트릭스 (PR간 가정 충돌)

### Cl-1 — useApnsTripRegistration token-refresh path가 #1941 fix 누락

**관련 PR**: #1941 + #1942

**RC**:
- #1941은 `buildBoardingPromptContext`에 `lock` 파라미터 추가 — cross-trip 자동 전환 시 lock.boardingLine 우선.
- main register effect(line 416)는 `buildBoardingPromptContext({ ..., lock: boardingLock })` 호출.
- **token-refresh effect(line 314-340)는 `cachedPromptContext: lastPromptContextRef.current` 그대로 forward** — lock 인자 없이 재빌드 안 함.

**시나리오**:
1. iOS APNs token 발급 직후 trip register (route7 → lock=line7) — main effect가 line7 stamp.
2. 사용자 cross-trip transition: route7 → 환승 후 lock=line2로 갱신.
3. **이 시점에 OS가 APNs token rotation** 발화 (드물지만 OS 결정).
4. token-refresh handler가 `lastPromptContextRef.current` (line7 stamp) + 새 token으로 backend POST.
5. backend KV는 다시 line7로 stamp → boarding-prompt skip empty candidates.

**영향**:
- iOS token rotation 빈도 = 며칠 단위 — N=1 trip evidence 회수 어려움.
- #1941 의도(`cross-trip stale stamp 차단`) 일부 leak.

**Acceptance**:
- token-refresh effect도 `buildBoardingPromptContext({ route: r, currentStation: cs, destination: d, lock: bl })` 재빌드 후 결과를 cachedPromptContext로 forward.
- 또는 main register effect에서 lock 변경 시 lastPromptContextRef.current를 lock-aware로 무조건 갱신 (이미 부분 적용 — line 416-417).

**fix 위치**: `src/features/alarm/hooks/useApnsTripRegistration.ts:314-340` token-refresh handler

---

### Cl-2 — "C 토글" stamp surface 부재 (doc-vs-code drift)

**관련 PR**: #1942

**RC**:
- ADR-014 / `feedback_user_intent_equal_protection`은 사용자 명시 의향 surface 3개 명시: **C 토글 ON / boardingPrompt 응답 / BoardingTrainList 직접 탭**.
- PR #1942 본문도 동일 표현 사용 ("C 토글 ON / boardingPrompt [탑승] 응답 / BoardingTrainList 직접 탭").
- 실제 code stamp 진입점은 2개:
  - `useBoardingPromptResponder.ts:189` — boardingPrompt 응답 stamp.
  - `useBoardingLockController.ts:299` — createLockFromTrain (BoardingTrainList 탭) stamp.
- **"C 토글" UI는 코드상 존재하지 않음** — settings/screens 검색 결과 0건.

**해석**:
- "C 토글"이 doc상 가상 surface일 가능성 — 이전 spec 잔재.
- 또는 "infoModeEnabled" 자체가 "C 토글" 의 internal 표현이고 stamp 진입점 2개로 충분.
- 의도 명확화 필요: doc 정리 (C 토글 표현 제거) 또는 settings UI 추가 (사용자 명시 ON/OFF 토글).

**영향**:
- 사용자가 "그냥 lock 없이 정보 받고 싶다" 시나리오 = stamp 진입점 0 (boardingPrompt 응답 없고 trainList 탭 없는 경우) → backend lockless gate 미통과 → silent push 0건. ADR-014 첫 줄 위반 가능 (의도 = lock active와 동급).

**Acceptance**:
- doc 정리: ADR-014 + feedback에서 "C 토글 ON" 표현 제거 → "boardingPrompt 응답 OR BoardingTrainList 탭" 으로 정정.
- 또는 settings UI 추가: `SettingsScreen` 또는 HomeScreen 헤더에 "정보 모드 (lock 없이 station-passed 받기)" 토글.

**fix 위치**: `docs/decisions/ADR-014-decision-process-rules.md` (정리) OR `src/screens/SettingsScreen.tsx` (UI 추가)

---

### Cl-3 — pickFusionTier (#1953) + positionTrainConsensus (#1950) lockless surface 게이트 비활성 미적용

**관련 PR**: #1950 + #1953

**RC**:
- PR #1953 본문 "Known risk" 명시: "lockless surface tier 6 G3 게이트 비활성 — 본 PR에서는 미적용. follow-up sub-issue로 분리해 별 PR."
- 실제 `requiresPositionTrainConsensus` (#1950 도입)는 surface trip에서 cellular 'surface' 확정 시 통과 — surface 자체 게이트 비활성 X.
- "surface면 GPS 신호 fallback 가능하므로 acceptance 영향 미미"라는 주장이 있으나, **lockless surface trip + cellular warmup 또는 surface-weak** 시 consensus reject → tier 6 채택 안 됨 → tier 7+ fallback. acceptance V1/V7 영향 직접 측정 필요.

**시나리오**:
- 사용자 보훈처~광나루역 지상 구간 lockless trip.
- barometer null (warmup), accelerometer automotive, cellular 'unknown' (PR #1953 production 측정 0건 주장과 충돌).
- `requiresPositionTrainConsensus` 평가: subsurface !== true → continue, automotive !== 'automotive' false → continue, cellular !== 'surface' → return false.
- tier 6 position-train reject → tier 7 (fused) 채택 — fused는 lock 없으면 GPS top-1로 fallback.

**영향**:
- 지상 lockless trip + cellular 'unknown' 비율이 production 5% 이상이면 tier 6 채택률 절반 이하로 떨어짐.
- 측정 인프라 (#1938 telemetry + Sentry breadcrumb) 회복 후 1주 분포 확인 필수.

**Acceptance**:
- 1주 fusion tier 분포 (Sentry breadcrumb `fusion.tier_adopted`) 측정.
- 지상 lockless trip 비율 + tier 6 채택률 분기 — tier 6 < 30% 시 surface 게이트 비활성 옵션 재검토.

**fix 위치**: `src/features/nearest-station/utils/positionTrainConsensus.ts:69` (surface 분기 명시 추가 또는 environment 인자 추가) — measurement 결과 의존.

---

### Cl-4 — widget tripContext 빌더 2개 분기 (DRY 위반)

**관련 PR**: #1944 + #1945

**RC**:
- PR #1944은 `src/features/widget/utils/buildTripContext.ts`에 `buildWidgetTripContext` helper 도입. 4 호출자 (useWidgetMirror / AppState force / backgroundLocationTask / notificationRouter) 동일 진입점.
- PR #1945은 silent push 채널 widget update를 위해 `src/features/widget/utils/updateWidgetFromSilentPush.ts`에 **인라인 buildTripContext** 함수 정의 — `buildWidgetTripContext`를 import 안 함.
- 두 함수가 같은 nextTransferName 추출 의미를 가지지만 다른 구현:
  - `buildWidgetTripContext`: `extractNextTransferName(route)` → `route.transferName` (transfer) / `transfers[0].transferName` (multi-transfer)
  - `updateWidgetFromSilentPush.buildTripContext`: `resolveNextTransferName(route, destinationName)` → `getFirstLeg(route, destinationName).endName`

**의미 동등성 검증**:
- `getFirstLeg`는 transfer에서 `{ line: fromLine, endName: transferName }` 반환 → 동등.
- multi-transfer에서 `{ line: transfers[0].fromLine, endName: transfers[0].transferName }` 반환 → 동등.

**risk**:
- 의미 동등하지만 **2 다른 구현 동시 존재 = 향후 route 형태 변경 시 1만 업데이트되는 회귀 vector** (글로벌 룰 3 — 재사용성 위반).
- updateWidgetFromSilentPush가 buildWidgetTripContext를 호출하지 못한 이유: `tripActive=false` 분기 (#1945의 destination null 시) 차이. helper에 옵션 추가하면 통합 가능.

**Acceptance**:
- `buildWidgetTripContext`에 `allowInactive: boolean` 옵션 추가 (default false, true면 destination null 시 `tripActive: false` stamp 반환).
- `updateWidgetFromSilentPush`가 helper 호출하도록 일원화.

**fix 위치**: `src/features/widget/utils/buildTripContext.ts` (option 추가) + `src/features/widget/utils/updateWidgetFromSilentPush.ts:77-110` (helper 호출로 교체).

---

### Cl-5 — backend scheduled.ts lockMissing 분기에서 #1941 F2 + #1946 LA backstop 동시 실행 race

**관련 PR**: #1941 + #1946

**RC**:
- `scheduled.ts` 메인 cron 루프에서 `evaluateAndMaybeFireBoardingPrompt` (line 1058) 호출 전에 F2 defense (#1941, line 3434-3441)가 lock 활성 시 즉시 return.
- 같은 lockMissing 분기 진입 후 line 1022-1031 LA backstop (#1946)가 `lastLaPushAt + 5min` silence 평가 → `cleanupTripWithLa` 호출.
- 시나리오: lock 만료 직후 같은 cycle에서 trip.boardingLock = undefined이면서 LA 5분 침묵 동시 충족.
- F2 defense는 `trip.boardingLock !== undefined` 검사 — lock 만료 후엔 통과 X. backend 로직상 두 가드 disjoint.

**risk**:
- 코드 read만으로는 race 없음. 단, 두 PR이 같은 lockMissing 분기 진입점 mutate — backend test scenario chain (lockMissing → F2 → LA backstop) 통합 test 부재 가능성.

**Acceptance**:
- `scheduled.test.ts`에 lockMissing 진입 시 F2 + LA backstop 동시 적용 시나리오 추가 (lock 만료 직후 + lastLaPushAt > 5min).
- 두 분기가 각각 정확히 1회 실행되는지 verify.

**fix 위치**: `backend/alarm-worker/src/__tests__/scheduled.test.ts` (test scenario 추가)

---

## 3. Side-effect risk (PR 단독)

### Se-1 — tripDirection.pickLegForCurrentLine multi-transfer 첫 매칭 leg 채택 (#1947)

**관련 PR**: #1947

**RC**:
- `src/features/route/utils/tripDirection.ts:38-42`:
  ```
  for (let i = 0; i < transfers.length; i++) {
    if (currentLine === transfers[i].fromLine) {
      return { line: transfers[i].fromLine, endName: transfers[i].transferName };
    }
  }
  ```
- multi-transfer route(1→2→3→4)에서 사용자가 transfers[2].fromLine 위치인데 우연히 transfers[0].fromLine === transfers[2].fromLine (loopback 또는 동일 line 재사용)이면 **첫 leg 매칭으로 잘못된 방향 산출**.

**시나리오**:
- 환승 multi-transfer route: 2호선 → 4호선 → 2호선 (다시) → 7호선.
- 사용자가 마지막 2호선 진입 시 currentLine === 2호선 → for loop 첫 매칭은 첫 2호선 leg → endName=잘못된 transfer.
- 실제 multi-transfer에서 line 재사용은 매우 드물지만 가능 (예: 같은 노선의 다른 leg를 다시 타는 경유).

**영향**:
- 실제 line 재사용 multi-transfer = 매우 드물어 N=1 trip evidence 어려움.
- direction 산출 오류 → boardingPrompt prompt direction stamp 잘못 → 사용자 confusion.

**Acceptance**:
- `transfers[i].fromLine` 매칭 시 추가 조건: **currentStation이 leg arc 범위 안에 있는지** 검증 (arc 외 → continue).
- 또는 from-leg index를 별도 인자로 받아 직접 지정 (caller가 currentHopIndex로 알고 있음).

**fix 위치**: `src/features/route/utils/tripDirection.ts:38-42`

---

### Se-2 — getLastKnownPositionAsync maxAge 값 불일치 (#1937)

**관련 PR**: #1937

**RC**:
- `useNearestStation.ts:343` — `maxAge: MAX_LOCATION_AGE_MS (15_000ms)`
- `silentPushLocationGate.ts:140` — `maxAge: LOCATION_CACHE_TTL_MS (60_000ms)`
- 두 caller가 동일 OS API + 동일 stale concern을 다른 임계로 사용.

**시나리오**:
- silentPushLocationGate가 60s까지 stale 좌표 허용 → silent push trip 종료/취침 분기 판정에 60s 전 좌표 사용 가능.
- useNearestStation은 15s → 15s 초과 시 OS가 새 sample 발급 시도.

**영향**:
- silentPush 60s 좌표 = 1km 이동 가능 거리 (시속 60km × 60s) → 잘못된 station-passed 판정 가능.
- 단, silentPushLocationGate는 1회성 게이트 (sleep mode 체크 등 — 정확한 위치 의존도 낮은 분기).

**Acceptance**:
- 두 caller 동일 `MAX_LOCATION_AGE_MS = 15_000` 적용 검토. 60s가 의도된 차이라면 doc로 명시.

**fix 위치**: `src/features/alarm/utils/silentPushLocationGate.ts:17` + `:140`

---

### Se-3 — useFusedNearestStation memo cost 측정 plan 부재 (#1949 #1950 #1953 누적)

**관련 PR**: #1949 + #1950 + #1953

**RC**:
- `positionTrainResult` useMemo dep array가 3 PR 적용 후 11개 (trainProgress, gps.userLocation, gps.accuracyMeters, candidates, boardingLock, arcStations, lockedTrainCodeAlive, barometerSubsurface, accelerometerPattern, cellularEnvironmentVote, **+ 1 cascade re-eval ref**).
- 1 cycle에 5 신호 동시 갱신 시 memo 5회 재계산 → 폴링 30s tick 안에 5회 cascade re-pick.

**영향**:
- 측정 plan: `feedback_V8_battery_acceptance` V8 배터리 acceptance 4 mitigation 영향 가능. PR 본문 #1953 측정 plan에는 tier 분포만 명시, memo cost 분포 측정 누락.

**Acceptance**:
- 1주 production: `cascadeReevalCount per cycle` 분포 측정 (Sentry custom metric 또는 alarmLog).
- 5회 초과 cycle 비율 ≥ 10% 시 dep stabilize plan 발동.

**fix 위치**: 측정 인프라 (Sentry breadcrumb `fusion.memo_reeval_count` 추가) + 임계 초과 시 deps 정규화.

---

### Se-4 — useUserIntentStore stamp 시점 vs token rotation race (#1942)

**관련 PR**: #1942

**RC**:
- `setInfoModeEnabled(true)`는 zustand memory + AsyncStorage atomic.
- main register effect는 `infoModeEnabled` zustand selector 의존 — 값 변경 시 즉시 재실행.
- token-refresh handler는 `latestInputsRef.current`를 읽음 — zustand 외부에서 별도 ref 관리.

**시나리오**:
1. 사용자 boardingPrompt 응답 → `setInfoModeEnabled(true)` 호출.
2. memory 즉시 `infoModeEnabled=true` 반영, AsyncStorage write in-flight.
3. **이 사이에 OS APNs token rotation 발화** → token-refresh handler가 `latestInputsRef.current.infoModeEnabled` 읽음.
4. **latestInputsRef는 useEffect로 갱신 (line 238)** — render commit 후 비동기. zustand 변화 → 다음 render → useEffect → ref 갱신. 1 tick race window.

**영향**:
- 1 tick race window = 수십 ms — token rotation이 정확히 그 사이 발생할 확률 0.001% 이하.
- 잔존 risk가 있는 영역이지만 실측 빈도 X.

**Acceptance**:
- token-refresh handler에서 `latestInputsRef.current` 대신 `useUserIntentStore.getState().infoModeEnabled` 직접 호출로 변경. 모든 stamp가 atomic.

**fix 위치**: `src/features/alarm/hooks/useApnsTripRegistration.ts:321` (`ime: useUserIntentStore.getState().infoModeEnabled`).

---

### Se-5 — pickFusionTier "도달 불가" istanbul ignore branch 박제 (#1953)

**관련 PR**: #1953

**RC**:
- `src/features/nearest-station/utils/pickFusionTier.ts:325` `/* istanbul ignore next */` 마지막 fallback 분기.
- TIER_DEFINITIONS 마지막 entry(gps-fallback)는 무조건 결과 반환 (result null이어도 tier만 채택).
- coverage 100% 강제 환경에서 ignore comment는 허용되지만 **실제 도달이 일어나면 production 회귀 — 본 fallback이 silent 동작**.

**영향**:
- TIER_DEFINITIONS 마지막 entry가 변경되어 conditional하게 null 반환 가능해지면 본 fallback에 도달 — coverage tool은 검출 X (ignore 처리), production 영향 X (tier='gps-fallback', result=null로 caller fallback).
- 미래 회귀 vector이지만 즉시 영향 없음.

**Acceptance**:
- TIER_DEFINITIONS 마지막 entry는 영구히 unconditional return으로 유지 (lint rule 또는 type 강제).
- 또는 ignore 제거 + invariant assertion (`throw new Error('unreachable')`)으로 명시.

**fix 위치**: `src/features/nearest-station/utils/pickFusionTier.ts:323-329`

---

### Se-6 — DebugModal apnsEnvStamped row mount 전 race (#1940)

**관련 PR**: #1940

**RC**:
- `useSilentPushDiagnostics` hook이 `warmupConfirmedApnsEnv()` cache 결과 노출 → `apnsEnvStamped` field.
- DebugModal mount 직후 cache 미해소 상태에서 `(none)` 표시 가능 — UI는 일시적이지만 사용자가 cold start 직후 DebugModal 열면 stale display.

**영향**:
- Cosmetic — `(none)` 표시는 30 ms~1s 내 정정. critical path 영향 X.
- DebugModal 자체가 진단 도구라 사용자 의사 결정 영향 X.

**Acceptance**:
- DebugModal mount 시 `warmupConfirmedApnsEnv()` 결과 await 후 첫 render.

**fix 위치**: 보류 — production 영향 미미. follow-up only.

---

## 4. 임시방편 / 우회 코드 잔존

### Tw-1 — #1953 G3 게이트 surface 비활성 follow-up 분리

PR #1953 본문 "Known risk" 명시: "본 PR에서는 미적용 — follow-up sub-issue로 분리해 별 PR". → Cl-3로 박제 + 후속 issue 생성.

### Tw-2 — #1949 useStationMismatchDetector false positive 잔존 risk

PR #1949 본문 "Known risk" 명시: "false positive 가능성. 후속 G3 (#1934/#1926 통합) cascade reorder + mismatch 가드 강화에서 처리". → #1952 (#1951)에서 이미 처리 완료. 검증만 1주 production 측정으로.

---

## 5. Feature flag / rollback path 부재

### Ff-1 — #1942 infoModeEnabled에 kill switch 없음

**RC**: infoModeEnabled가 true가 된 trip은 backend lockless intermediate gate를 통과 — silent push 발사. **device 측 false alarm 발사 회귀가 감지되면 backend deploy 또는 next-build 외에 즉시 차단 수단 없음.**

**Acceptance**: backend 측 admin 토글 (`/admin/disable-lockless-intermediate`) — 모든 trip에서 gate skip.

**fix 위치**: `backend/alarm-worker/src/scheduled.ts:1038` 게이트 직전 `env.KILL_LOCKLESS_INTERMEDIATE` 검사 추가.

### Ff-2 — #1950 4-signal consensus에 kill switch 없음

**RC**: consensus 게이트가 잘못된 false positive로 합법 trip을 reject하면 사용자가 silent push 못 받는 회귀 — 즉시 차단 수단 없음.

**Acceptance**: 환경 변수 `EXPO_PUBLIC_DISABLE_CONSENSUS` true 시 consensus 우회.

**fix 위치**: `src/features/nearest-station/utils/positionTrainConsensus.ts:61` 시작에 검사 추가.

---

## 6. V/X dashboard 가시화 안 된 신호

### Vx-1 — #1942 infoModeEnabled UI 표시 부재

**RC**: 사용자 의향 stamp 상태가 HomeScreen UI에 표시되지 않음 — 사용자가 "내가 의향 stamp 됐는지" 즉시 confirm 불가.

**Acceptance**: HomeScreen 헤더 또는 BoardingTrainList 옆에 "정보 모드 ON" 작은 아이콘 또는 banner.

**fix 위치**: `src/screens/HomeScreen.tsx:141 ~ 헤더 컴포넌트`

### Vx-2 — #1950 consensus reject 분포 measurement plan는 있지만 surface 분배 부재

**RC**: consensus reject 카운트 측정 plan만 명시. surface/underground 환경별 reject 분포 미측정 → Cl-3 검증 불가.

**Acceptance**: Sentry breadcrumb 또는 alarmLog에 `consensus_reject{env=X, reason=Y}` payload 추가.

**fix 위치**: `src/features/nearest-station/utils/positionTrainConsensus.ts:67-70` (reject 시 environment 인자 forward).

---

## 7. 측정 인프라 의존성 (Wave 1-4 acceptance 검증 prereq)

PR #1938 (F-E1~F-E4 telemetry forward safety net)이 baseline. 1주 측정 prereq:
- POST /telemetry/alarm-log count > 0 (R2 적재 회복)
- accelPatternCounts non-zero (production caller)
- /admin/push-ack-stats 200/503 JSON (HTML 0건)

**Wave 1-4 acceptance 측정 의존 PR이 #1938 단 1건** — #1938에서 측정 인프라 회복 실패 시 13 PR acceptance 1주 측정 불가. 사용자 step 2 trip 1건 시 #1938 evidence 우선 확인.

---

## 8. 생성된 후속 issue 번호 list

다음 8건의 후속 audit issue를 본 plan과 동시에 생성:

| # | issue | 제목 | 출처 | 우선순위 |
| --- | --- | --- | --- | --- |
| 1 | #1960 | fix: useApnsTripRegistration token-refresh path에 buildBoardingPromptContext lock 인자 재빌드 누락 | Cl-1 | P2 |
| 2 | #1961 | fix: ADR-014 "C 토글" 표현 정리 또는 settings UI 추가 | Cl-2 | P3 |
| 3 | #1962 | fix: positionTrainConsensus surface 게이트 비활성 follow-up + reject 분포 측정 | Cl-3, Vx-2 | P2 |
| 4 | #1963 | fix: widget tripContext 빌더 2개 분기 통합 (buildWidgetTripContext allowInactive 옵션) | Cl-4 | P3 |
| 5 | #1964 | test: backend scheduled.ts F2 + LA backstop 통합 시나리오 test | Cl-5 | P2 |
| 6 | #1965 | fix: tripDirection.pickLegForCurrentLine multi-transfer 첫 매칭 leg false positive 차단 | Se-1 | P3 |
| 7 | #1966 | fix: getLastKnownPositionAsync maxAge 값 불일치 정합 (15s vs 60s) | Se-2 | P3 |
| 8 | #1967 | feat: backend admin kill switch — lockless intermediate gate + device consensus 우회 | Ff-1, Ff-2 | P2 |

추가 검토 항목 (이슈 안 만들고 measurement 후 결정):
- Se-3 useFusedNearestStation memo cost
- Se-4 useUserIntentStore stamp race
- Se-5 pickFusionTier istanbul ignore branch
- Se-6 DebugModal mount race
- Vx-1 infoModeEnabled UI 표시

---

## 9. 사용자 step 2 trip 직전 self-check

- ✅ 13 PR 본문 + diff 매트릭스 분석
- ✅ 5 종 cross-impact (Cl-1~Cl-5)
- ✅ 6 종 side-effect risk (Se-1~Se-6)
- ✅ 2 종 feature flag 부재 (Ff-1~Ff-2)
- ✅ 2 종 V/X gap (Vx-1~Vx-2)
- ✅ 측정 인프라 prereq (PR #1938 단일 진원지)
- ✅ 8 issue 자동 생성 (high priority risk)
- ✅ plan 박제 (본 markdown SSoT)

사용자 step 2 trip 전 권장:
1. DebugModal 캡처 (apnsEnvStamped + cascade tier + fusionTierAdopted + env reject counter)
2. trip 1회 + alarm log capture
3. /admin/alarm-log-stats 24h window 호출 — tripsScanned ≥ 1 / accelPatternCounts non-zero / silentPushFiredByKind 분포

본 audit이 식별한 8 issue는 사용자 step 2 trip 결과 + 측정 인프라 회복 후 우선순위 재조정.
