# plan — 앱 실행만으로 유령 트립이 재등록되는 레이스

증거: `~/Downloads/텍스트-DF4BA273BDDE-1.txt`(20:37), `~/Downloads/텍스트-DA0AD59A290E-1.txt`(20:53), D1 `trip_events`.
사용자 체감: *"방금 1~2분전에 내가 앱을 열고나서 아무것도 한게 없는데, trip생성 안함 하지만 뚝섬에서 하차했나요 여러번 발사 안내종료 알림 여려번 발사했어"*

## 1. 확정된 사실 (전부 file:line / D1)

### 1-1. 사용자 조작 0회로 트립이 **맨땅에서** 생성됐다

> 🔴 **정정(2026-10-13)**: 이 절의 최초 서술은 *"DELETE가 먼저 응답하고 POST가 나중에 착지"*
> 였고 `404`에 "삭제 확인"이라 주석했다. **둘 다 틀렸다.** 같은 관측을 반대로 읽었다 —
> 반증 수단이 내 인용 안에 이미 있었는데 서사에 맞춰 해석했다(L28).

첫 덤프 Backend Calls를 callId로 짝지으면:

```
20:36:53 CALL  DELETE /trips/{token}      mv6lvrum1
20:36:53 CALL  POST   /trips              mv6lvrup3
20:36:54 CALL  POST   /trips              mv6lvs4e6
20:36:54 RESP  DELETE /trips        → 200     ← 존재 여부를 말해주지 않는다(아래)
20:36:54 RESP  GET    /status       → 404
20:36:56 RESP  POST   /trips        → 200  ×2  ← 여기서 트립이 생긴다 (2.3~2.4s 지연)
```

**`200`은 증거가 아니다.** `index.ts:3777` — `if (!existing) return c.json({ ok: true, deleted: false })`.
DELETE는 **부재 시에도 idempotent 200**이다.

판별은 D1에 있다. `deleted:true` 분기만 `cleanupTripWithLa(… endPath:'http-delete')`로 trip-end를 기록한다:

| | D1 trip-end | 판정 |
| --- | --- | --- |
| 20:36:54 DELETE | **없음** | `deleted:false` → **그 시점 트립이 없었다** |
| 20:53:38 DELETE | `{reason:"user-delete", endPath:"http-delete"}` | `deleted:true` → 있었다 |

→ 오전 트립은 **06:47:00 `destination-arrived`로 이미 사라져 있었고**, 20:36:56의 POST 2건이
**없는 상태에서 새로 만들었다**. 레이스(삭제-후-착지)가 아니라 **무조건 생성**이다. 이 정정이
§4-D(B·A 계열 폐기)의 근거이기도 하다.

16분 30초 뒤 두 번째 실행에서 그 유령이 드러난다:

```
20:53:36  GET /trips/{token}/status → 200        ← 살아있다
20:53:35  boarding-prompt | fired | 2·뚝섬  ×5    ← 오전 06:47에 끝난 트립의 목적지
20:53:37  D1 trip-end {"reason":"user-delete","endPath":"http-delete"}
```

D1은 **06:47:04 이후 20:53:37까지 이벤트 0건** — backend cron은 이 유령을 한 번도 처리하지 않았다.

### 1-2. ROOT — `#2673`이 clear 방향만 고친 편측 fix

`src/features/alarm/hooks/useApnsTripRegistration.ts:1152`

```
clear 분기   (!route || !destination → DELETE)  : storage(DESTINATION_KEY) 가드 있음  ← #2673
register 분기 (route && destination → POST)     : 가드 없음
```

같은 훅 `:1157` 주석이 자백한다 — *"**이 훅에는 hydration 게이트가 없어서**, 앱이 mount되거나 FG로 복귀하는 매 순간 `useStateRehydration`의 `loadDestination()`이 끝나기 전까지 store의 destination/route는 null이다."*

`#2673`은 그 "null 찰나"가 **DELETE를 유발**하는 것만 막았다(판정을 메모리 store → storage로 이동). 반대 방향, 즉 **hydration이 stale destination을 복원해 POST를 유발**하는 경로는 그대로 열려 있다. `/audit-sides` **방향(생성↔소멸)** 축 편측.

### 1-3. 선행 조건 — 트립이 14시간 살아 있었다

`src/shared/hooks/useStateRehydration.ts:188 runLifecycleBackstop`은 `phase === 'force-end'`(9h+)에서만 종료한다. 오전 트립 `tripStartedAt = 06:23` → 20:36 시점 **14h13m** → force-end 조건 충족. 그래서 20:36:53에 `lifecycle-backstop | fired | trip-lifecycle-force-ended`가 찍혔다.

즉 **종료 판정은 올바르게 났다.** 문제는 그 판정이 `destination: null` setState로 **비동기** 진행되는 동안, 같은 틱의 hydration이 복원한 destination을 보고 register effect가 먼저 POST를 쐈다는 것이다.

`runTripBoundCleanups`는 `DESTINATION_KEY`를 지운다(`tripBoundCleanups.ts:89`). 정상 종료된 트립은 hydration 대상이 애초에 없다 — 이 사고는 **오전 트립이 device에서 정상 종료되지 않았기 때문에** 14시간 뒤 복원 가능한 상태로 남아 있었다(그 자체는 오전 RCA의 별건).

### 1-4. 2중 실행 — POST가 2회인 이유

`useStateRehydration.ts:60` `runRehydration('mount')` + `:67` `runRehydration('active')`. 앱 실행 시 **둘 다** 발사된다. 그래서 hydration 전체 사이클·category 등록·POST가 모두 2배다. 미스터리가 아니라 설계된 2중 트리거.

### 1-5. 재발이다

`useApnsTripRegistration.ts:90` — *"그대로 **POST /trips 폭주**로 이어졌다(RCA 9/21 '원인 확정' 코멘트)"*. 같은 훅에서 같은 종류의 사고가 이미 한 번 있었다.

## 2. 미확정 (정직)

**배너 전달 경로.** 5건은 `useBoardingPromptDisplayLogger.ts:209 tryLogDisplayed`가 쓴 것이고, 이 함수는 **FG 수신 리스너**와 **트레이 읽기**(`drainPresentedBoardingPrompts`) 양쪽에서 호출된다 — 둘 다 **세는 경로이고 발사 경로가 아니다**. 따라서 확정되는 것은 "프롬프트 알림 5건이 트레이에 있었고, `#2677` identifier dedup(영속)이 **이전에 센 적 없다고 판정**했다"까지다.

언제 생성됐는지는 이 증거로 못 가린다:
- backend cron 아님 (§1-1, D1 0건)
- 앱도 20:37:08~20:53:35 동안 죽어 있었다(alarm log 공백)
- 로컬 예약 알림도 `Scheduled queue (0)`

**→ 프롬프트/알림 발사 시점 계측 구멍이다. 이걸 메우지 않으면 이 fix의 완결성을 증명할 수 없다.** 작업 ①로 선행한다.

## 3. 분리되는 결함 3개

| | 결함 | 성격 |
| --- | --- | --- |
| **D1** | register 분기에 hydration/backstop 가드 부재 | 편측 fix 보수 — 결정 불필요 |
| **D2** | teardown↔register 레이스 자체(POST가 DELETE 뒤 착지) | **결정 필요** — §4 |
| **D3** | mount+active 2중 실행으로 POST 2회 | 부수 — D1 fix 후에도 남음 |

## 4. D2 결정 옵션 (4안)

| | 안 | 어떻게 | 보장 | 비용 / 위험 |
| --- | --- | --- | --- | --- |
| **A** | device 직렬화 | teardown 시작 시 generation counter를 올리고, in-flight register가 착지 전에 generation 불일치면 폐기 | 레이스 창을 좁힘, **0은 아님** | 작다. 단 2중 인스턴스·BG 채널(silent push 경로)까지 못 덮는다 |
| **B** | backend tombstone | trip-end 시 token별 `endedAt`을 KV에 기록, `POST /trips`가 `createdAt <= endedAt`이면 거부 | **device 레이스와 무관하게 0 보장** | KV 키 1개(trip-end는 하루 몇 건 → quota 무해, `lesson_cf_free_quota_cron_kv_burn` 기준 통과). TTL 설계 필요. 정당한 즉시 재시작을 거부하지 않도록 `createdAt` 비교 정확성이 관건 |
| **C** | 생성 권한 축소 | register를 **사용자 명시 행위**(목적지 설정 / 프롬프트 응답 / 직접 탭)에만 허용. hydration은 복원·조회만 하고 **절대 register하지 않는다** | 근본적. `decision_ARCHITECTURE_COMMITTED`(device=탭만) 패러다임과 정합 | 범위 크다. FG 복귀 시 **정당한** 재등록(APNs 토큰 갱신·route 변경·Tier2 heal)을 별 경로로 보존해야 하고, 그 경로가 이 훅에 5개 이상 흩어져 있다 — 회귀 위험 높음 |
| **D** | 임계값 재검토 | `force-end` 9h 임계 자체가 이 사고의 선행 조건이다. "목적지 도착 후 N분" 같은 더 이른 종료 축을 추가 | 유령 수명 단축 | **단독으로는 레이스를 못 막는다** — A 또는 B와 조합해야 의미 있음 |

**권고: B + A.** B가 불변식을 만들고(backend에서 물리적으로 불가능해짐), A가 device에서 불필요한 네트워크 왕복을 줄인다. C는 패러다임상 옳은 방향이지만 **이 PR에서 하면 안 된다** — 정당한 재등록 경로 5개를 한 PR에서 재배선하는 것은 §1-5의 폭주 사고를 반복할 위험이 크다. D는 별건 후속(ADR 필요 — 종료 권한 축 변경).

## 4-B. 스펙 단계 선행 체크 결과 (L27 / `/audit-sides` 신규 절)

### ① 축 교차 — 이 체크가 plan의 결함을 잡았다

증거가 준 축은 "앱 실행 시 register"였다. 교차 축 = **register 진입점**. 전수하면:

| register 진입점 (`registerFromLatestInputs` 호출부) | §5-② 초안이 덮는가 |
| --- | --- |
| `:1129` main effect (mount / AppState active) | ✅ |
| `:926` pushTokenListener 재등록 | ❌ |
| `:1065` Tier 2 fallback override | ❌ |
| `:1321` register-retry (#1960) | ❌ |
| `:1539` Tier 2 heal | ❌ |

**초안대로 "register 분기에 가드"를 넣으면 5개 중 1개만 막는다 — 내가 방금 사과한 것과 정확히 같은 편측이다.**

→ **수정: 게이트를 단일 chokepoint `registerFromLatestInputs`(`:747`) 내부에 둔다.** 5개 진입점이 전부 이 함수를 지나므로 구조적으로 전수 커버된다. 호출부 5곳을 각각 고치지 않는다(사본 금지, L21).

자가 점검 통과: 셀 5개 > 주어진 축의 항목 1개. ✓

### ② 미커버 선언 grep 3값 판정

`grep -nE "100% 무변경|무변경|건드리지 않|게이트가 없|범위 밖|다루지 않|이 분기는"` → 11건.

| file:line | 선언 | 판정 |
| --- | --- | --- |
| `useApnsTripRegistration.ts:1157` | *"이 훅에는 hydration 게이트가 없어서"* | **깨뜨림** — 이 fix가 그 게이트를 만든다(이번 사고의 root) |
| `useApnsTripRegistration.ts:1169` | *"이 분기는 … 안전망이 storage까지 비어 있을 때만 동작하도록 좁히는 것"* | **상속** — **정당성**: clear 분기 축소(#2673)는 유지한다. 신규 register 게이트와 조합하면 stale trip 실행 시 register 차단 + clear 차단(DESTINATION_KEY 존재) → **둘 다 안 돌고 백스톱이 정리**한다. 이게 의도된 단일 소유권이다 |
| `tripBoundCleanups.ts:188-199` | pause·비버튼 종료 경로가 `navigationActive`/pause state를 건드리지 않던 문제 | **유지** — `clearNavigationPauseState`·`resetNavigationActive`가 cleanup 배열에 있어 **force-end·pause-auto-end 포함 전 경로 자동 wire**. 백스톱 정리는 완전하다(이 fix와 무관) |
| `:396 :1015 :1221 :1234 :1468 :1552`, `tripBoundCleanups.ts:378` | subsurface quarantine · session/attempt 회계 · 순서 주석 | **유지** — 이 fix의 blast radius 밖 |

## 4-C. 재검증에서 정정된 것 4건 (사용자 "확실해?" ×2)

### 정정 1 — "진입점 5개"가 아니라 "트리거 5개 · 발사 1곳"

전 체인을 끝까지 추적했고 각 단계 호출부가 **정확히 1곳**이다:

```
5 트리거 → registerFromLatestInputs(:747) → callRegister(:261, 호출 :800)
        → registerActiveTrip(:512, 호출 :312) → performRegisterFetch(:394, 호출 :556)
        → POST /trips (:439)
```

backend도 생성 라우트는 `app.post('/trips')`(`:793`) **하나**뿐 — 나머지 `/trips` 라우트 3개(boarding-confirm·status·delete)는 `getTrip` 부재 시 404로 끊는다. `createdAt`을 backend가 직접 만드는 곳은 0건(payload에서 온다).

→ 게이트는 **1곳이면 전수 커버**. §4-B① 표의 "5개 중 1개만 막는다"는 과잉 프레이밍이었다(결론은 동일).

### 정정 2 — D3(2중 POST)는 별개 결함이 아니라 ②에 흡수된다

`registerActiveTrip`에 hash dedup이 **두 겹** 있다 — `:544 lastRegisteredHash`, `:549 inFlightRegisters`(주석: *"POST /trips가 동시 발사되는 것을 차단"*). `inFlightRegisters.set`은 호출자의 await 전에 동기 실행되므로 **같은 hash 2회는 네트워크에 못 나간다**.

그런데 두 POST가 실제로 나갔다 — `instrumentBackendFetch`(`:35`)가 **fetch 1회당 callId를 새로 발급**하고 `fetchWithTimeout`(`alarmBackend.ts:388`)이 그걸 감싸므로, callId 2개 = **fetch 2개** 확정. 지연 차(2428−2301=127ms)로 보아 두 호출은 ~127ms 간격이고 fetch 자체는 2.3s다 — hash가 같았다면 두 번째는 pending을 받았을 것이다.

→ **두 POST는 hash가 달랐다**(hydration 중 payload drift). 따라서 **R7("POST가 1회만 나간다")은 틀린 acceptance**다. 정확한 명제는 **"hydration 미완료 중 0회"**이고 ②가 그걸 보장한다. D3 삭제.

### 정정 3 — 옵션 B(`createdAt <= endedAt`)는 작동하지 않는다

`resolveTripCreatedAt`(`:622`)은 `useRef` 기반이라 **앱 재실행마다 `Date.now()`를 새로 찍는다**. `:813`이 그 값을 payload로 싣는다(`callRegister :330` → POST). 즉 되살아난 POST는 backend 관점에서 "오래된 트립"이 아니라 **createdAt이 방금인 신규 세션**(실측 20:36:53, DELETE 20:36:54와 1초 차). 게다가 파서(`:3972`)가 `createdAt` 부재 시 `Date.now()`로 폴백한다.

→ **B1(post-delete 디바운스)로 교체.** 같은 token에 DELETE 후 T초 내 POST를 **내용·시각 추론 없이** 거부하고 `Retry-After`를 반환한다. B2(routeSig 동일성)는 routeSig가 waypoint shift로 변하는 값이라(오전 RCA `route-signature-mismatch` 4건) 우회된다. B3(device 플래그)는 device가 판정 주체라 backend 불변식이 못 된다.
**미결**: T값(초안 90s)은 **근거 없는 추정**이다 — `trip_metrics`의 연속 trip `ended_at → 다음 started_at` 간격 분포로 정해야 한다(표본 적을 수 있음, 그때는 보수적으로 작게).

### 🔴 정정 4 — ②의 게이트 신호가 또 하나의 레이스였다 (가장 중요)

초안 ②는 *"force-end 대기 상태를 `getTripStartedAt()`로 판정해 register를 억제"*였다. **그게 틀렸다.**

`tripBoundCleanups.ts:112`가 **`TRIP_STARTED_AT_KEY`를 삭제**한다. 백스톱 순서는 `getTripStartedAt()` → force-end → `runTripBoundCleanups()`다. 그러므로:

```
cleanup이 먼저 돌면 → getTripStartedAt() === null → 게이트 열림 → POST → fix 무효
```

POST CALL(20:36:53)이 백스톱 로그(20:36:53)와 **같은 초**라 승부를 예측할 수 없다. **즉 초안은 레이스를 레이스로 고치려 했다.**

→ **게이트는 teardown이 지우는 키를 읽어선 안 된다. 양성 신호를 기다려야 한다.**
`useStateRehydration`이 **reconciliation 완료 플래그**를 노출하고, chokepoint가 그 플래그가 true가 될 때까지 억제한다. 백스톱 판정이 **끝난 뒤에야** register가 가능하므로 레이스 자체가 소멸한다.

이 모양은 발명이 아니라 **같은 파일의 기존 선례**다 — `:779 if (!poih) return`(`promptOptInHydrated`)이 정확히 그 구조이고, 그 주석이 *"#2673과 동일 클래스 race"*라고 적어놨다. 신규 게이트는 그 `if`의 형제다.

**필수 설계 제약**: 플래그는 rehydration이 **실패해도** 반드시 열려야 한다(`finally`). 안 그러면 register가 영구 차단돼 트립이 아예 등록되지 않는 전면 침묵이 된다 — §6 R9가 이걸 고정한다.

## 4-D. 🔴 정정 6 — B·A 계열 전체가 이 사고에 무효 (기존 이슈 검색으로 발견)

**`#2129`(2026-08-04, CLOSED)가 같은 사고를 이미 확정해뒀다** — *"device가 POST /trips 2건 동시 발사 … dedup 2-layer는 payload hash 기반이라 두 경로가 다른 payload를 빌드하면 우회됨"*. §4-C 정정2에서 내가 "추론으로 발견"한 내용이 8월 4일 이슈 본문에 그대로 있다. 유령 trip 잔존 + DELETE 미발사도 동일. **CLOSED 결함의 재발이다.**

**`#2912`(CLOSED)가 B 계열을 금지한다.** `#1425` 쿨다운이 **이미 존재**한다(`index.ts:953-971`, 보존 1h) — *"어떤 사유로든 트립이 끝난 뒤 같은 토큰으로 1시간 내 재등록하면 거부"*. 즉 B1(post-delete 디바운스)은 신규 설계가 아니라 **기존 기능**이고, #2912가 그게 정당한 복구를 봉쇄한 것을 확정해 좁은 예외만 남겼다(금지 항목: *"쿨다운 자체 제거/무조건 완화"*).

그런데 오늘 POST는 **200으로 통과**했다:

```
오전 트립 종료   06:47:00   (D1: trip-end destination-arrived)
유령 재등록      20:36:56   → 간격 13h49m ≫ 쿨다운 1h → 정당 통과
20:36:54 GET /status → 404  → 지울 트립이 애초에 없었다
```

→ §1-1의 "DELETE 응답 뒤 POST 착지" 프레이밍도 부정확하다. **실제는 13시간 전에 끝난 트립을 앱 실행이 맨땅에서 새로 만든 것**이다(DELETE는 부재 트립에 대한 no-op).

**결론: 90초 디바운스든 1시간 쿨다운이든 13시간 간격은 막지 못한다.** backend는 그 POST를 정당한 신규 트립과 **구별할 수 없다**(createdAt 방금 — §4-C 정정3, waypoints 유효, 쿨다운 만료). 따라서:

- **B(tombstone/디바운스) 폐기** — 이 사고에 무효. #2912가 금지한 방향으로 쿨다운을 강화하는 꼴이 된다.
- **A(device generation) 폐기** — teardown↔register 레이스가 이 사고의 기전이 아니다(지울 트립이 없었다).
- **② device 게이트만 남는다.** 작업이 1개로 수렴한다.

## 5. 작업 순서 (하나씩, 각 단계 verify)

```
① register 게이트 — chokepoint `:747`, **양성 flag 대기**(§4-C 정정4)
   → red 3 / green 3 확인됨(§6). 타입 에러 1건 = `launchReconciliationSettled` 누락.
② (후속) 프롬프트/알림 발사 시점 계측 — 프로덕션 재발 감시용. 선행 조건 아님(정정5).

폐기: B tombstone·디바운스 / A generation / D3 2중 실행 — §4-C 정정2, §4-D 정정6.
```

①을 먼저 하는 이유: §2 때문에 ②~⑤의 효과를 "알림이 안 온다"로 확인할 수 없다. 계측이 먼저다.

## 6. TDD red (test-first, 커밋 순서가 증거)

전부 **이 두 덤프가 fixture**다. 새 라이드 불필요.

| | 테스트 | 지금 상태 |
| --- | --- | --- |
| **R1** | rehydration reconciliation 미완료 상태에서 route/destination이 복원돼도 **POST가 나가지 않는다**(차단 사유까지 assert) | **red** (호출됨) |
| **R2** | *거부 케이스* — `phase === 'normal'`이면 register가 **그대로 호출된다**(과잉 차단 금지) | green 유지돼야 함 |
| **R3** | reconciliation이 force-end로 끝난 직후에도 register 금지 — **`TRIP_STARTED_AT_KEY`가 이미 삭제된 상태**에서도(정정4의 레이스 고정) | **red** |
| **R4** | backend: DELETE 후 T초 내 같은 token POST → **재생성되지 않고 `Retry-After` 반환**. `createdAt`이 **방금 시각이어도** 거부돼야 한다(정정3) | **red** |
| **R5** | *거부 케이스* — DELETE 후 T초 **경과** 뒤 POST → **통과한다**(정당한 새 트립을 막지 않는다) | green 유지돼야 함 |
| **R6** | DELETE in-flight 중 착지한 register는 폐기된다(generation 불일치) | **red** |
| **R8** | *전수* — 게이트가 **chokepoint에 있어** 트리거 5개(main effect / pushTokenListener / Tier2 fallback / register-retry / Tier2 heal) **전부** 걸린다. 누가 게이트를 main effect로 옮기면 깨져야 한다 | **red** (5/5) |
| **R9** | *안전* — rehydration이 **throw해도** flag가 열려 register가 정상 진행한다(영구 침묵 금지) | **red** (설계 전) |

**실패 사유까지 assert**한다 — R1이 "POST 0회"만 보면 다른 이유로 0이어도 통과한다. 차단 사유(`phase=force-end`)를 로그/반환값으로 assert.

**공유 primitive(L21)**: 백스톱 종료 판정은 `tripLifecyclePhase`(`src/features/alarm/utils/tripStartStorage.ts:36`)와 pause 임계가 이미 있다. register 가드가 그 로직을 **복사하지 않고**, `useStateRehydration`의 종료 분기와 **같은 순수 함수**(예: `isTripPendingBackstopEnd({startedAt, pausedAt, now})`)를 공유하도록 추출한다. 추출 후 백스톱도 그 함수를 쓰게 바꿔 사본이 생기지 않게 한다.

## 7. acceptance (라이드 비의존)

- **재현 시그니처**: 앱을 연속 N회 실행했을 때 D1에 `trip-end {reason:"user-delete"}`가 생기면 실패. 정상이면 `GET /trips/{token}/status` → **404 유지**.
- backend tombstone 거부 횟수를 D1 meta로 남겨 **실제로 거부가 일어났는지** 관측(Wire-completion #2).
- 오전 RCA의 `prepareAlarmFired`처럼 "0건이 정상인지 미배선인지" 모르는 지표를 또 만들지 않는다 — ①의 계측이 그 조건.

## 8. Wire-completion 5단

1. **Orphan 없음** — `npm run lint:orphan`. 새 export(`isTripPendingBackstopEnd`)는 양쪽 caller 존재.
2. **V/X dashboard** — D1 `trip_events`에 tombstone 거부 kind 추가 + 덤프에 발사 시점 계측 섹션.
3. **의존 PR** — ③은 backend 배포 필요(②④⑤는 앱 빌드). ①은 독립.
4. **측정 plan** — §7.
5. **Device verify** — ②④⑤는 실기기 실행 반복으로 확인 가능(라이드 불필요). ③은 backend 단독.

## 9. 범위 밖 (명시)

- **C안(생성 권한 축소)** — §4 근거로 이 PR에서 제외. 별건 ADR.
- **D안(임계값)** — 별건 ADR(종료 권한 축).
- **오전 트립이 device에서 정상 종료되지 않은 이유** — 이 사고의 선행 조건이지만 별건(오전 RCA).
- **leg-1 body trainCode** — 오전 RCA §1, 별건.
