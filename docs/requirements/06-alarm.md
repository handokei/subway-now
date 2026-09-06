# 06. 알람 (Alarm)

## 책임
사용자가 **행동해야 하는 순간**(환승 직전, 하차 직전)에 강하게 깨우는 신호를 발사한다.

## 경계
- 정보 전달용 푸시는 [07-notice.md](./07-notice.md).
- BG에서도 동일하게 동작하는 인프라는 [11-background.md](./11-background.md).
- 취침 모드에서의 출력 채널은 [10-sleep-mode.md](./10-sleep-mode.md).

---

## 기본 동작

- 사용자는 환승 1역 전에 **환승 알람**을 받을 수 있다.
- 사용자는 하차 1역 전에 **하차 알람**을 받을 수 있다.
- 사용자는 BG 상태에서도 FG와 동일한 시점·내용의 알람을 받을 수 있다.
- 사용자는 알람을 통해 소리·진동·잠금화면 표시를 동시에 받을 수 있다.
- 사용자는 **"항상" 위치 권한 없이도** 모든 알람을 받을 수 있다.

## 예외 / 경계 조건

- 사용자는 한 trip 내에서 같은 역의 같은 종류 알람을 **단 한 번만** 받는다. (trip-scoped idempotency key: `{tripId}:{stationId}:{alarmType}:{phase}`)
- 사용자는 경로의 첫 역 직후 바로 환승하는 경우 **환승 알람을 받지 않는다**. (이미 환승역에 있음)
- 사용자는 backend silent push가 실패해도 **사전 예약된 local notification**으로 알람을 받을 수 있다.
- 사용자는 GPS가 끊긴 상태에서도 마지막 위치 + 시간표 기반으로 사전 예약된 알람을 받을 수 있다.
- 사용자는 잘못된 위치 신호로 인한 오발화를 방지하기 위해 **다중 신호 AND 게이트**(위치 cache/fresh + 거리 threshold + speed/accuracy 검증 — 5단)를 통과한 알람만 받는다.
- 사용자는 알람을 dismiss한 직후 **5분 또는 200m 이동 전까지** 모든 알람이 silence됨을 보장받는다. (Dismiss Silence Gate, #746)
- 사용자는 탑승 확정 상태가 아니면 알람을 받지 않는다.

---

## 횡단 의존

- **탑승**: 탑승 확정 이후에만 알람이 활성화. → [04-boarding.md](./04-boarding.md)
- **취침 모드**: 알람은 취침 시 이어폰으로만 출력됨. → [10-sleep-mode.md](./10-sleep-mode.md)
- **BG**: silent push + 사전 예약 인프라. → [11-background.md](./11-background.md)

## 코드 진입점

- 알람 트리거 파이프라인: `src/features/alarm/utils/stationPipeline.ts`
- 위치 게이트 (5단): `src/features/alarm/utils/silentPushLocationGate.ts:25-28`
- Phase dedup: `src/features/alarm/utils/notificationState.ts` `firedAlarms` Set (trip 단위)
- 로그 dedup 윈도우 (5초): `src/features/alarm/utils/alarmLog.ts:251` `DEDUP_LOG_WINDOW_MS`
- Movement gate (#727 정적 회귀 방지): `silentPushLocationGate.ts:43-45`
- Dismiss silence (#746): `silentPushTask.ts`
- Rescue re-notification (#725): `alarmLog.ts`
- 취침모드 환승 첫hop suppress: `src/features/alarm/utils/shouldSuppressBySleepRule.ts:34-49`
- 사전 예약 + local fallback: `src/features/nearest-station/tasks/backgroundLocationTask.ts:170-191`
- BoardingLock sync: `src/features/alarm/hooks/useBoardingLockSync.ts`

## 알려진 한계

- ⚠️ Phase alarm dedup이 `firedAlarms` Set(메모리)으로 trip 동안 한 번만 발사하도록 동작 중. 명시적 trip-scoped key(`{tripId}:{stationId}:{type}:{phase}`) 형태로의 재설계는 미진행 — 동작 자체는 trip-1회 보장.
- ⚠️ 로그 dedup은 5초 시간 윈도우(`alarmLog.ts:251`) — 알람 발사 자체와는 별개.
- ⚠️ 첫 역 직후 환승 알람 금지는 **취침모드 조건 한정**으로 부분 구현. 일반 상태에서는 동일 정책 미적용.
- ⚠️ #622 transfer leg backend 미동기화 추적 중.
- ⚠️ "항상" 권한 없이 100% 동작은 ADR/Epic 진행 중.
