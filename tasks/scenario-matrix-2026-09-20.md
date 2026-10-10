# 시나리오 재생 매트릭스 (2026-09-20)

목적: "시나리오대로 dump 시뮬레이션에서 매역 알림 / LA lock 생성 / leg-n 이 문제없이 되는지"를
라이드 없이 재생으로 판정한다. 이 문서는 측정 도구 산출물이며, 발견된 결함은 별도 이슈로
보고한다(이 작업에서 앱 코드는 수정하지 않았다).

## 0. 작업 중 발견된 것 — 원 과제의 커버리지 판단이 틀렸다

이 작업을 시작할 때 "빈칸"으로 지정됐던 3개 항목 중 **어느 것도 새 재생 시나리오를 필요로
하지 않았다.** 전부 이미 존재하거나(테스트) 구조적으로 답이 나와 있었다(코드).
반복 방지를 위해 무엇이, 왜 틀렸었는지를 명시한다.

| # | 원래 "빈칸"으로 분류됐던 항목 | 실제 상태 | 어떻게 확인했나 |
| --- | --- | --- | --- |
| 1 | leg-2 + lock 활성 완주 (실측 기반) | **이미 존재, pass** — `replay_20260918_lock_seeded_contrast.test.ts`. 최초 작성 시(#2718) "대조군(실측 아님) — #2709 fix 가정"으로 라벨링됐으나, #2709(`0a5a0f89`, "lock → backend 전달 경로 통합")가 이미 dev에 머지돼 이제는 가정이 아니라 현재 코드의 실제 동작이다. | main coordinator가 먼저 실행해 지적, 본 작업에서 재실행해 1/1 pass 재확인(`npx vitest run` 직접 실행). describe/주석을 post-#2709로 정정(§2 참고). |
| 2 | leg-3 이상 (관측 이력 0, 합성 필요) | **이미 존재, pass** — `whole_trip_3leg_e2e.test.ts`(2026-09-13). 7호선(leg-1)→건대입구 환승→2호선(leg-2)→왕십리 환승→5호선(leg-3)→목적지를 한 연속 cron 구동으로 재현, leg-2/leg-3 둘 다 `/boarding-lock/sync` 재부착 + 매역 발사 + destination cleanup까지 assert. `multileg_architecture.test.ts`(2026-09-11)가 leg 무관 아키텍처 불변식을 별도로 더 검증. | 본 작업에서 직접 실행(`npx vitest run whole_trip_3leg_e2e.test.ts` → 2 tests pass) + 코드 read로 assertion 내용 확인. |
| 3 | LA 경로로 생성된 lock의 하류 동등성 | **새 시나리오로 증명할 대상 자체가 없다** — 구조적으로 이미 답이 나와 있다. `BoardingLockMeta`(types.ts:505)에 lock의 생성 출처(LA/알림/수동탭)를 구분하는 필드가 아예 없다. `/live-activity/register`(index.ts:3068)는 `activityPushToken`/`activityState`만 갱신하고 `boardingLock`은 건드리지 않는다 — LA는 lock을 만들지 않고 push token만 등록한다. device의 `lock-create:reason` 라벨(#2722)은 `src/features/debug/`(DebugModal 표시용)에서만 쓰이고 backend로 전송되지 않는다(grep 확인, 0 hits 외). | `types.ts`/`index.ts` 직접 read + `grep -rln "lock-create:" src/`로 backend 미전송 확인. |

**결론**: leg-N 상태기계(부착→매역 발사→환승→재부착→목적지 완결)는 leg-2/leg-3 모두 이미
결정론적으로 반증 가능하게 커버돼 있다. 실사용 "16전 0승"은 **재생 상태기계의 결함이 아니라
production에서 leg-2 lock 자체가 좀처럼 확립되지 못하는 문제**(#2709가 그 중 한 원인이었고
이미 fix됨; ADR-039 A4는 leg-2 backend 자동락을 의도적으로 금지)다 — 이 문서의 범위(재생
검증) 밖이다.

## 1. 커버리지 매트릭스

### 1-1. Backend `REPLAY_LIBRARY` entry (`backend/alarm-worker/src/__tests__/replayLibrary.ts`)

| slug | 시나리오 | 실측/합성 | leg | lock 상태 | 커버 신호 |
| --- | --- | --- | --- | --- | --- |
| `capture_20260912_line7_synth` | 건대입구→중곡, cron 위상 스윕(4종) | **합성**(slug/description에 명시) | leg-1(단일) | lock 활성 | 매역 3역 + destination trip-ended |
| `capture_20260913T1249Z_b00dd879` | 용마산 승차→건대입구 환승→leg-2(뚝섬 방면) | 실측 | leg-1(lock) + leg-2(lockless, legConsensus 파생) | leg-1 lock, leg-2는 fix로 파생된 legConsensus 발사(실측 아님, `derivedFiredStations`로 분리 표기) | 매역 4역 + hop-end-prompt(건대입구) |
| `capture_20260913T2127Z_b00dd879` | 위와 동일 경로, 다른 날 라이드(7039 lock) | 실측 | 위와 동일 | 위와 동일 | 위와 동일 + #2602 회귀 앵커(freshness cycle 이산화) |
| `capture_20260918_line7_yongmasan_overshoot` | 뚝섬→건대입구 환승→용마산, 목적지 통과 | 실측(lockless가 실측 — 라이딩 중 KV로 `boardingLock: None` 3회 직접 확인) | leg-1(2호선, hop-end-prompt만) + leg-2(7호선, lockless) | lockless(#2709 이전 버그로 lock이 backend 미도달) | lockless intermediate 3역 + destination trip-ended + hop-end-prompt(건대입구) |

### 1-2. Backend standalone 재생 테스트 (REPLAY_LIBRARY 비등록, `Backend Validation` CI로 이미 상시 게이트)

| 파일 | 시나리오 | 실측/합성 | leg | 비고 |
| --- | --- | --- | --- | --- |
| `replay_20260918_lock_seeded_contrast.test.ts` | `capture_20260918_line7_yongmasan_overshoot`와 **동일 R2 캡처**를 재사용하되 leg-2(7호선) lock을 seed | 실측 캡처 + **seed 부분만 합성**(lock 부착 자체는 그 라이드에서 실측되지 않음, 명시) | **leg-2, lock 활성 완주** | post-#2709(dev 머지) 기준 현재 동작 검증. REPLAY_LIBRARY 미등록 사유: 같은 fixture 파일을 가리키는 2번째 entry는 `replay_library.full.test.ts`의 "디렉터리 ↔ registry 1:1" 테스트를 깬다(파일 복제 없이는 등록 불가 — 복제는 "새 fixture 신설 금지"에 저촉돼 하지 않았다). |
| `whole_trip_multitransfer_e2e.test.ts` | 7호선(leg-1, 용마산→건대입구)→환승→2호선(leg-2, 성수→뚝섬), controlled Seoul client | **합성**(2026-09-13, 명시) | leg-1(lock)→leg-2(sync 재부착 lock) | 연속 cron 구동, 상태기계 연속성 검증. 매역 발사 + cleanup. |
| `whole_trip_3leg_e2e.test.ts` | 7호선(leg-1)→건대입구 환승→2호선(leg-2)→왕십리 환승→5호선(leg-3)→답십리 | **합성**(2026-09-13, 명시) | leg-1/2/3 | it 1: sync 재부착 기반 3-leg 연속 부착+발사+cleanup. it 2: sync 없이 realtimePosition streak(2회)만으로 leg-2 lock 자동 부착. |
| `multileg_architecture.test.ts` | leg-1/2/3 segment 격리 + sync 승격 불변식 | **합성**(2026-09-11, 명시) | leg-1/2/3 | 상태기계 자체가 아니라 leg-agnostic 불변식(2가지)만 단위 검증. |

### 1-3. Device 층 재생 (`src/features/alarm/__tests__/`)

| 파일 | 시나리오 | 실측/합성 | 커버 신호 |
| --- | --- | --- | --- |
| `replay_20260918_yongmasan_overshoot.test.ts` | 2026-09-18 라이드의 fusionSource 도출(강/약 source 창 2개) → `useStationAlarm` 억제 게이트 | 실측(dump `ed3e62ef-918-2.txt`) | ADR-039 close 조건 2·3 — backend 재생이 원리적으로 못 미치는 frontend 게이트(`gate-phase-*`, GPS distance sanity)를 직접 관통. |

### 1-4. LA lock 하류 동등성 — 코드 구조 확인(재생 시나리오 불필요)

| 확인 항목 | 근거 |
| --- | --- |
| backend가 lock 출처(LA/알림/수동탭)를 구분하는 필드를 갖는가 | 아니오 — `BoardingLockMeta`(types.ts:505)에 trainCode/line/subwayId/selectedDepartureTime/segmentStations/expiresAt/autoLockedAt만 존재. `autoLockedAt`은 "backend 자동락 vs 사용자 명시"만 구분하지 UI 진입점은 구분 안 함. |
| `/live-activity/register`가 lock을 생성/수정하는가 | 아니오 — `activityPushToken`/`activityState`만 갱신(index.ts:3068). |
| device의 `lock-create:reason` 라벨이 backend로 전송되는가 | 아니오 — `src/features/debug/`(DebugModal 표시 전용)에서만 소비, backend 페이로드에 없음(grep 확인). |

→ 결론: 3개 진입점(LA 버튼/알림 탑승 탭/수동 탭) 중 무엇이 lock을 만들었든 backend는
**동일한 `/boarding-lock/sync` 또는 `POST /trips` boardingLock 페이로드**만 관측한다 — 하류
분기 자체가 코드에 없으므로 "하류에서 다르게 취급"될 가능성이 구조적으로 0이다. 위 1-1/1-2의
모든 lock-active 시나리오가 이미 이 동일 코드 경로를 검증하고 있다.

## 2. 재생으로 검증 불가능한 범위

| 항목 | 사유 |
| --- | --- |
| ActivityKit(LA) 실제 렌더링(Dynamic Island/Lock Screen UI) | 재생 하네스는 APNs push payload까지만 캡처한다. `modules/live-activity/`의 native UI 렌더는 ActivityKit 자체가 담당 — 실기기/시뮬레이터에서만 관측 가능. |
| 홈 위젯(`targets/subway-widget`) 갱신 | `widgetStorage`가 App Groups에 쓰는 값의 UI 반영은 WidgetKit timeline 갱신에 의존 — 재생 스코프 밖. |
| APNs 실제 도달(네트워크/디바이스 토큰 유효성/OS throttle) | 재생 하네스는 APNs `fetch` 호출을 가로채 캡처만 하고 실제 Apple 서버로 보내지 않는다(`makeCapturingApnsFetch`). "이 payload가 실제로 사용자 lock screen에 떴는가"는 원리적으로 재생 불가. |
| 배터리/디바이스 리소스 영향 | 재생은 순수 서버 로직(cron scheduler) 시뮬레이션 — device의 GPS 폴링/모션 센서 사용 등 배터리 소모는 이 하네스가 관측하는 대상이 아니다. |
| leg-N lock 확립 자체(사용자가 실제로 재탭/LA 선택을 하는가) | 이 문서가 검증하는 것은 "lock이 확립되면 상태기계가 정확히 동작하는가"이다. "확립되는가"는 UX/ADR-039 A4(backend 자동락 의도적 금지) 영역이며 별도 issue 대상. |

## 3. 요약

- **커버됨**: 4 REPLAY_LIBRARY entry + 4 standalone backend 재생 테스트(1-2) + 1 device 재생 테스트(1-3) = 총 9개 재생 산출물, leg-1/leg-2/leg-3/lock 활성/lockless/환승/도착/하차 프롬프트/LA 하류 동등성(구조 확인) 전부 커버.
- **새로 커버함(본 작업)**: 0건 — 새 시나리오/fixture를 추가하지 않았다(전부 이미 존재했거나 코드 구조상 불필요했다는 게 이번 조사의 결론).
- **여전히 미커버(재생 불가, §2 참고)**: ActivityKit 렌더 / 위젯 / APNs 실도달 / 배터리 = 4건.
- **본 작업에서 변경한 것**: `replay_20260918_lock_seeded_contrast.test.ts`의 describe/주석만 "대조군(#2709 fix 가정)" → "post-#2709 leg-2 lock 활성 완주 시나리오"로 라벨 정정(테스트 내용·기대값 불변, 1/1 pass 유지).
- **실패 발견**: 없음 — 기존 테스트 9개 전부 pass, 새 코드도 작성하지 않았으므로 새로운 회귀도 없다.
