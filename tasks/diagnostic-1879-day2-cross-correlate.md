# Day 2 (2026-06-25) Trip Device+Backend Cross-Correlate 진단

**Issue**: #1879  
**작성일**: 2026-06-26  
**분석 대상**: 2026-06-25 오후 trip (사가정 → 왕십리(성동구청) → 마장)

---

## §1 Trip 개요

| 항목 | 내용 |
|---|---|
| dump 캡처 시각 | 2026-06-25T05:24:43Z (KST 14:24:43) |
| trip 시작 추정 | KST 13:46 (첫 backend trip POST 직전) |
| trip 종료 추정 | KST 14:24 (DELETE /trips 확인) |
| 총 탑승 시간 | 약 38분 |
| 출발역 추정 | 사가정(7) — dump 캡처 위치 (86m 거리) |
| 경유역 | 한양대(5) — station-passed 13:46:32 |
| 환승역 | 왕십리(성동구청)(5) — transfer early 13:46:37 |
| 목적지 | 마장(5) — destinationId=5-032, destination early 13:49:38 |
| lockless 상태 | true (BoardingLock.active=no 내내) |
| 발화 알람 | 4건: station-passed 한양대, transfer early 왕십리, destination early 마장, station-passed 왕십리 |
| silent push | received=0, fired=0 (전체 trip 구간) |
| boardingPrompt | 0건 표시, 0건 응답 |

### Trip 등록 이력 (backend POST /trips 3회)

device가 동일 route로 trip을 3회 재등록했다. 이는 **lockless 재등록 루프** 증거.

| 시각 (KST) | origin | destinationId | inferredCount |
|---|---|---|---|
| 13:46:17 | (로그 없음, device Backend Calls 확인) | — | — |
| 13:49:38 | 왕십리(성동구청) | 5-032 (마장) | 1 |
| 13:54:00 | 왕십리(성동구청) | 5-032 (마장) | 1 |
| 13:55:32 | 왕십리(성동구청) | 5-032 (마장) | 1 |

> 13:46에는 backend Dijkstra waypoint 로그가 없다 → 다른 route/token으로 등록됐거나 로그가 없는 early 등록.  
> 13:49~55 사이 3회는 동일 e25e1158 토큰, 동일 origin/dest로 반복 등록 → lockless 재-register 회귀 패턴 (lesson_bg_scheduled_queue_stale_misfire 참조).

---

## §2 Device 12 Stages Chain 결과 (fixture chain runner)

dump 캡처 시점 (14:24) 기준. trip은 이미 종료 후.

| # | Stage | 결과 | Evidence |
|---|---|---|---|
| 1 | trip-registered | **FAIL** | lifecyclePhase=none, tripStartedAt=— |
| 2 | environment-classified | **FAIL** | subsurface=false, confidence=gps-only, boarding-prompt-log=0 |
| 3 | boardingPrompt-displayed | **FAIL** | boarding-prompt=0 |
| 4 | lock-attach | **FAIL** | boardingLock.active=false |
| 5 | silent-push-received | **FAIL** | received=0 |
| 6 | station-passed-fired | **PASS** | notificationsFiredCount=4, kinds=[station-passed, destination, transfer] |
| 7 | cold-start-detected | **FAIL** | accuracy=38.3m < 50m 임계값 (fallback), env=unknown, hasTrip=false |
| 8 | candidates-extracted | **FAIL** | coldStart 섹션 없음 (Phase 6.1 미머지) |
| 9 | weighted-narrowed | **FAIL** | coldStart 섹션 없음 |
| 10 | picker-shown | **FAIL** | coldStart 섹션 없음 |
| 11 | user-selected | **FAIL** | coldStart 섹션 없음 |
| 12 | mismatch-detected | **FAIL** | alarmLog.cold-start-mismatch=0 |

**firstStuck: trip-registered** (dump 캡처 기준)  
**allPassed: false**

### 해석

- Stage 6 (station-passed) **PASS**: trip 중 알람은 정상 작동. 즉, device-side 알람 엔진 자체는 살아있었다.
- Stage 1~5 FAIL은 dump가 **trip 종료 후** 캡처됐기 때문 — 종료 후 lifecyclePhase=none이 정상.
- Stage 7 (cold-start-detected) FAIL: accuracy=38.3m < 50m 임계값 → cold start 조건 미충족. 지상에서 앱 열었으므로 GPS가 정상 수신 상태.
- Stage 8~12 FAIL: Phase 6.1이 이 trip 당시 아직 미머지 → ## Cold Start 섹션 dump에 없음 (예상).

**결론: 알람 자체는 4건 발사되었다. 사용자 frustration은 boardingPrompt와 silent push 미작동에서 온다.**

---

## §3 Backend 타임라인 (시간순 핵심 events)

| 시각 (KST) | 타입 | 이벤트 |
|---|---|---|
| 13:30~13:45 | cron | 매분 실행, trip 없음 (scheduled run complete만) |
| 13:46:07 | fetch | POST /signals/dump → **503 error** |
| 13:46:07 | fetch | GET /admin/telemetry/regressions, GET /v1/observability/metrics (앱 FG 진입) |
| 13:46:17 | fetch | **POST /trips** (첫 trip 등록) |
| 13:46:42 | cron | **self-poll: error=2** (Seoul API 2개 실패), boarding-lock: skip (lock missing), **boarding-prompt: gate blocked (reason=motion-not-moving, env=unknown)** |
| 13:47:42 | cron | 동일 패턴 반복 |
| 13:48:02 | fetch | POST /position |
| 13:48:03 | fetch | POST /live-activity/register |
| 13:48:41 | cron | self-poll: error=2, boarding-lock: skip, **boarding-prompt: gate blocked (motion-not-moving, unknown)** |
| 13:49:38 | fetch | POST /trips (2차 등록, Dijkstra: 왕십리→마장, infer=1) |
| 13:49:41 | cron | self-poll: **error=1** (Seoul API 1개로 감소), boarding-lock: skip, boarding-prompt: gate blocked (motion-not-moving, unknown) |
| 13:49:47 | fetch | POST /position |
| 13:49:53 | fetch | POST /boarding-lock/sync |
| 13:50~13:53 | cron | 매분: boarding-lock skip + boarding-prompt gate blocked (motion-not-moving, unknown) |
| 13:53:58 | fetch | POST /position |
| 13:54:00 | fetch | POST /trips (3차 등록, 동일 route) |
| 13:54:05 | fetch | POST /boarding-lock/sync |
| 13:55:32 | fetch | POST /trips (4차 등록, 동일 route) |
| 13:55~14:23 | cron | 매분: **동일 패턴 36회** — boarding-lock skip + boarding-prompt gate blocked (motion-not-moving, unknown) |
| 14:24:19 | fetch | DELETE /trips, DELETE /live-activity, POST /trips, GET /trips/status, POST /position (trip 재시작 시도) |
| 14:24:24 | fetch | POST /boarding-lock/sync |
| 14:24:27 | fetch | DELETE /trips, DELETE /live-activity (최종 종료) |
| 14:24:28 | fetch | **la dismissal failed: BadDeviceToken (400)** |
| 14:24+ | cron | trip 없음, boarding-prompt/lock log 사라짐 |

### self-poll: realtimePosition 에러 패턴

- 13:46~13:48: `error=2` (Seoul API 2개 실패)
- 13:49 이후: `error=1` (Seoul API 1개 실패)
- **전 trip 구간 fetched=0, cacheHit=0** → backend가 Seoul API 위치 정보를 한 번도 성공적으로 가져오지 못했다.

---

## §4 Cross-Correlate 매트릭스

### Device stage ↔ Backend event 인과

| Device 이벤트 | 시각 | Backend 대응 | 인과 설명 |
|---|---|---|---|
| trip 등록 (첫 trip) | 13:46 | POST /trips 성공, trip 인식 | device trip ↔ backend trip 동기화 |
| station-passed 한양대 fired | 13:46:32 | — | device-side 알람 (backend push 불요) |
| transfer early 왕십리 fired | 13:46:37 | — | device-side 알람 |
| destination early 마장 fired | 13:49:38 | — | device-side 알람 |
| station-passed 왕십리 fired | 13:51:19 | — | device-side 알람 |
| boardingPrompt 미발사 | 전 구간 | boarding-prompt: gate blocked x36 (motion-not-moving, env=unknown) | **핵심 인과** — 아래 §5 상세 |
| silent push 미수신 | 전 구간 | retry-push scanned=0 매분 | lock 없음 → push 스케줄 없음 |
| BoardingLock.active=no | 전 구간 | boarding-lock: skip cycle (lock missing or expired) | lock 없음 인정 |
| trip 재등록 루프 | 13:49, 13:54, 13:55 | 동일 e25e1158 token으로 3회 Dijkstra re-register | lockless 재등록 회귀 |
| signals/dump 503 | 13:46:07, 14:24:19 | /signals/dump → 503 | RAW_SIGNALS endpoint 불안정 |
| la dismissal failed | 14:24:28 | BadDeviceToken(400) | LA token 만료/교체 |

---

## §5 사용자 Frustration Root Cause 식별

### Root Cause 1 (주원인): boarding-prompt gate `motion-not-moving` + `environment=unknown` 조합으로 36회 전량 차단

**증거**: backend 로그 13:46~14:23 매분 36회:
```json
{"msg":"boarding-prompt: gate blocked","token":"e25e1158","reason":"motion-not-moving","environment":"unknown"}
```

**원인 체인**:
1. **environment=unknown**: device Raw Signal 전 구간 `sub=false`(지상) + motion=`automotive`/`walking`/`stationary`으로 혼재. Environment Distribution `unknown=100%` (관측 7초만). backend가 `unknown` environment를 `motion-not-moving` 게이트와 AND 결합해서 차단.
2. **motion-not-moving**: backend cron의 self-poll `fetched=0, error=1~2` — Seoul API 위치 데이터를 못 받아서 motion 판정을 `not-moving`으로 기본값 설정.
3. 결과: boardingPrompt 한 번도 표시 안 됨 → 사용자가 직접 boardingPrompt에 응답할 기회 없음 → lock 획득 못함 → silent push 0건.

**이 trip의 알람이 4건 발사된 이유**: boardingPrompt 없이도 **device-side 알람 엔진**(fg 폴링)이 직접 station-passed/transfer/destination을 발사. 그러나 lock 없는 상태이므로 background에서는 완전히 dead.

### Root Cause 2 (보조): self-poll Seoul API 전 구간 실패 (fetched=0)

backend cron self-poll이 trip 전 구간 Seoul API 호출에 실패. `error=1~2`(서울 API 2개 중 1~2개 실패). 이로 인해:
- motion 판정 데이터 부재 → `motion-not-moving` 기본값
- Seoul API 호출 실패 = cron이 위치 기반 push 불가 (silent push scanned=0 이어지는 원인 중 하나)

### Root Cause 3 (보조): lockless 재등록 루프 (3회 반복)

trip 재등록이 3회(13:49, 13:54, 13:55) 반복. backend 관점에서 동일 token으로 동일 route를 반복 업서트하는 패턴. lesson_bg_scheduled_queue_stale_misfire에서 확인된 패턴.

### 오전 trip과의 비교

오전 dump(6:25-오전.txt)는 **silent-push-received=6, boarding-prompt=1(fired=autolock-success)**. 즉:
- 오전: boarding-prompt 발사 + autolock 성공 + silent push 6건 수신 → 정상 체인
- 오후: boarding-prompt 36회 차단 + lock 없음 + silent push 0건 → 체인 dead

**차이점**: 오전은 environment=underground 진입(지하 7호선 용마산→건대 구간)으로 boarding-prompt가 정상 발사됐다. 오후는 사가정(7)→왕십리→마장 구간이 **지상 노선**이므로 environment=unknown이 지속됐다.

---

## §6 Phase 6.1 머지 후 가상 시뮬레이션

Phase 6.1 (PR #1836, 이미 머지됨)은 **cold start 감지 + 후보 추출**을 추가한다.

### 이 trip에 Phase 6.1이 적용됐다면?

**cold-start-detected 조건 체크**:
- GPS accuracy=38.3m < 50m 임계값 → **cold start 조건 미충족**
- environment=unknown (7초 관측) → 조건 일부 충족
- hasTrip=false (dump 캡처 시점) → 조건 충족
- **결론: cold-start-detected=false** → Phase 6.1 picker 미표시

이 trip은 **지상 FG 탑승** 시나리오이므로 Phase 6.1 cold start 경로가 트리거되지 않는다. Phase 6.1은 **지하 진입 후 앱 재시작** 또는 **오래된 GPS 고정값** 시나리오에 적용된다.

### mismatch-detected 시뮬레이션

Phase 6.1 mismatch detector (PR #1844 계획)가 있었다면:
- trip 초기 station: 한양대(5) 또는 사가정(7)
- backend SSoT 반영 station: 왕십리(성동구청) (self-poll fetched=0이라 없음)
- mismatch 감지: **불가** — backend가 Seoul API 못 받아서 SSoT 자체가 없음

→ Phase 6.1이 있어도 이 trip에서는 **효과 없음**. 이 trip의 문제는 cold start가 아니라 boarding-prompt gate 차단.

---

## §7 Follow-up 권고

### P1: boarding-prompt `motion-not-moving` + `environment=unknown` 조합 게이트 완화

**이슈**: #1820 (plan-1820-boarding-prompt-motion-grace.md)  
**현상**: environment=unknown + motion=not-moving 조합이면 영구 차단. Seoul API 실패 시 motion 판정이 `not-moving`으로 기본값 설정되어 FG 지상 탑승자 전원 차단 가능.  
**권고**: motion-not-moving 게이트를 environment=unknown일 때는 완화하거나, Seoul API 실패 시 motion 판정을 `unknown`으로 별도 처리.

### P2: environment=unknown 분류 개선

**이슈**: #1821 (plan-1821-environment-unknown-classification.md)  
**현상**: Environment Distribution `unknown=100%`가 7초 관측만으로 확정. 짧은 FG 세션에서 unknown 고착.  
**권고**: unknown 판정 최소 관측 시간 설정, 또는 FG 세션에서 environment 기본값을 surface로 설정.

### P3: self-poll Seoul API 실패 시 fallback motion 판정

**현상**: self-poll fetched=0 → motion not-moving 기본값 → boarding-prompt 영구 차단.  
**권고**: self-poll 실패 시 motion 판정을 null/unknown으로 처리, boarding-prompt 게이트에서 null = 차단 해제.

### P4: lockless 재등록 루프 방지

**현상**: 동일 token+route로 3회 재등록 (lesson_bg_scheduled_queue_stale_misfire).  
**이슈**: 별도 이슈 아직 없음 — 이 trip에서 확인된 패턴 재확인.  
**권고**: trip 재등록 시 동일 token이면 upsert로 처리(현재 구현 확인 필요), 또는 dedup 게이트 추가.

### 이미 머지된 것 (효과 없음 이 trip에)

- feat/#1836 Phase 6.1: 이 trip은 cold start 조건 미충족 → 효과 없음.
- feat/#1833 fixture chain runner: 진단 인프라 개선, 이 trip 분석에 활용됨.

---

## §8 관련 메모리

- `lesson_silent_push_zero_is_paradigm_intent` — silent push 0 = lockless+의향X = 정상이나, 이 trip은 사용자가 목적지를 설정했음에도 0건 → 의향 표명 미인식
- `feedback_full_log_cross_analysis` — device tail + backend tail 교차 분석 방법론
- `lesson_boarding_prompt_9and_gate_gps_only` — boarding-prompt 9-AND gate 구조 (이 trip에서 motion-not-moving + environment=unknown 2개 AND 차단 확인)
- `feedback_chain_validation_not_measurement` — chain 작동이 1순위. 이 trip에서 chain이 boarding-prompt 단계에서 막힘을 확인
- `lesson_seoul_outage_user_blackhole_chain` — Seoul API 실패 → auto-end 체인. 이 trip에서 self-poll fetched=0 = Seoul API 부분 장애

---

## 진단 요약

| 항목 | 결과 |
|---|---|
| chain firstStuck | trip-registered (dump 캡처 기준, 종료 후 정상) |
| 실 trip 중 firstStuck | **environment-classified** / **boardingPrompt-displayed** (boarding-prompt 36회 차단) |
| silent push 0건 원인 | boarding-lock 없음 → retry-push scanned=0 |
| boarding-prompt 차단 이유 | `motion-not-moving` + `environment=unknown` (Seoul API 실패로 motion 판정 불가) |
| Phase 6.1 효과 | 없음 (이 trip은 cold start 조건 미충족) |
| P1 권고 | boarding-prompt motion gate → Seoul API 실패 시 null 처리 (plan-1820 연계) |
