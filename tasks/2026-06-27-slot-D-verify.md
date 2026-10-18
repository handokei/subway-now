# Slot D verify — `revalidate-no-trip` 56회 출처 (2026-06-27)

## scheduledNotificationsDump (0) vs revalidate-no-trip 56회 모순 해결

`scheduledNotificationsDump.ts:68` 는 `Notifications.getAllScheduledNotificationsAsync()` (= **OS scheduled queue, fire 미발생**) 만 dump. dump 시점 `(0)` = 모두 이미 fire 됐거나 cancel 됨.

`bg-scheduled` + `revalidate-no-trip` 의 단일 출처는 `scheduledAlarmReceiver.ts:272 logSuppressedTbaRevalidation` — **OS 가 이미 fire 한 (delivered) 알림** reconcile 시 적재. **모순 없음**: scheduled queue dump = "앞으로 fire 될 것", revalidate-no-trip = "이미 fire 한 stale 잔여를 receiver 가 잡은 것".

## revalidate-no-trip 알람 발사 정확한 경로

silent push 경로 아님 (received=3 모두 13:43:23, source=`silent-push-received` 별도). 확정 경로 = `scheduledAlarmReceiver.ts:431 drainDeliveredScheduledAlarms`.

`AppState 'active'` (line 532) → `getPresentedNotificationsAsync()` (tray 잔존) 전수 reconcile. **핵심 결함**: suppress 시 `cancelScheduledNotificationAsync(identifier)` 만 호출 (line 458) — **delivered tray 에서 제거 안 함** (`dismissNotificationAsync` 미호출). 사용자가 dismiss 안 하면 매 FG 복귀마다 같은 8 알림 재처리.

evidence: 14:04:14 / 14:05:05 / 14:05:39 / 14:05:53 4 burst × 동일 8 entry = 4 회 FG 복귀 시 같은 tray 재 drain. 15:46:47~15:48:14 3 burst (24 entry) 동형. 7 회 drain × 8 = 56.

## runTripBoundCleanups 14:03:01 실행 path

`useDestinationStore.ts:190 tripTransitionQueue` (isSwitch=true). `triggerTripEndRecall` → `runTripBoundCleanups` → `cancelTripBoundAlarms` (tripBoundScheduler.ts:757) 정상 실행.

**핵심 발견**: `cancelTripBoundAlarms` 는 `getAllScheduledNotificationsAsync` 만 조회 — **이미 fire 된 delivered tray 잔여는 filter 대상 외**. 13:43 trip switch 직전 OS 가 ETA 도달로 자체 fire 한 7호선 알람 8 개는 tray 적재 → 14:03 cleanup 이 tray 미터치 → 14:04~15:48 drain 재처리. `scheduleDefensiveCancel` 14:04:01 도 scheduled queue 만 본다 (동일 한계).

## 영역 D 확률 + 새 가설

**확률 95% → 60%.** 원래 D ("OS bg-scheduled queue 잔존") = 실제 X. **실제는 OS queue 잔존 아니라 delivered tray 잔존 + drain 의 dismissNotificationAsync 누락**.

**새 가설 D' (95%)**: drain/reconcile suppress 분기에서 `dismissNotificationAsync` 누락 → 매 FG 복귀시 동일 tray 재처리. 56 회 = 약 7 회 drain × 8 알림.

**검증 가능 fix**:
- `scheduledAlarmReceiver.ts:458` (drain) + `:404` (reconcile) — `dismissNotificationAsync(id)` 추가
- `tripBoundScheduler.ts:757` — `getPresentedNotificationsAsync` 도 prefix 매칭 dismiss
- acceptance: trip switch 후 7h 내 같은 stale id revalidate-no-trip ≤ 1

slot-D-rca.md F1~F4 (backend) 와 별도 — D' = device-side. 동시 wire 필요.
