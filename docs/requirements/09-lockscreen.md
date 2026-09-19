# 09. 잠금화면 / Live Activity

## 책임
앱을 열지 않아도 trip 진행 상황을 잠금화면·다이나믹 아일랜드·홈 위젯으로 사용자에게 노출한다.

## 경계
- 잠금화면 *위에서* 트리거되는 알람·알림은 [06-alarm.md](./06-alarm.md) / [07-notice.md](./07-notice.md).
- BG에서 잠금화면을 갱신하는 인프라는 [11-background.md](./11-background.md).

---

## 기본 동작

- 사용자는 trip 진행 중 잠금화면에 **현재 역·다음 역·잔여 정거장**이 표시됨을 보장받는다.
- 사용자는 잠금화면 표시가 **매 역마다 BG에서도 갱신**됨을 보장받는다. (혼선 방지)
- 사용자는 다이나믹 아일랜드(iOS)에서 동일 정보를 압축 형태로 받을 수 있다.
- 사용자는 홈 위젯에서 마지막 trip 정보를 볼 수 있다.
- 사용자는 trip 종료 시 잠금화면 표시·다이나믹 아일랜드·위젯이 즉시 정리됨을 보장받는다.

## 예외 / 경계 조건

- 사용자는 잠금화면 Live Activity가 ActivityKit의 `staleDate` 기준으로 자동 stale 마킹·복구(adopt) 처리됨을 보장받는다.
- 사용자는 backend silent push 실패 시에도 사전 예약된 갱신 신호로 표시가 유지됨을 보장받는다.
- 사용자는 위젯 데이터가 trip 종료 후에도 잠시 남아 있다가 다음 진입 시 갱신됨을 보장받는다.
- 사용자는 잠금화면에서 민감 정보(예: 정확한 좌표)가 노출되지 않음을 보장받는다.
- 사용자가 Live Activity를 직접 dismiss한 경우, 30분 TTL 동안 silent push에 의한 LA 재등장이 억제됨을 보장받는다. (사용자 의도 존중)

---

## 횡단 의존

- **알람/알림**: 알람/알림 발사와 잠금화면 갱신은 동기. → [06-alarm.md](./06-alarm.md), [07-notice.md](./07-notice.md)
- **BG**: 사전 예약 + silent push 인프라. → [11-background.md](./11-background.md)

## 코드 진입점

- Live Activity (iOS native): `modules/live-activity/ios/LiveActivityManager.swift:61-68` `adoptExistingActivityIfNeeded()`
- LA push channel: `src/features/alarm/utils/liveActivityPushChannel.ts:70-80` `endLiveActivityWithDeregister()`
- BG silent push 갱신: `src/features/alarm/utils/refreshLiveActivityFromBackgroundContext.ts:93-151`
- LA dismiss sentinel (30분 TTL): `src/features/alarm/utils/laDismissSentinel.ts:37-51`
- Trip ended sentinel: `src/features/alarm/utils/tripEndedSentinel.ts:16-22`
- 위젯 storage: `src/features/widget/api/widgetStorage.ts:23-27` `clearWidgetStation()`
- App Groups (SharedGroupPreferences): `src/shared/infra/storage/SharedGroup*`
- LA content-state builder: `src/features/alarm/utils/stationNotification.ts:251-372` `buildLiveActivityData()`

## 알려진 한계

- ⚠️ BG에서 매 역 갱신 100% 보장 — 부분 구현(silent push + BG location task 등록 조건 의존). Epic #912 통합 진행 중.
- ⚠️ Android 위젯 미지원 (iOS only). `targets/subway-widget/` Swift 파일만 존재.
