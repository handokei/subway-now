# Plan #1826 — Live Activity BG update wire-completion audit + fix

**SSoT**: 본 문서. audit 결과로 BG agent 자율 갱신.

## 1. 문제

사용자가 FG 들어가야 LA 업데이트 → BG에서 매역/ETA stale. 네이버 야구 점수 같은 BG 자동 갱신 미작동.

### Production evidence (2026-06-25 Day 2 dump)

```
## Silent Push
permission=granted
apnsToken=…35b3502c
activeTrip=(none)
apnsEnv=production
taskRegistration=success
received=0 (last (never))  ← ★
receivedByKind=stn=0 xfer=0 dst=0 unk=0
fired=0 (last (never))
```

**backend가 silent/LA push 보내려 해도 device 도달 0건.** 35분 trip(13:55~14:24) 동안 silent push received 0건.

### 사용자 가치 손실

- BG에서 LA contentState 정지 (FG 진입 시 device polling으로 update)
- 잠금 화면 stationName / etaText / lineName stale
- 사용자 가치: 네이버 야구처럼 BG에서 자동 갱신 (1분 단위)

## 2. iOS LA BG update 메커니즘 (reference)

### 두 경로

| 경로 | 작동 조건 | BG 가능 |
|---|---|---|
| In-app `Activity.update()` | 앱 FG/active | ❌ BG 진입 30s~수분 후 system 일시 정지 |
| APNs push (`apns-push-type: liveactivity`) | backend가 device LA token으로 push | ✅ BG/잠금 화면 작동 |

→ **BG update는 APNs push 전용 경로**. 우리는 이걸 활용해야 한다.

### 빈도 (Apple 명시 X, 실측)

- `priority: 5` (low): **~1분당 1회 안정**. budget 충분
- `priority: 10` (high, iOS 17.2+): **~30s당 1회**. budget 빠르게 소진. 도착 임박만

## 3. 현재 인프라 상태 (1차 grep audit)

| 위치 | 내용 |
|---|---|
| `backend/alarm-worker/src/liveActivity.ts` (375 LOC) | LA push payload + 발사 헬퍼 |
| `backend/alarm-worker/src/scheduled.ts:2649` | cron마다 `trip.activityPushToken && activityState === 'live'`이면 발사 |
| `backend/alarm-worker/src/scheduled.ts:2683 maybeFireLiveActivityUpdate` | dedup 30s + heartbeat 90s + ΔETA threshold |
| `LA_STALE_DURATION_SEC = 90` | cron 60s의 1.5배 |
| `modules/live-activity/ios/LiveActivityManager.swift` (221 LOC) | iOS Swift 모듈 |
| `modules/live-activity/index.ts` (147 LOC) | `addPushTokenListener` (`onPushToken` event) |
| `backend/alarm-worker/src/apns.ts` | `sendLiveActivityUpdate` (push 전송) |

**인프라는 있다.** Wire-completion gap이 어디 있는지 audit 필요.

## 4. 가능한 root cause (4 옵션, false binary 차단)

### A. `activityPushToken` 등록 chain wire-completion gap

- device `addPushTokenListener` 수신 → backend `/live-activity/register` endpoint 전달 흐름
- `trip.activityPushToken` 저장 verify
- 누락된 wire 수정

### B. APNs `liveactivity` topic 헤더 / payload 설정

- `apns.ts sendLiveActivityUpdate`에서 `apns-push-type: liveactivity` header
- `apns-topic: <bundle-id>.push-type.liveactivity` 정확한지
- `apns-priority`, `apns-expiration` (iOS 17.2+ priority 5/10 분리)
- `Authorization: bearer <jwt>` 토큰 유효성

### C. paradigm Phase 1 가드 부작용 — silent push 0건이 LA path까지 영향

- backend가 silent push (`background` topic)와 LA push (`liveactivity` topic)를 별 path로 발사하는가?
- paradigm Phase 1 가드가 silent push만 차단하고 LA update는 lockless여도 발사 가능해야 함
- 만약 두 path가 같은 함수에서 묶여있다면 paradigm 가드가 LA update까지 차단

### D. heartbeat / dedup / threshold 설정 검증 (이미 존재)

- `LA_HEARTBEAT_INTERVAL_MS = 90s`는 적정 (Apple 권장 1분 1회보다 1.5x 여유)
- `LA_PUSH_THRESHOLD_MS = 30s` dedup window
- 변경 불필요로 추정 — A/B/C audit 후 검증

## 5. Audit 필요 사항 (BG agent 위임 — 자율 scope)

1. **A**: `modules/live-activity/index.ts` → backend `/live-activity/register` chain
   - device가 `onPushToken` event 받아서 backend로 register 호출하는 경로
   - backend가 `trip.activityPushToken` 저장하는 endpoint + KV write 검증
   - dump apnsToken vs activityPushToken 분리 확인

2. **B**: `backend/alarm-worker/src/apns.ts` `sendLiveActivityUpdate` headers/payload
   - `apns-push-type: liveactivity` 명시
   - `apns-topic: <bundle>.push-type.liveactivity`
   - priority 5 (heartbeat) / 10 (immediate trigger) 분리 명시

3. **C**: paradigm Phase 1 가드와 LA path 격리
   - `scheduled.ts` 어디서 silent push gating + LA push gating 분리
   - lockless trip이라도 `activityPushToken` 존재 시 LA update 발사 가능한지

4. **D**: heartbeat / dedup / threshold 검증 (부수적)

## 6. 결정 (audit 결과 — 2026-06-25 BG agent 갱신)

### Audit 결론

| 항목 | 결과 | 상세 |
|---|---|---|
| **A** — activityPushToken 등록 chain | ✅ WIRED | device → backend POST /live-activity/register → KV 완전 연결 |
| **B** — APNs liveactivity 헤더 | ✅ CORRECT | `apns-push-type: liveactivity` + `.push-type.liveactivity` topic 정확 |
| **C** — paradigm 가드와 LA path 격리 | ❌ **GAP** | lock 없는 trip에서 `maybeFireLiveActivityUpdate` 전혀 호출 안 됨 |
| **D** — heartbeat / dedup / threshold | ✅ OK | LA_HEARTBEAT_INTERVAL_MS=90s, LA_PUSH_THRESHOLD_MS=30s 적정 |

### Root Cause (C)

`maybeFireLiveActivityUpdate`가 오직 `runTrainCodeTracking` (lock 활성 경로)에서만 호출됨.

- **lockless trip** (`infoModeEnabled === true`, waypoint.kind === 'intermediate'): `runLocklessIntermediate` → LA update 0건
- **lock 없고 boarding-prompt 대기 중** (`!isBoardingLockActive + !infoModeEnabled`): continue(skip) → LA update 0건
- 두 경우 모두 `activityPushToken`이 KV에 등록되어 있어도 LA push 발사 경로에 미도달

### Fix 결정

**C gap fix**: `runLocklessIntermediate` 종료 직전 + `runScheduled` lockMissing 경로에 `maybeFireLiveActivityUpdate` 호출 추가.

구체적으로:
1. lockless trip이 station-passed push 발사 성공 후 → `maybeFireLiveActivityUpdate` 호출 (ETA = signal.etaSeconds 기반)
2. lock 없는 boarding-prompt 대기 중 trip → cron 사이클마다 LA heartbeat 발사 (activityPushToken + activityState='live' 조건부)

**A, B, D**: 변경 없음 — gap 없음 확인.

## 7. Acceptance

- `scheduled.test.ts` — lockless trip + activityPushToken 설정 시 `maybeFireLiveActivityUpdate` 호출 검증
- `scheduled.test.ts` — lock 없는 boarding-prompt 대기 trip + activityPushToken 설정 시 LA heartbeat 검증
- `liveActivity.test.ts` 기존 테스트 회귀 없음
- production 1주 측정: Day 3+ dump `Silent Push received` > 0 + LA contentState BG 갱신 확인

## 8. Out of scope

- iOS 17.2+ priority 5/10 분리는 audit 결과에 따라 별 issue
- LA Interactive ([[feedback_la_interactive_unified_with_boarding_prompt]])는 별 작업
- 잠금 화면 UI 개선 (`SubwayActivityAttributes.swift`)는 별 작업

## 9. Wire-completion 5단 self-check

1. **Orphan**: register endpoint + LA push path 추가 시 wire 검증
2. **V/X dashboard**: backend log `la-push-sent` 카운터 + dump `Silent Push received` 측정
3. **의존 PR**: 잔여 #1+#2+#3과 독립. 별 영역
4. **측정 plan**: Day 3+ dump received > 0 + LA contentState BG 갱신 1주 측정
5. **Device verify**: 실기기 trip BG → 잠금 화면 LA contentState 매 분 갱신 확인 ★ 필수

## 관련 메모리

- [[lesson_silent_push_is_ssot_forward_channel]] silent push 단일 채널 가설
- [[feedback_la_interactive_unified_with_boarding_prompt]] LA Interactive UI 강화 (별 작업)
- [[lesson_seoul_outage_user_blackhole_chain]] silent push 0 → SSoT forward 0 chain
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- [[feedback_user_intent_equal_protection]] paradigm — LA는 사용자 의향 표명 trip에만 활성

## BG agent 위임 지시

### 작업 순서

1. SSoT plan 정독
2. audit 4건 (#5 Audit 필요 사항) — 각 chain + 헤더 + path 격리 + threshold
3. audit 결과 plan SSoT §6 갱신 (Section 6 결정 조정)
4. gap 발견 시 fix 구현 + acceptance 테스트
5. PR 본문에 audit 결과 + Wire-completion 5단

### 격리 규칙

- worktree 절대 경로 안에서만 작업. parent 디렉토리 이동 절대 금지
- 메인 repo는 다른 작업 중 — `tasks/plan-1826-...` 파일만 수정 가능
- worktree 내 plan 파일 변경 commit 금지 (main repo untracked)

### 자율 scope

- audit 결과 옵션 채택 변경 자율 (예: gap 없으면 PR 안 만들고 audit report만 보고)
- 결과를 plan SSoT §6에 명시 + PR 본문에 요약
