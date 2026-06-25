# #1832 Silent Push received=0 Chain Wire Audit

작성: 2026-06-25. BG agent audit.

## 문제 재정의

Day 2 dump `Silent Push received=0` — 35분 trip 동안 device가 silent push 0건 수신.
사용자 매번 외부 trip 해도 chain validation 불가.

## Audit 결과 — 가설 5개 검증

### 가설 1: paradigm Phase 1 가드 부작용 (lockless trip silent push 미발사)

**결론: 의도된 동작 + chain 설계 이해 필요**

코드 경로:
- `backend/scheduled.ts:970` — `trip.infoModeEnabled && waypoint.kind === 'intermediate'`이어야 lockless silent push 발사.
- Day 2 evidence: "boarding-lock skip cycle (lock missing or expired) 37회, locklessOptIn=False" → `infoModeEnabled=false`라 backend도 silent push 발사 안 함.
- `device/fireWithGate:1163-1174` — `guardLine === undefined` 시 `lockless-opt-out` skip (#1810 paradigm shift Phase 1+2).

**실제 chain**: lockless + 사용자 의향 X → backend silent push 발사 0 → device received 0.
이것은 **회귀 아님** (paradigm shift 의도). received=0의 직접 원인.

### 가설 2: APNs response error (410 BadDeviceToken / topic)

**결론: 미발동 (backend 발사 0건이므로 APNs 호출 자체 없음)**

`sendWithEnvHeal(apnsHost.ts)` — BadDeviceToken 시 opposite host로 1회 retry + envCorrected 카운트.
Day 2 log에 APNs 호출 0건이면 본 게이트 도달 자체가 없음. Lab verify 불필요.

### 가설 3: apnsEnv mismatch (production vs sandbox)

**결론: 미발동 (backend 발사 0건)**

`apnsEnv.ts:15-18` — `EXPO_PUBLIC_APNS_ENV` env var로 결정. backend는 `trip.apnsEnv`를 device가 register 시 전달한 값으로 사용.
발사 0건이므로 mismatch 여부 불명. **향후 lock attach 후 첫 push에서 envCorrected stat 모니터링 필요**.

### 가설 4: device handler bug (received counter 증가 path)

**결론: 코드 정상**

`silentPushTask.ts:915-921` — `handleSilentPush` 진입 직후 `extractPayload` 성공 시 `logSilentPushReceived` 호출.
reschedule/trip-ended 분기도 `logSilentPush*Received`를 호출함.
received=0은 push 미도달이지 handler bug 아님.

### 가설 5: boardingPrompt 표시 → silent push 발사 chain 끊김 (#1822 머지 전)

**결론: #1822 fix 이미 적용됨. 하지만 다른 chain 갭 존재**

`boardingPrompt.ts:249-261` — #1820 fix (unknown 허용) 이미 코드에 존재:
```
if (gpsDependentBypass) {
  if (metrics.count === 0) { return window-too-small }
  if (metrics.motion === 'stationary') { return motion-stationary }
  // walking / automotive / unknown 모두 통과
```

Day 2 evidence: 36회 차단은 **#1822 머지 전 버전** (motion-not-moving 차단). PR #1822 머지 완료.
현재 코드에서 motion=unknown은 underground/mixed/unknown 환경에서 통과.

## 확정 Root Cause

```
lockless trip (사용자 의향 X)
  → backend: infoModeEnabled=false → silent push 발사 X
  → device received=0
```

**paradigm shift Phase 1+2 (#1810/#1818/#1819) 의도한 동작**.

사용자가 silent push를 받으려면:
1. boardingPrompt 응답 → lock attach (사용자 명시 의향)
2. 또는 BoardingTrainList 직접 탭 (사용자 명시 의향)

## 잔여 chain 갭 (fix 필요 여부 결정 필요)

### 갭 A: environment=unknown 시 boardingPrompt chain 통과 여부

현재 코드:
- `deriveTripEnvironment(trip)`: `trip.subsurface === undefined` → `'unknown'`
- `isGpsDependentBypassEnv('unknown')` → true → GPS 게이트 bypass
- `motion=unknown` + `environment=unknown` → **현재 통과** (#1822 fix 적용됨)

하지만 `evaluateConsensusGate` 2-of-2 (arrival + lockAttachable) 게이트 통과 필요.
이 chain이 실제로 작동하는지 실기기 검증 필요.

### 갭 B: boarding-prompt 발사 후 device 응답 path

`sendBoardingPromptPush` (alert push) → device 수신 → [탑승] 탭 → lock attach.
device 측 boardingPrompt 응답 handler가 정상 wire됐는지 별도 audit 필요.
관련: `src/features/notice/infra/NotificationRouterImpl.ts` (boarding-prompt category handler).

## Lab verify 가능 여부

| 가설 | 외부 trip 없이 lab verify 가능 여부 |
|---|---|
| 가설 1 (paradigm 의도) | 가능 — 코드 trace만으로 확인됨 |
| 가설 2 (APNs error) | 불가 — 실제 APNs 호출 필요 |
| 가설 3 (apnsEnv mismatch) | 불가 — lock attach 후 첫 push 관찰 필요 |
| 가설 4 (device handler) | 가능 — 코드 정상 확인됨 |
| 가설 5 (boardingPrompt chain) | 부분 가능 — 코드 통과 확인, 실기기 end-to-end는 외부 trip 필요 |

## 다음 액션

1. **이슈 close 조건**: #1832는 audit 완료. 가설 1 = 의도, 가설 4 = 코드 정상.
2. **갭 A 검증**: Day 3 trip에서 boardingPrompt 응답 받은 후 lock attach 확인 (매역 알림 → received > 0).
3. **갭 B 검증**: `NotificationRouterImpl.ts` boarding-prompt 응답 handler 별도 audit.

## 관련

- `backend/alarm-worker/src/boardingPrompt.ts` (9단 게이트)
- `backend/alarm-worker/src/scheduled.ts:965-983` (lockless/lockMissing 분기)
- `src/features/alarm/tasks/silentPushTask.ts:1163-1174` (#1810 paradigm shift lockless-opt-out)
- Day 2 진입점: `memory/project_2026_06_25_day2_pr1819_confirmed.md`
- [[lesson_silent_push_is_ssot_forward_channel]] silent push 단일 채널
