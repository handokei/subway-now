# plan — backend LA push 발사 축을 replay로 고정

## 1. 문제

LA 이슈가 반복된다: #2667(push 24h 0건) → #2806(update→start fall-through) → #2828(START가 FG에서만) → #2805(약 0분 ETA) → #2854(임박 무반응) → #2962(trainCode 부재) → 그리고 **#2667 증상 재발**(2026-10-13 `laPushDelivery=0% (0/0)`).

반복의 구조적 원인 중 **테스트 가능한 층이 비어 있다**:

```
device JS  → native Swift(ActivityKit) → APNs → ActivityKit 렌더
   ↑ 테스트 있음        ↑ 테스트 0개(Swift 14파일, *Tests.swift 전무)
   backend → APNs LA push  ← 이 축이 replay에서 한 번도 assert되지 않는다
```

측정(확인됨): 9/18 lock-seeded replay를 돌려 push를 타입별로 집계하면
```
PUSH TYPES: {"background":3,"alert":5}
```
**`liveactivity` 0건**이다. seed trip에 `activityPushToken`이 없기 때문이고(`helpers/ride20260918Trip.ts`에 해당 필드 없음), harness는 `apns-push-type`을 `pushType`으로 캡처하므로(`replayHarness.ts:205`) **토큰이 있으면 캡처된다**.

## 2. 고정할 계약

`fireLiveActivityUpdate`는 `liveActivity.ts:249`에서 다음으로 no-op한다:
```ts
if (!trip.activityPushToken || trip.activityState !== 'live') return { dirty: false };
```

> 🔴 **정정(verify-plan 검사 #8 반증)**: 최초 계약 문구는 *"토큰이 있고 `live`면 LA push를
> 시도한다"* 였다. **틀렸다.** 게이트가 4곳에 중복돼 있고 경로에 따라 **threshold가 더 걸린다**:
> ```
> scheduled.ts:2114   토큰+live 체크 → maybeFireLiveActivityUpdate  (heartbeat 경로)
> scheduled.ts:6299   토큰+live 체크 → fireLiveActivityUpdate       (waypoint advance 경로)
> liveActivity.ts:249 / :336   fire 본체의 동일 게이트
> ```
> `maybeFireLiveActivityUpdate`는 추가로 — `lastLaPushAt` 30s 내면 **전부 차단**, 그 밖이면
> ΔETA ≥ `LA_PUSH_THRESHOLD_MS`(30s) **또는** heartbeat ≥ `LA_HEARTBEAT_INTERVAL_MS`(90s)일
> 때만 발사(`scheduled.ts:6353/6379/6382`). 즉 **토큰을 심어도 threshold 미달이면 0건**이고,
> 그걸 "게이트가 작동한다"로 오독할 수 있었다(L28 — 0건을 한쪽으로만 읽기).

→ **정정된 계약 (경로별로 다르다)**:

| 경로 | 조건 | threshold |
| --- | --- | --- |
| **waypoint advance** (`scheduled.ts:6299` → `fireLiveActivityUpdate`) | 토큰 + `live` | **없음** — advance마다 즉시 발사 |
| heartbeat (`scheduled.ts:2114` → `maybeFireLiveActivityUpdate`) | 토큰 + `live` + (ΔETA≥30s ∨ heartbeat≥90s) | 있음 |

→ **고정 대상은 advance 경로다.** 9/18 replay는 어린이대공원/군자/중곡 **3역 advance**가 이미 확인돼 있으므로(`replay_20260918_lock_seeded_contrast.test.ts`), 토큰을 심으면 `liveactivity` push가 **≥1건**(실제로는 advance 횟수만큼) 나와야 한다. heartbeat 경로는 threshold 축이 섞여 단독 assert가 불안정하므로 **범위 밖**으로 둔다.

이 계약은 **실측 데이터 없이 지금 고정 가능**하다 — #2977 계측 결과가 필요한 것은 *"프로덕션에서 왜 토큰이 없었나"* 이고, 이 계약은 *"토큰이 있으면 쏘는가"* 다. 둘은 다른 질문이다.

## 3. 축 교차 (검사 #3)

주어진 축은 "LA push가 나가는가" 1개다. 최초 plan은 교차 축을 **(상태) × (경로)** 2차원으로 잡았는데, **검사 #8 반증으로 `threshold` 축이 빠진 것이 드러났다.**

정정된 축 = (토큰) × (state) × **(threshold)**:

| 토큰 | state | threshold | 기대 | 이번 범위 |
| --- | --- | --- | --- | --- |
| 있음 | `live` | advance(무조건) | `liveactivity` ≥ 1 | ✅ **고정** |
| 없음 | — | — | 0건 | ✅ **거부 ①** |
| 있음 | `ended` | — | 0건 | ✅ **거부 ②** |
| 있음 | `live` | heartbeat 미달 | 0건 | ⬜ 범위 밖(threshold 단독 축) |

셀 4개(+범위 밖 1) > 주어진 축 1개. ✓

**경로 분리 assert는 범위 밖** — `fireLiveActivityUpdate` 호출부 3곳(`scheduled.ts:6311/6392/7975`) 중 어느 것이 쐈는지 구별하려면 호출부별 계측이 필요하다(별건). 이번엔 "advance가 일어나는 replay에서 LA push가 나간다"까지만 고정한다.

## 4. 미커버 선언 grep (검사 #4)

건드릴 파일: `src/__tests__/helpers/ride20260918Trip.ts`(신규 helper 추가), 신규 테스트 파일. **프로덕션 코드 변경 0.**

```
grep -nE "100% 무변경|무변경|건드리지 않|게이트가 없|범위 밖|다루지 않|이 분기는" \
  src/liveActivity.ts src/__tests__/helpers/ride20260918Trip.ts
→ hit 0건
```
판정 불필요 — 두 파일에 미커버 선언이 없다.

## 5. 전제 검증 (검사 #6)

| 전제 | 확인 방법 | 상태 |
| --- | --- | --- |
| harness가 LA push를 캡처한다 | `replayHarness.ts:205` `pushType: extractHeader(..., 'apns-push-type')` + `apns.test.ts:1122` `apns-push-type === 'liveactivity'` | **확인** |
| 현재 replay에 LA push 0건 | 직접 측정 `{"background":3,"alert":5}` | **확인** |
| seed trip에 토큰 없음 | `ride20260918Trip.ts`에 `activityPushToken` 0건 | **확인** |
| `activityState` 타입에 `'live'`/`'ended'`가 있다 | `types.ts:147` `activityState?: 'live' \| 'ended'` | **확인** (2값뿐 — 다른 상태 없음) |
| 재생의 가짜 APNs가 410을 안 준다(= 토큰이 지워지지 않는다) | `replayHarness.ts:210` `new Response('', { status: 200 })` | **확인** — 항상 200이라 `liveActivity.ts:290` 토큰 clear 분기에 도달하지 않는다 |
| seed trip에 `lastLaPush*`가 없다(= 첫 push가 threshold를 통과) | `ride20260918Trip.ts`에 `lastLaPush` 0건 | **확인** |
| `liveactivity`가 실제 발사 헤더다 | `apns.ts:825` `'apns-push-type': 'liveactivity'` | **확인** |

## 6. 작업

1. `helpers/ride20260918Trip.ts`에 `makeRide20260918LaActiveTrip(token)` 추가 — lock-seeded 변형 + `activityPushToken` + `activityState: 'live'`.
2. 신규 `replay_20260918_la_push_axis.test.ts`:
   - **고정**: LA active trip → `pushType === 'liveactivity'` ≥ 1
   - **거부 ①**: 토큰 없음(기존 `makeRide20260918LockSeededTrip`) → `liveactivity` **0건**
   - **거부 ②**: 토큰 있음 + `activityState: 'ended'` → `liveactivity` **0건**
   - **교차 고정**: 같은 재생에서 `alert` 3역 발사(기존 대조군 기대값)가 **무변경**이어야 한다 —
     LA push가 추가돼 기존 채널을 밀어내지 않는다는 증거(#2600 채널 분리 계약).

## 7. acceptance — revert-red (검사 #10)

`liveActivity.ts:249`의 가드를 `return { dirty: false }` 무조건으로 바꾸면(= LA push 경로를 죽이면) **고정 테스트가 실패**해야 한다. 그 출력을 PR 본문에 첨부한다.

거부 케이스 2종은 revert 전후 모두 green이어야 한다(과잉 차단 방지).

## 8. 기존 이슈 대조 (검사 #7)

검색 핵심어: `laPushDelivery` / `activityPushToken` / `LA push 0` / `live-activity register`.
- **#2667**(CLOSED) — 이 증상을 고쳤고 재발. 이 plan은 fix가 아니라 **게이트**다(충돌 없음).
- **#2732**(OPEN, acceptance) — "LA가 BG/종료에서도 역마다 갱신". 이 게이트가 그 판정의 하위 전제.
- **#2596**(OPEN, Epic) — LA backend 권위 일원화.
- **#2977**(OPEN) — 등록 경로 계측. 짝이지만 **의존 아님**(이 plan은 토큰을 직접 심는다).

## 9. 기존 결정 충돌 (검사 #9)

- `decision_ARCHITECTURE_COMMITTED_server_track_visible_push` — "backend 추적 → LA 표시". 이 plan은 그 방향을 **강화**한다(충돌 없음).
- `decision_notification_priority_3tier` — LA/ambient는 "상태줄만". 발사 **횟수 정책을 바꾸지 않는다**(게이트만).

## 9-B. verify-plan 검증 이력

1차 검증(검사 10종, 메인 직접 수행 — 위임 에이전트가 결과 미전달):
- **반증 1건** [검사 #8] — 계약 문구가 threshold를 빼먹음. §2·§3 정정으로 반영.
- **미확인 1건** [검사 #5] — 가짜 APNs status 미확인 → `replayHarness.ts:210` 200 확인으로 해소.
- 확인: #1(배선), #3(축 — 반증 반영 후 4셀), #4(hit 0건), #6(4전제 전부).

## 10. 범위 밖

- Swift 층(ActivityKit decode·렌더) — 테스트 타깃 자체가 없다. 별도 결정.
- 경로별(heartbeat vs waypoint advance) 분리 assert — 호출부 계측 필요.
- LA 발사 **빈도**(30s/90s) 검증 — 이 plan은 "시도하는가" 1차원만.
- `laPushDelivery` 지표 변경 — 정상 작동한다(#2977에서 분기 전수 확인).
