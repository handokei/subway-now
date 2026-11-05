# 08. 자동 하차 감지

## 책임
사용자가 실제로 하차했는지 자동으로 감지하고, trip 종료 처리한다.

## 경계
- 하차 *전* 알람은 [06-alarm.md](./06-alarm.md).
- 도착 *시점* 알림은 [07-notice.md](./07-notice.md).

---

## 기본 동작

- 사용자는 목적지 역에서 정지 + 이동 정지 패턴이 감지되면 자동으로 trip이 종료될 수 있다.
- 사용자는 자동 하차 감지 결과 잠금화면 Live Activity·위젯이 즉시 정리됨을 보장받는다.
- 사용자는 자동 감지가 실패한 경우 **수동으로 trip 종료** 버튼으로 종료할 수 있다. ⚠️ UI 흐름 검증 필요.
- 사용자는 trip 종료 시 fired set·BoardingLock 등 trip 내 상태가 모두 초기화됨을 보장받는다.

## 예외 / 경계 조건

- 사용자는 목적지 역을 **지나친** 경우(잘못 내렸거나 잠들었거나) 빠른 시간 내에 trip 종료 후 새 경로를 안내받을 수 있다. ⚠️ 미구현 — 검증 필요.
- 사용자는 환승역에서 잠시 정지한 것을 **하차로 오인하지 않음**을 보장받는다. (환승 vs 하차 구분: 다음 leg 시작 여부)
- 사용자는 GPS 신호가 끊긴 상태에서 자동 하차 감지가 동작하지 않을 수 있고, 이 경우 사용자가 수동 종료할 수 있다.
- 사용자는 자동 종료된 trip을 즉시 **되돌리기** 할 수 있다. (오탐 복구) ⚠️ 미구현 가능성.

---

## 횡단 의존

- **잠금화면**: trip 종료 시 Live Activity dismiss. → [09-lockscreen.md](./09-lockscreen.md)
- **알람/알림**: trip 종료 시 fired set 초기화 → 새 trip에서 알람 재발사 가능.

## 코드 진입점

- 자동 하차 감지 (4신호 AND): `src/features/alarm/utils/destinationArrivalDetect.ts:53-86` — destination 역 + arvlCd(ARRIVED/ENTERING) + 거리 <300m + 정지 ≥3000ms
- 환승 vs 하차 매칭: `src/features/alarm/hooks/useBoardingLockAutoRelease.ts:124-136`
- 자동 정리 (UI banner): `src/features/alarm/hooks/useArrivalAutoClear.ts`
- LA dismiss bridge: `src/features/alarm/hooks/useLiveActivityDismissBridge.ts` (#926)
- Trip-ended sentinel: `src/features/alarm/utils/tripEndedSentinel.ts` (#899 BG cleanup 보정)

## 알려진 한계

- ⚠️ 목적지 지나침 → 빠른 종료 + 재경로 안내 자동 흐름 미구현. (UI banner 표시만 있음)
- ⚠️ 자동 종료 되돌리기(undo) 미구현.
