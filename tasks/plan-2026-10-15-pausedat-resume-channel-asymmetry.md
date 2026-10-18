# plan 2026-10-15 — pausedAt storage 채널이 재개 경로에서 안 지워져 backstop이 활성 trip을 DELETE

> **검증 이력 (v3)**
> - v1 → 10종 검증에서 **반증 2건**: ① 기존 확정 결정(#2997 S4-c) 충돌 미선언 + S2가 폐기 예정
>   분기를 보강 ② 교차 축(콜드 재시작) 누락.
> - v2 → **재검증에서 반증 2건 추가**: ① "S1은 S4-c의 선결 조건"은 근거 없는 연결(두 신호는
>   device storage vs backend 별개 채널) ② acceptance 4가 S4-c를 막는 게이트가 됨.
> - v3 = 위 4건 전부 반영. 추가로 **배치 위치 확인 완료**(`.eslintrc.js` zone +
>   file-level disable 선례 3건 → `tripBoundCleanups.ts:223` 옆 대칭 함수가 통과).
> - **남은 `추정` 1건**: 콜드스타트에서 알림 응답 핸들러(`app/_layout.tsx:165`)와 backstop
>   (`:189`)의 실행 순서 — 둘 다 같은 레이아웃에 마운트되고 `useDeferredNavigate.ts:10`이
>   *"`addNotificationResponseReceivedListener`는 cold-start 시 동기적으로 fire된다"*고
>   적어 경쟁은 확정이나, 승자는 확정하지 않았다.
>
> **우선순위: 하.** 이 결함은 실재하지만 2026-10-15 LA 부재의 원인이 **아니다**(그 원인은
> #2999 TTL 400, 배포로 해소). 같은 날 alarm log ring(00:24~16:43 전체)에 pause backstop
> 발사가 0건임을 D1·덤프로 확인했다.

## 증상 (실측, 2026-10-15 배포 후) 【추정 — 이 세션에서 덤프/D1 재확인 안 함】

`runNavigationPauseBackstop`이 stale `pausedAt`으로 진행 중인 trip을 종료(backend `DELETE /trips`)
→ 이후 LA 등록이 `trip_not_found` 3회 후 포기 → **LA 영구 부재**. 알림은 오는데 LA만 없다.
alarmLog reason 라벨은 `trip-paused-auto-ended`이고 breadcrumb reason은 `navigation-pause-auto-end`
(자동 처리인데 사용자 삭제로 오독될 수 있음).

## 진단 (확정 주장)

`pausedAt`은 채널이 둘이다.

- memory — `useNavigationStore.pausedAt` (FG 배지 카운트다운 소스), `useNavigationStore.ts:62`
- storage — `NAVIGATION_PAUSED_AT_KEY` (cold-start backstop 판정), `navigationPauseStorage.ts`

stamp는 한 곳(`HomeScreen.handleStopNavigation`, `HomeScreen.tsx:499-503`)이 두 채널을 함께 찍는다.
**clear는 비대칭이다** — memory clear는 store 액션 `startNavigation()` 안에 들어있고
(`useNavigationStore.ts:89-91`), storage clear(`clearNavigationPausedAt()`)는 HomeScreen 핸들러에만
수기로 wire되어 있다(`HomeScreen.tsx:483`).

`startNavigation()` 호출부 3곳:

| 진입점 | file:line | memory clear | storage clear |
| --- | --- | --- | --- |
| 안내 시작 버튼 | `HomeScreen.tsx:478` + `:483` | O | O |
| boardingPrompt [탑승] 응답 | `useBoardingPromptResponder.ts:301` | O | **X** |
| BoardingTrainList 직접 탭 | `useBoardingLockController.ts:457` | O | **X** |

→ 아래 2·3번으로 재개하면 배지는 사라지지만 storage stamp는 남는다. T+15분 이후 첫
mount/AppState active에서 `isPauseAutoEndDue(T)`가 true → `runNavigationPauseBackstop`
(`useStateRehydration.ts:288`) → `tripBoundCleanups.ts:364 clearActiveTrip` →
`alarmBackend.ts:646-648 DELETE /trips/{token}` 실행 → 활성 trip 사망.

### 교차 축 — 재개 경로 × 앱 생애 (v1 누락, 검증 반증 ②)

근본은 "#2371이 2곳에 storage clear 짝을 안 들고 왔다"에 그치지 않는다. **storage clear가
호출부마다 수기 wire**인 동시에 **memory 채널은 콜드 재시작에 증발**한다
(`useNavigationStore.ts:51` *"의도적으로 휘발성 (persist 미적용) — cold start 시 false로 reset"*).
두 사실의 곱이 아래 표다.

| 재개 경로 | warm (앱 생존) | cold 재시작 후 |
| --- | --- | --- |
| 안내 시작 버튼 | 안전 — 두 채널 clear | 안전 — `HomeScreen.tsx:483`이 storage clear |
| boardingPrompt [탑승] | **누출** — storage stamp 생존, 배지만 사라짐 | **누출 + 배지 영구 부재** |
| BoardingTrainList 탭 | **누출** — 동일 | **누출 + 배지 영구 부재** |
| 재개 안 함(승차만, `infoModeEnabled` trip) | 배지 표시됨(예고 있음) | **배지 영구 부재** — 예고 없이 종료 |

cold 열의 "배지 영구 부재"는 `HomeScreen.tsx:1694` 조건
(`destination && !navigationActive && navigationPausedAt !== null`)이 memory `pausedAt`에
의존하기 때문이다 — 재시작으로 null이 되면 조건이 영구 불성립이고, 사용자는 15분 카운트다운을
한 번도 보지 못한 채 trip이 종료된다. 즉 콜드 셀은 재개 경로 3곳 **전부를 우회**한다.

#### 이 표의 미커버 선언 판정 (검사 #4)

| 선언 | 판정 |
| --- | --- |
| `useNavigationStore.ts:51` "cold start 시 false로 reset" | **깨뜨리지 않는다(유지).** 휘발성은 의도이므로 memory를 persist하지 않는다 — 대신 storage 채널을 신뢰할 수 있게 만들어(S1) cold 셀을 해소한다 |
| `useNavigationStore.ts:40,58` "store는 의도적으로 cross-feature AsyncStorage 부작용을 담지 않는다" | **유지.** S1의 합성 함수를 store 액션이 아니라 orchestration 지점에 둔다 |
| `useBoardingLockController.ts:454-455` "hydrateLockFromCandidate는 의도적으로 건드리지 않는다" | **유지.** 스코프 밖(아래) |
| `useStateRehydration.ts:266` "destination 존재 여부를 별도로 재확인할 필요 없음" | **깨뜨린다.** 아래 "거짓이 된 load-bearing 주석" |

## 거짓이 된 load-bearing 주석

`useStateRehydration.ts:264-266`:
> "pausedAt은 trip 종료 전체 경로(TRIP_BOUND_CLEANUPS)에서 항상 함께 제거되므로, 이 값이
> 남아있다는 것 자체가 아직 어떤 종료 경로도 거치지 않은 활성 일시정지를 의미한다 —
> destination 존재 여부를 별도로 재확인할 필요 없음"

이 추론은 "재개 경로도 전부 지운다"를 암묵 전제한다. 2/3이 안 지우므로 전제가 거짓이고,
backstop은 재개된 활성 trip을 "일시정지 15분 경과"로 오판한다.

`useNavigationStore.ts:58-60` 주석도 같은 거짓 전제를 적고 있다:
> "HomeScreen이 handleStopNavigation/handleStartNavigation에서 두 채널을 같은 호출 지점에 wire"

## 스코프 밖(명시)

- 종료 경로는 전부 `runTripBoundCleanups` → `clearNavigationPauseState`를 거친다. 종료 경로
  누락은 본 plan의 원인이 아니다.
- `hydrateLockFromCandidate`(무탭 auto-lock)는 `startNavigation()`을 부르지 않는다(#1973 원칙) —
  대상 아님.

## fix 안

### S1 (근본) — 재개 chokepoint 단일화

호출부마다 storage clear를 기억해야 하는 구조 자체를 제거한다. `tripBoundCleanups.ts:223`의
`clearNavigationPauseState`(memory+storage 동시 clear)와 동형인 "재개" 단일 함수를 만들고,
`startNavigation()` 직접 호출 3곳을 모두 그것으로 교체한다. 두 곳에 `clearNavigationPausedAt()`
한 줄씩 추가하는 방식은 다음 호출부에서 같은 사고를 반복하므로 채택하지 않는다.

배치 위치 제약: `useNavigationStore`(route feature, 휘발성 의도)는 cross-feature AsyncStorage
부작용을 담지 않는다고 주석에 선언돼 있으므로, 합성 함수는 store 액션이 아니라 orchestration
지점에 둔다.

**S1이 덮지 않는 셀**: 교차 축 표 4행("재개 안 함 + 콜드 재시작")은 S1으로 해소되지 않는다 —
stamp는 그 trip의 진짜 일시정지이고, 문제는 **예고 표면이 FG 배지뿐**이라는 것이다. 이 셀은
#2997 S4-c(잠금화면 LA에 상주 표시 + 종료 제안)의 소관이며, 본 plan은 그 사실만 기록하고
건드리지 않는다. 겹쳐 고치면 같은 표면을 두 PR이 각자 설계한다.

### ~~S2~~ — 삭제. 자동 종료 분기 자체가 폐기 예정이다 (검증 반증 ①)

v1의 S2("backstop에 trip 신원 확인을 넣어 종료한다")는 **유지되지 않을 코드에 게이트를 더하는
안**이었다. 아래 충돌 선언 참조. 신원 확인이 필요한 판정은 #2997 S4-c의 "종료 제안" 쪽으로
이전된다 — 본 plan은 stamp 자체를 신뢰 가능하게 만드는 데까지만 책임진다.

단 S1이 들어가도 주석 불변식(`useStateRehydration.ts:264-266`)은 여전히 **강제되지 않는다**.
그래서 S1의 테스트는 "두 채널이 같은 호출로만 변한다"를 assert한다(아래 acceptance 1·2) —
주석만 남기고 지나가지 않는다(`feedback_comment_invariant_must_be_enforced`).

## 이 plan이 수정·대체·모순하는 결정 (선언 필수, ADR-014 §6)

| 결정 | 무엇이 바뀌는가 |
| --- | --- |
| **#2997 plan v2 S4-c** (`tasks/plan-2026-10-15-prompt-la-decoupling.md:135`, 사용자 승인 완료 2026-10-15) — *"15분 경과 + 이동 없음이면 LA 배너로 '종료할까요?'. **자동 종료하지 않는다 — 사용자가 결정한다**"* | **별개 채널이다 — v2의 "S1은 S4-c의 선결 조건" 주장은 반증됐다.** S4-c의 발사 판정은 **backend 절반**(같은 파일 `:251` "S4-c backend 절반(alert 발사 조건) ✅ backend vitest")이고 backend `Trip`에는 pause 필드가 0건(`:77-79`)이라 device의 `NAVIGATION_PAUSED_AT_KEY`를 읽지 않는다(그 키의 reader는 `useStateRehydration.ts:275` 단 1곳). S1의 정당성은 **현행 backstop이 지금 활성 trip을 DELETE한다**는 사실 하나로 충분하며 S4-c와 엮지 않는다. 단 **S4-c 착수자는 device backstop 제거/무력화를 자기 스코프에 포함해야 한다** — 그러지 않으면 device가 먼저 자동 종료해 S4-c의 "자동 종료하지 않는다"가 성립하지 않는다. **v1의 S2는 S4-c와 정면 충돌**이라 삭제했다 |
| **#2293**(CLOSED) — 15분 경과 즉시 자동 종료 | 본 plan은 이 동작을 **바꾸지 않는다**(acceptance 4가 보존을 assert). 자동→사용자결정 전환은 #2997 S4-c 소관 |
| `HomeScreen.tsx:496` — *"`infoModeEnabled`는 pause와 무관하게 절대 건드리지 않는다"* | **유지.** S1은 pause stamp 채널만 다루고 매역 push 정책을 건드리지 않는다 |

## 스코프 밖 (추가)

- **S2가 쓰려던 trip 신원 신호**: `TRIP_STARTED_AT_KEY`는 `tripBoundCleanups.ts:112`가 제거하므로
  신원 판정 키로 쓸 수 없다(레이스를 레이스로 고치는 구조). S2 삭제로 함께 해소.

## acceptance

1. test-first: 재개 2경로(prompt [탑승] / 열차 직접 탭) 각각에 대해 "일시정지 stamp가 storage에
   남아 있으면 red"인 테스트. 현재 red 재현 → fix 후 green.
2. revert-red: S1을 되돌리면 위 테스트 2건이 실패하는 것을 눈으로 확인한다. 카운트 기반 assert를
   쓰지 않고 storage 키의 최종 값으로 assert한다.
3. backstop 축: pausedAt stamp + 재개 후 15분 경과 시나리오에서 `DELETE /trips`가 발행되지 않는다.
4. 기존 동작 **불변 확인만** — S1 전후로 "재개 없는 진짜 일시정지"의 거동이 **달라지지 않는다**를
   assert한다. ⚠️ v2의 "15분 경과 시 자동 종료된다(#2293 유지)"를 acceptance로 박는 것은
   **금지**다(재검증 반증 ②): S4-c가 그 자동 종료를 없애는 것이 사용자 승인된 설계이므로,
   테스트로 못 박으면 S4-c 착수자가 **내 테스트를 깨야** 진행하게 되고 그것이 "스펙에 박아둔
   게이트"가 된다(`feedback_given_axis_is_not_whole`). 따라서 이 항목은 S1의 **회귀 가드**이고
   자동 종료 정책의 **존속을 주장하지 않는다**.
5. 콜드 셀: 일시정지 → 앱 재시작 → 재개 2경로 각각에서 storage stamp가 비는 것을 assert한다.
   memory 채널은 재시작으로 null이므로 **storage 키의 최종 값만** assert한다 — memory를 같이
   세면 재시작이 이미 null로 만들어 "틀린 이유로 green"이 된다(카운트/상태 합산 금지, 검사 #10).
