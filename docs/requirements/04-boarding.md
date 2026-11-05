# 04. 탑승

## 책임
사용자가 어느 열차에 탔는지 확정하고, 그 정보를 trip의 시작점으로 기록한다.

## 경계
- 경로 설정 자체는 [03-destination-route.md](./03-destination-route.md).
- 탑승 이후의 진행 상황은 [05-realtime-progress.md](./05-realtime-progress.md).

---

## 기본 동작

- 사용자는 현재 역에서 출발하는 열차 시간표 목록에서 탑승할 열차를 **직접 선택**할 수 있다.
- 사용자는 열차를 선택하면 **탑승 확정(Boarding Lock)** 상태가 활성화됨을 보장받는다.
- 사용자는 열차를 선택하지 않은 상태에서 이동이 감지되면 **"이 열차를 탔어요?"** 확인 알림을 받을 수 있다.
- 사용자는 확인 알림에서 "예/아니오"로 응답할 수 있다.
- 사용자는 잘못 선택한 탑승 열차를 변경할 수 있다.
- 사용자는 탑승을 명시적으로 취소할 수 있다.
- 사용자는 환승역 도착이 감지되면 현재 leg의 탑승 확정이 **자동으로 해제(자동 하차)**됨을 보장받는다.
- 사용자는 환승역 도착 직후 **환승 호선의 다음 열차 선택 UI**를 즉시 받을 수 있다. (별도 화면 진입 없이 빠른 선택)
- 사용자는 최종 목적지에 가까워지면 **BG 상태에서도** trip이 자동 종료됨을 보장받는다. 종료 시 도착 알림이 함께 발사되고, 앱 내 상태(BoardingLock·trip 진행 상태·Live Activity·위젯)가 모두 정리된다.

## 예외 / 경계 조건

- 사용자는 한 시점에 **하나의 탑승 확정**만 가질 수 있다. (중복 탑승 불가)
- 사용자는 이동이 감지되지 않는 상태(역에서 정지)에서는 확인 알림을 받지 않는다.
- 사용자는 확인 알림에 응답하지 않으면 자동 추론된 탑승으로 진행되지 않고, 다음 역 도착 시점에 한 번 더 확인 알림을 받는다.
- 사용자는 탑승 확정 상태가 backend와 동기화되지 않으면 알람이 발사되지 않을 위험이 있음을 신호 표시로 받는다. (#622 회귀 대응)

---

## 횡단 의존

- **알람**: 탑승 확정 이후에만 환승/하차 알람이 발사될 수 있다. → [06-alarm.md](./06-alarm.md)
- **개인정보**: 탑승 정보는 backend에 trip 등록 형태로 전송됨(60초 ring + APNs token).

## 코드 진입점

- 탑승 확정 (Lock 컨트롤러): `src/features/alarm/hooks/useBoardingLockController.ts` (`changeLock()`, `releaseLock()`)
- 환승역 자동 해제: `src/features/alarm/hooks/useBoardingLockAutoRelease.ts:36-112`
- 환승 vs 하차 매칭: `useBoardingLockAutoRelease.ts:124-136` `matchReleaseTarget()`
- "이 열차 탔어요?" 응답 처리: `src/features/alarm/hooks/useBoardingPromptResponder.ts:1-176` (BOARDING_PROMPT category)
- Lock backend sync: `src/features/alarm/hooks/useBoardingLockSync.ts`, `useBoardingLockScheduler.ts`
- UI: `src/features/alarm/components/BoardingTrainList.tsx`, `BoardingLockHopCard.tsx`

## 알려진 한계

- ⚠️ **"이 열차 탔어요?" 확인 푸시는 실제로 발사되지 않음** — 응답 처리(`useBoardingPromptResponder`)와 backend 평가/발사 로직(`backend/alarm-worker/src/scheduled.ts:1437-1588` `evaluateAndMaybeFireBoardingPrompt()`)은 구현됐고, 알림 category(`BOARDING_PROMPT_CATEGORY`)도 등록됐음. 하지만 클라이언트의 `src/features/alarm/hooks/useApnsTripRegistration.ts:114-127` `callRegister()` payload에 **`promptGeoContext`·`promptDisplay` 두 필드가 누락**돼 있어서, backend가 `scheduled.ts:1446-1448`에서 두 값이 없으면 평가를 건너뛰고 푸시를 발사하지 않음. → 클라이언트 와이어업만 추가하면 즉시 활성화됨.
- ✅ 환승역 자동 하차 + 다음 열차 UI 구현됨.
- ⚠️ 최종 목적지 도착 시 BG trip 자동 종료 — 자동 하차 sentinel(`destinationArrivalDetect.ts`, 08 도메인 참조)이 4신호 AND로 감지는 하지만, BG에서 도착 알림 발사 + 전체 상태 정리(BoardingLock 해제 + LA dismiss + 위젯 clear)가 한 트랜잭션으로 묶여 있는지 검증 필요.
- ⚠️ 사용자가 탑승을 잘못 선택했을 때의 변경 흐름 — UI 검토 필요.
