# Spec — lock 트립 BG에서 살아있는 LA를 죽이는 경로 봉합 (#2806 잔여 절반)

2026-09-30. 근거 = 9/30 트립 `e25e1158` 실측(KV la-push-counters sent15/failed0 + 덤프 la-fallback 06:39:40~ + LA update 0건@06:34~06:48) + 코드 3-link 확정.

## Root (file:line 확정)

1. `src/features/alarm/utils/stationNotification.ts:738` — lock 트립 GPS writer의 **tripToken 분기가 update-only 가드 없음**(#2806은 :749 else 분기만 가드) → `ensureLiveActivityRegistered` 호출.
2. `src/features/alarm/utils/liveActivityPushChannel.ts:377-390` — LA 시작 훅 둘 다(`useLiveActivityPreBoardingLifecycle`, `useEnsureLiveActivity`) 채널을 우회해 `LiveActivity.updateLiveActivity` 직접 시작 → 채널 세션(`activeTeardown`/`activeTripToken`)은 항상 null → "세션 없음" 판정 → start 경로.
3. `modules/live-activity/ios/LiveActivityManager.swift:190` — `start()` 첫 동작이 `endAllActivities()`, 그 뒤 `Activity.request`(:205)가 BG에서 iOS 거부 throw. **살아있는 LA를 죽이고 나서 실패** → 잠금화면에 죽은 LA가 마지막 content("미탑승")로 최대 4h 잔존, backend push 15건은 죽은 토큰으로(APNs 200, 렌더 0).

## 불변식

> **살아있는 LA는 절대 kill-recreate로 대체하지 않는다. BG에서는 start(=endAllActivities 포함) 자체 금지 — update-only.**

## 변경 (3곳, 최소)

1. **`liveActivityPushChannel.ts` `ensureLiveActivityRegistered`** — 세션 없음(`activeTeardown===null`)인데 `LiveActivity.hasActiveLiveActivity()===true`면 **adopt**: native start 없이 `updateLiveActivity(data)` + 세션 상태 채움(token 구독 배선, native start만 생략). kill-recreate는 **진짜 다른 tripToken의 기존 세션이 있을 때만**(기존 :383-389 경로 유지 — 회귀 안전).
2. **`stationNotification.ts` tripToken 분기(:738)** — :749 가드와 동일하게, BG(headless)에서 `hasActiveLiveActivity()===false`면 start로 빠지지 않고 skip(#2806 가드의 tripToken 분기 확장). FG는 무변경.
3. **`LiveActivityManager.swift` `start()`** — `endAllActivities()`(:190)를 `areActivitiesEnabled` guard(:194) **뒤로** 이동 + 활성 activity 존재 시 kill-recreate 대신 adopt(`adoptExistingActivityIfNeeded` 재사용)+update로 강하. "죽이고-실패" 순서 제거.

## 금지

- LA 시작 훅 2개의 직접-update 시작 방식 변경 금지(그 우회는 의도적 — 헤더 주석 참조).
- 진짜 트립 전환(다른 tripToken) 시 prev 정리 경로 제거 금지.
- mirror 경로(`liveActivityMirrorSync`)·#2481 게이트 로직 변경 금지.
- Swift attribute 파일(SubwayActivityAttributes)은 무변경 — MIRROR 사본 규약 회피.

## 테스트 (TDD red-first, 커밋 순서 증거)

- red: "세션 미등록 + 활성 LA 존재" 상태에서 `ensureLiveActivityRegistered` 호출 → 현 코드는 `endLiveActivity`(kill) 경로 → **kill 미호출 + update 호출**을 assert하는 테스트가 실패해야 red.
- red: BG 시나리오(9/30 시퀀스 모사 — lock 트립·tripToken 존재·LA 활성)에서 `updateStationNotification` → fallback 알림 0 + LA update 1 assert.
- 회귀 안전: 다른 tripToken 세션 존재 시 prev 정리(kill+DELETE) 여전히 수행 assert.
- Swift는 CI 컴파일 없음 — 로직을 최대한 JS 가드로 두고, native 변경은 최소+device verify 항목으로.

## Wire 5단

1. Orphan: `npm run lint:orphan` 0.
2. V/X: alarmLog `la-fallback-notification` 카운트(다음 트립 덤프에서 lock 구간 0 기대) + `live-activity-updated` lock-BG 구간 >0.
3. 의존 PR: N/A.
4. 측정: 다음 실기기 트립 덤프에서 lock 구간 `live-activity-updated>0 && la-fallback=0` + 잠금화면 LA 진행 표시(육안).
5. Device verify: **필수**(native Swift 변경 + BG 동작) — lock 트립 BG에서 LA가 계속 갱신되는지. 재빌드 필요.
