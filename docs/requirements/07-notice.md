# 07. 알림 (Notice)

## 책임
사용자가 **알면 좋은 정보**(매 역 진행, 환승역/목적지 도착, 탑승 확인 요청)를 약한 강도로 전달한다.

## 경계
- 행동을 요구하는 강한 신호는 [06-alarm.md](./06-alarm.md).
- 잠금화면 시각 표시 갱신은 [09-lockscreen.md](./09-lockscreen.md).

---

## 기본 동작

- 사용자는 trip 진행 중 매 역 도착 시 **진행 알림**(다음 역·잔여 정거장)을 받을 수 있다.
- 사용자는 환승역에 도착한 시점에 **환승 도착 알림**을 받을 수 있다. (환승 알람과 구분됨 — 환승 *전*은 알람, 환승 *시점*은 알림)
- 사용자는 목적지에 도착한 시점에 **도착 알림**을 받을 수 있다.
- 사용자는 탑승 미선택 + 이동 감지 시 **"이 열차 탔어요?" 확인 알림**을 받을 수 있다. (→ [04-boarding.md](./04-boarding.md))
- 사용자는 알림을 무음 푸시로 받을 수 있다. (소리·진동 없음 기본)

## 예외 / 경계 조건

- 사용자는 한 trip 내에서 같은 역의 같은 종류 알림을 **단 한 번만** 받는다. (알람과 동일한 trip-scoped 키)
- 사용자는 BG 상태에서도 FG와 동일한 시점에 알림을 받을 수 있다.
- 사용자는 인터넷이 끊겨도 마지막 캐시 기반으로 알림이 진행됨을 보장받는다.
- 사용자는 trip 종료 후에는 더 이상 알림을 받지 않는다.
- 사용자는 알림 권한을 거부한 경우 어떤 알림도 받지 않으며, 이 상태가 명확히 안내됨을 보장받는다.

---

## 횡단 의존

- **알람**: 알람과 알림은 발사 채널·정책이 분리됨. 코드 슬라이스도 분리(`src/features/notice/` 신설 예정).
- **잠금화면**: 알림 발사 시 잠금화면 표시도 동기 갱신. → [09-lockscreen.md](./09-lockscreen.md)

## 코드 진입점

- 진행/도착 알림 발사: `src/features/alarm/utils/stationPipeline.ts` `sendStationPassedNotification()`
- 환승 vs 도착 분기: `src/features/alarm/utils/stationNotification.ts:456-488` `target.isTransfer`
- FG 트리거: `src/features/alarm/hooks/useStationAlarm.ts`
- 무음 채널 (Android): `stationNotification.ts:520-540` `ALARM_SILENT_CHANNEL_ID`
- 알림 핸들러: `stationNotification.ts:71-96` `setupNotificationHandler()`
- 신설 예정: `src/features/notice/` (슬라이스 분리)

## 알려진 한계

- ⚠️ 알람과 알림이 같은 코드 슬라이스(`src/features/alarm/`)에 섞여 있음. 분리 작업 필요.
- ✅ "이 열차 탔어요?" 확인 알림 구현됨 — [04-boarding.md](./04-boarding.md) 참조.
