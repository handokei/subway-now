# #1832 Silent Push received=0 Chain Wire Audit

작성: 2026-06-25 → 갱신 2026-06-28. BG agent audit (재검증).

## 문제 재정의

Day 2 dump `Silent Push received=0` — 35분 trip 동안 device가 silent push 0건 수신.
사용자 외부 trip 매번 해도 chain validation 불가 ([[feedback_chain_validation_not_measurement]]).

## Audit Scope (이슈 본문 4 영역) — 외부 trip 무관 코드 audit

| 영역 | 핵심 file | 결과 |
|---|---|---|
| 1. backend silent push 발사 path | `backend/alarm-worker/src/scheduled.ts` | wire 정상, paradigm 의도 명시 |
| 2. APNs 호출 + response 처리 | `backend/alarm-worker/src/apns.ts` | code 정상, 발사 0건이라 미발동 |
| 3. device push handler | `src/features/alarm/tasks/silentPushTask.ts` | 정상, received counter 정상 |
| 4. boardingPrompt → silent push chain | `backend/alarm-worker/src/scheduled.ts:3420` | alert push chain — silent push와 다른 채널. wire 정상 |

## 영역 1: backend silent push 발사 path

### Silent push 발사 위치 (3 path)

| 호출 위치 | 조건 | trigger |
|---|---|---|
| `scheduled.ts:1690` (arvlcd-fire) | lock active + 9단 게이트 통과 + arvlCd=ARRIVED/ENTERING | station-passed imminent push |
| `scheduled.ts:2050` (vanish-fallback) | lock active + trainCode 소실 + hop 시간 경과 | floor 발사 후 release |
| `scheduled.ts:2757` (transfer-release) | lock active + transfer waypoint 통과 | leg 변경 후 lock release |
| `scheduled.ts:1040` (runLocklessIntermediate) | `infoModeEnabled=true` + intermediate + 9단 게이트 통과 + arvlCd=ARRIVED/ENTERING | lockless intermediate station-passed |

### Paradigm 의도 매트릭스

| trip 상태 | infoModeEnabled | waypoint kind | silent push 발사 | 사용자 표시 |
|---|---|---|---|---|
| Lock active | (irrelevant) | intermediate / transfer / destination | ✓ (lock-path 3 경로) | station-passed 알림 |
| Lockless + 의향 ON | true | intermediate | ✓ (runLocklessIntermediate) | station-passed 알림 |
| Lockless + 의향 ON | true | transfer / destination | ✗ → boardingPrompt 흐름 | alert push (boardingPrompt) |
| **Lockless + 의향 X** | false | (any) | **✗ (paradigm 의도)** | alert push (boardingPrompt) |

**결론**: Day 2 dump `infoModeEnabled=false` (lockless + 의향 X) → silent push 발사 0건 = **paradigm 의도된 동작**. backend는 정상.

### #1729 paradigm shift 확인

`scheduled.ts:2796` — 환승 직후 자동 trainCode swap 제거 (Path B' 제거).
`scheduled.ts:3033` — `maybeBindLocklessTrainCode` 제거 (Path B' 제거).
`scheduled.ts:3503` — `attemptAutoLock` 제거 (Path B 제거).

→ 사용자 명시 의향 없으면 backend는 lock 자동 부착 X. boardingPrompt push로만 사용자 인지 요구.

## 영역 2: APNs 호출 + response 처리

### apns.ts:sendSilentPush 검증 (line 314)

| 항목 | 값 | 상태 |
|---|---|---|
| HTTP method | POST | OK |
| `apns-topic` | `config.bundleId` (env 의존) | OK |
| `apns-push-type` | `'background'` | OK |
| `apns-priority` | `'5'` | OK |
| `aps.content-available` | `1` | OK |
| `apns-thread-id` | `tripToken` (있을 때만) | OK |
| `apns-push-type=background` 필수 환경 | iOS 13+ 강제 | OK |

### Response 처리

- `response.ok` (2xx) → `{ ok: true, status }` 반환
- 4xx/5xx → `parseApnsError(response)` → caller가 enqueueRetryIfTransient로 적재
- 410 BadDeviceToken → `sendWithEnvHeal`이 opposite host로 1회 retry + `envCorrected` 카운트 + KV persist

**결론**: APNs 호출 path 정상. 발사 0건 = APNs 미호출이므로 envHeal/410 게이트 도달 자체 없음.

## 영역 3: device push handler

### Task 등록 (정상)

- `silentPushTask.ts:105` — `SILENT_PUSH_TASK = 'silent-push-reschedule'`
- `silentPushTask.ts:1475` — `TaskManager.defineTask(SILENT_PUSH_TASK, handleSilentPush)` 모듈 load 시 자동 등록
- 호출자 2곳: `src/screens/HomeScreen.tsx:853`, `app/_layout.tsx:66`
- iOS `UIBackgroundModes`: `['location', 'fetch', 'remote-notification']` 확인 (`app.config.js:51`)

### Received counter 증가 path

- `handleSilentPush` 진입 → `extractPayload(input.data)` 호출
- `extractPayload` 실패 시 logger.info('payload missing or invalid — skip') → received counter 증가 X
- 성공 시 line 925 `logSilentPushReceived` 무조건 호출 (kind 미상이어도)
- reschedule/trip-ended 분기도 자체 `logSilentPush*Received` 호출

### extractPayload graceful 검증

- `findFieldsLayer`: 3-level nesting + 4가지 candidate (standard/reschedule/trip-ended) → false-negative drop 위험 낮음
- `extractStandardPayload`: `etaSeconds`, `phase` strict required. 그 외 다 optional + validator graceful

**결론**: device handler code 정상. push 미도달이지 handler bug 아님.

## 영역 4: boardingPrompt → silent push chain

### 의도된 chain 흐름

1. lockless + 의향 X → backend `evaluateAndMaybeFireBoardingPrompt` (`scheduled.ts:3420`)
2. 9단 게이트 통과 + candidateTrains ≥1 → `sendBoardingPromptPush` (**alert push**, line 3567)
3. device 표시 → 사용자 [탑승] 탭 → `useBoardingPromptResponder:189` → `setInfoModeEnabled(true)` → `useApnsTripRegistration` 재등록
4. 다음 cron cycle → backend `infoModeEnabled=true` → silent push 발사 활성

**중요**: boardingPrompt 자체는 **alert push (`apns-push-type: alert`)** — silent push와 다른 채널. 이슈 본문 5번 가설 "boardingPrompt 표시 → silent push 발사 chain"은 chain 직접 발사 X. 사용자 응답 → infoModeEnabled flip → 후속 cron silent push의 wire.

### Wire 검증

| Wire 지점 | 위치 | 상태 |
|---|---|---|
| boardingPrompt 응답 → infoModeEnabled set | `useBoardingPromptResponder.ts:189` | OK |
| BoardingTrainList 탭 → infoModeEnabled set | `useBoardingLockController.ts:280` | OK |
| infoModeEnabled → backend POST /trips | `useApnsTripRegistration.ts:434` | OK |
| /trips POST → trip.infoModeEnabled | `alarmBackend.ts:220` | OK |
| trip.infoModeEnabled → lockless gate | `scheduled.ts:1038` | OK |

**결론**: chain wire 정상. paradigm 정합.

## 확정 Root Cause

```
lockless trip (사용자 의향 X)
  → backend: infoModeEnabled=false → silent push 발사 X
  → device received=0
```

**paradigm shift Phase 1+2 (#1810/#1818/#1819) 의도된 동작.** Silent push 0건 = **회귀 아님**.

[[lesson_silent_push_zero_is_paradigm_intent]] 확인:
- lockless + 의향 X → silent push 발사 0건 = 정상 paradigm
- 사용자가 의향 표명(boardingPrompt 응답 또는 BoardingTrainList 탭) 시 backend가 silent push 발사 시작
- 후속 trip에서는 lock attach 후 매역 silent push 발사 → received > 0 정상

## Fixture Lab 시뮬레이션 (이미 존재 #1833 / PR #1834 머지)

`src/testUtils/fixtureChainRunner.ts:97` — `silent-push-received` stage:
```typescript
'silent-push-received': (f) => {
  const received = f.silentPushReceived ?? 0;
  return { passed: received > 0, evidence: `received=${received}` };
}
```

`src/testUtils/__tests__/fixtureChainRunner.test.ts:104` — acceptance 4: silent push received=0 (오후 dump) → chain stuck at silent-push-received.

**Day 2 dump fixture로 received=0 chain 재현 시뮬레이션 가능 — 이미 머지된 인프라**.

## 1주 측정 plan

| 신호 | 출처 | 목표 |
|---|---|---|
| `stats.silentPushFiredByKind.intermediate` | wrangler tail (backend) | lock active 시 > 0 (lockless+의향X면 0 정상) |
| `stats.boardingPromptFired` | wrangler tail | 사용자 의향 표명 전 trip마다 ≥1 (외부 trip 시) |
| `stats.boardingPromptSkippedEmpty` | wrangler tail | Seoul API 응답 0건 검증 |
| `silent-push-received` alarmLog count | DebugModal / Sentry | 사용자 응답 후 매역 ≥1 |
| `envCorrected` stat | wrangler tail | lock attach 후 첫 push에서 0이면 mismatch 없음 |

## 외부 trip evidence 요구 (audit 이후)

코드 audit으로는 다음을 확정 불가 — 외부 trip 필요:
1. boardingPrompt push가 실제로 device에 표시되는지 (#1822 motion-grace 머지 후 evidence 필요)
2. 사용자 [탑승] 응답 후 다음 cron cycle에서 silent push 발사 시작 (received ≥1 evidence)
3. lock active trip의 station-passed silent push 매역 발사 (#1832 본문 evidence 1주 0건 목표)

이 evidence는 **#1832 audit과 분리**되어 후속 트래킹 (외부 trip evidence 수집).

## 다음 액션

1. **이슈 #1832 close 조건**: audit gap 0건 + paradigm 의도 확정 + plan SSoT 박제. 외부 trip evidence는 별도 분리.
2. **외부 trip 시 evidence 수집**: 사용자 다음 외부 trip에서 boardingPrompt 표시 → 응답 → silent push received 증가 확인.
3. **lesson 정합 강화**: `lesson_silent_push_zero_is_paradigm_intent` 참고. 이번 audit이 lesson을 재확정함.

## 관련

- `backend/alarm-worker/src/boardingPrompt.ts` (9단 게이트)
- `backend/alarm-worker/src/scheduled.ts:1038` (lockless intermediate 게이트)
- `backend/alarm-worker/src/scheduled.ts:3420` (evaluateAndMaybeFireBoardingPrompt)
- `backend/alarm-worker/src/apns.ts:314` (sendSilentPush)
- `src/features/alarm/tasks/silentPushTask.ts:756` (handleSilentPush)
- `src/features/alarm/store/useUserIntentStore.ts` (#1923 SSoT store)
- `src/features/alarm/hooks/useBoardingPromptResponder.ts:189` (응답 → set)
- `src/features/alarm/hooks/useBoardingLockController.ts:280` (탭 → set)
- Day 2 진입점: `memory/project_2026_06_25_day2_pr1819_confirmed.md`
- [[lesson_silent_push_zero_is_paradigm_intent]] silent push 0 = paradigm 의도
- [[lesson_silent_push_is_ssot_forward_channel]] silent push 단일 채널
- [[feedback_chain_validation_not_measurement]] 측정 ≠ 검증
- [[feedback_device_self_contained_fusion]] device self-contained paradigm
- [[lesson_auto_lock_chain_backend_push_dependency]] push 0건 = chain dead
