# plan 2026-10-15 — trip 종료 시퀀스가 7변종으로 복제돼 있다 (정본은 이미 있고 3곳만 쓴다)

> **선행 의존**: PR #3002(`reason` 필수 인자)가 **먼저 머지돼야 한다** — 같은 함수
> (`runTripBoundCleanups`)와 같은 9개 호출부를 건드린다. 이 plan은 #3002 머지 후 착수.

## 문제

정본이 이미 있다. `tripEndedCleanupSequence.ts:57 runFullTripEndCleanupSequence`, 주석에 명시:

> "`cleanupBackendConfirmedEndedTrip` / `cleanupUserInitiatedEndedTrip` 양쪽이 공유하는
> **단일 구현 — drift 방지를 위해 여기 외에는 재구현하지 않는다**"

**채택은 3곳**(`tripDeathPullBackstop.ts:135`, `useLaunchTripReconciliation.ts:216`,
`useAlarmEndTripResponder`)이고 **6곳이 손으로 베껴 썼다**.

| 호출부 | recall | corrId | cleanups | prompt | memory reset | releaseLock | sentinel |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **정본** `:57` | O | O | O | O | O | ✗(`trip-cleanup` 위임) | O |
| `useStateRehydration:127` 센티넬 | ✗ | O | O | O | O | `sentinel-rehydration` | (clear) |
| `useStateRehydration:242` 9h | ✗ | O | O | O | O | `lifecycle-9h-force-end` | O |
| `useStateRehydration:288` pause | ✗ | O | O | O | O | `navigation-pause-auto-end` | O ← #2425로 **사후 추가** |
| `useLaunchTripReconciliation:170` Signal-4 | O | O | O | O | O | ✗ | O |
| `useDeviceSelfEnd:220` | O | O | O | O | O | `REASON_TO_ALARM_LOG_REASON[reason]` | O |
| `silentPushTask:1212` | O | O | O | O | **FG일 때만** | ✗ | O |
| `useApnsTripRegistration:1220` 안전망 | ✗ | ✗ | O | ✗ | ✗ | ✗ | ✗ |

읽을 포인트 셋:

1. **`useLaunchTripReconciliation`은 같은 파일에서 두 분기가 갈린다** — `:216`은 정본을 쓰고
   `:170`은 베껴 썼다. 파일 안에서도 수렴이 안 됐다.
2. **drift가 이미 실현됐다** — pause 분기의 sentinel 누락이 **#2425로 사후 수선**됐다. 정본을
   쓰면 원리적으로 불가능한 결함이었다.
3. **`useApnsTripRegistration:1220`은 8단 중 1단만** 수행한다 — backend DELETE는 나가는데
   recall·prompt·sentinel·memory reset이 전부 없다. 2026-10-15 "생성 6초 후 DELETE"의 1순위
   용의자가 가장 얄팍한 경로다.

## 수렴 **불가** 3곳 (중요 — 전부 수렴은 틀렸다)

| 경로 | 왜 정본을 쓸 수 없나 |
| --- | --- |
| `useDestinationStore.ts:197` | **목적지 전환**(station≠null) 경로다. 정본은 `destination: null` + `setTripEndedSentinel`을 하므로 수렴하면 **방금 설정한 새 목적지를 지우고 trip-ended 센티넬을 남긴다** → 새 trip 즉사 |
| `silentPushTask.ts:1212` | BG는 `AppState.currentState === 'active'`일 때만 `setState`한다(`:1227`, #2018 γ′ *"BG 상태에서는 zustand runtime 접근이 불확실"*). 정본(`tripEndedCleanupSequence.ts:70`)은 **무조건 setState** → 의도된 BG 가드를 깨뜨린다 |
| `useStateRehydration.ts:127` | 이 분기는 센티넬을 **소비**해 `clearTripEndedSentinel()`(`:138`)로 끝난다. 정본은 센티넬을 **set**한다 → 정반대 |

→ **수렴 대상 4곳**: `useStateRehydration:242`(9h) · `:288`(pause) ·
`useLaunchTripReconciliation:170`(Signal-4) · `useDeviceSelfEnd:220`.
이 4곳은 정본과 단계가 동일하고 차이는 `releaseLock(reason)` 하나뿐이다 — #3002로 정본이 이미
`reason`을 받게 되므로 그 인자로 흡수된다.

## 과장하지 않을 것 (재검증에서 걸러낸 것)

`useStateRehydration` 3분기의 `triggerTripEndRecall` 누락을 "KPI 상실"로 단정하면 안 된다.
recall은 `ROUTE_KEY`/`DESTINATION_KEY`/`TRIP_STARTED_AT_KEY`를 읽어야 동작하는데
(`triggerTripEndRecall.ts:15`), **센티넬 분기는 이미 BG cleanup이 끝난 뒤** 도달하므로 그 키들이
비어 있고 recall은 `'empty'`로 skip된다 — 설계상 생략이 맞을 수 있다. 9h/pause 분기는 cleanup
**전**이라 유효할 가능성이 있으나 **확인 안 했다** → `추정`. 착수 시 그 3분기 각각에 대해
"recall 입력이 존재하는가"를 먼저 판정한다.

## 설계

1. 정본 `runFullTripEndCleanupSequence`의 `reason` 타입을 `SequenceTripEndReason`(2종)에서
   **`TripEndReason` 전체**로 확장(#3002가 만든 공용 어휘).
2. 정본에 `releaseLock(reason)`을 추가 — 현재는 `clearTripBoundStoreMemory`의
   `'trip-cleanup'`에 위임해 **동일 사건이 경로별 5가지 사유로 기록**되는 상태다.
3. 4곳을 정본 호출로 교체. 교체 후 각 경로의 alarmLog/breadcrumb은 **그대로 유지**(관측 호환).
4. 불가 3곳은 "왜 불가한가"를 **주석이 아니라 테스트로 고정** — 정본을 쓰면 깨지는 것을 assert
   (`feedback_comment_invariant_must_be_enforced`: 주석 속 불변식은 없는 것과 같다).

## acceptance

1. test-first: 4곳 각각 정본 호출로 바뀌었을 때 8단이 전부 실행되는지(단계별 분리 assert).
2. **revert-red**: 정본 교체를 되돌리면 각 테스트가 실패하는 것을 눈으로 확인.
3. 불가 3곳 가드 테스트 3건: 목적지 전환이 새 destination을 보존 / BG에서 setState 미호출 /
   센티넬 소비 분기가 센티넬을 set하지 않음.
4. #2425 회귀 가드: pause 분기가 sentinel을 set한다(정본 경유로 자동 보장).
5. 기존 테스트 전부 green — 관측 신호(alarmLog reason, breadcrumb) 불변.

## 범위 밖
- `reason` 배선 자체는 #3002.
- pause 자동 종료 정책 변경은 #2997 S4-c.
