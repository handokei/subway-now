# Plan #1824 — Seoul Open API outage device-side fallback 강화

**SSoT**: 본 문서. audit 결과 추가 시 갱신.

## 1. 문제

Seoul Open API outage 지속. backend `self-poll: realtimePosition` 36회 모두 error → KV cache stamp 0건 → device의 BFF 응답 빈손 → boardingPrompt realtime 평가 불가 + autoLock candidate 산출 불가.

### Production evidence (2026-06-25 Day 2 dump)

```
self-poll: realtimePosition stats:
  33x { fetched=0, cacheHit=0, error=1 }  (1개 line 시도, throw)
  3x  { fetched=0, cacheHit=0, error=2 }  (2개 line 시도, 둘 다 throw)
```

- backend `selfPollPosition.ts:135~159` `Promise.allSettled` graceful 실패 처리
- `seoul.fetchPositions(line)` 매번 throw → `error++` 누적
- KV stamp 0건 → caller "positionTrainAgreement undefined" 자연 fallback

### 사용자 가치 손실

- backend boardingPrompt가 realtime position 못 받음 → consensus 게이트 미달
- autoLock candidate 산출 불가 → backend autoLock 0건
- device useArrivalInfo가 BFF empty 응답 → arrival 신호 부재

## 2. 원인 분석

### 1차 가설 — Seoul API 외부 outage (확정)

`error=1/2` 매 cron throw — 일관됨. Seoul Open API 서버측 지속 outage.

→ 우리가 수정 불가. **device-side resilience 강화가 진짜 fix.**

### 2차 가설 — 현재 fallback 메커니즘 검증 필요

backend `arrivalsFromPositions.ts:34`:
> "positions 가 비어 있으면 빈 배열 반환 (caller 는 기존 schedule-based fallback 진행)."

이미 schedule-based fallback path 존재. 작동 검증 필요:

- backend caller (boardingPrompt / autoLock candidate / silent push)가 schedule fallback 채택하는가?
- device useArrivalInfo가 BFF empty 응답 시 어떤 fallback?
- BFF endpoint가 KV stamp empty면 어떤 응답?

→ **BG agent audit 필수.**

### 3차 가설 — Seoul API retry/backoff 부재

`selfPollPosition.ts:151` `seoul.fetchPositions(line)` 단일 호출. exponential backoff / retry 없음.

→ 외부 일시 outage 회복 시도 X. follow-up 가능 (낮은 우선순위).

## 3. 방안 옵션 (4개)

### A. backend schedule fallback 완성 (audit + 보강)

- backend caller가 positions empty 시 schedule-based arrival 사용하도록 보강
- 현재 path가 존재한다면 wiring 검증 + 누락된 caller 확인
- Wire-completion gate 적용

### B. device useArrivalInfo schedule fallback 활성화

- device 측에서 BFF empty 응답 시 timetable (정적 schedule) provider로 자동 폴백
- `src/features/route/api/TimetableProvider.ts` 이미 존재 (grep 확인)
- CompositeArrivalProvider에서 자동 폴백 wiring

### C. backend Seoul API retry + exponential backoff

- `seoul.fetchPositions(line)` 단일 호출 → retry 2회 + 1s/3s/10s backoff
- 일시 outage 회복 가능
- 지속 outage(현 evidence)에는 효과 0 — A/B와 결합 시 가치

### D. device-side direct Seoul API fallback (위험)

- BFF 빈손 + backend cron stale 시 device가 Seoul API 직접 호출
- 5G/LTE BG nil 한계 ([[reference_ios_wifi_api_constraint]]) — wifi 연결 사용자만 작동
- API key 노출 위험 (현재 EXPO_PUBLIC_SEOUL_DATA_API_KEY) → 보안 가드 필요
- 채택 비추천

## 4. 트레이드오프

| 옵션 | 사용자 가치 회복 | 외부 outage 의존도 | 변경 범위 | 회귀 위험 | audit 필요 |
|---|---|---|---|---|---|
| A (backend schedule) | 높음 (모든 caller 자동) | 0 | backend 다중 caller | 중간 | 많음 (wiring 검증) |
| B (device schedule) | 중간 (device caller만) | 0 | device 1 파일 | 낮음 | 적음 |
| C (retry/backoff) | 낮음 (지속 outage 효과 0) | 부분 | backend 1 파일 | 낮음 | 0 |
| D (device 직접) | 낮음 (wifi only) | 0 (자체 호출) | device + secure | 높음 (보안) | 많음 |

### A + B 결합 (추천)

- A: backend boardingPrompt / autoLock / silent push가 schedule fallback 채택
- B: device useArrivalInfo BFF empty → timetable provider 자동 폴백
- C는 별도 follow-up (낮은 우선순위)
- D는 채택 X (보안 + 환경 제약)

## 5. 결정 (잠정 — audit 결과 따라 조정)

**선택: A + B 결합 — backend + device 양측 schedule fallback 활성화**

### Acceptance

- backend `arrivalsFromPositions.test.ts` + caller test에 empty positions 시 schedule fallback 진입 확인
- device `CompositeArrivalProvider.test.ts`에 BFF empty 응답 → TimetableProvider 폴백 진입 확인
- Production 1주 측정:
  - Seoul API self-poll error 지속 (외부 회복 가능성 낮음)
  - 사용자 boardingPrompt 차단 reason에 `realtime-position-missing`이 0건으로 감소
  - autoLock candidate 산출 0건 → 정상 비율 회복

### Out of scope (별도 audit + 이슈)

- 옵션 C (retry/backoff): follow-up issue (가설 3)
- 옵션 D (device 직접): 채택 X
- Seoul Open API 외부 outage 자체 (우리 수정 불가)

## 6. Audit 결과 (2026-06-25 BG agent 검증 완료)

### 1. backend caller wiring
- `scheduled.ts:2899` — lockless 경로: `fetchArrivals(waypoint.stationName)` 빈 배열 → `pickBestArrivalSignal` null 반환 → `stats.etaMissing += 1` → return. Schedule fallback 없음 (**GAP**).
- `scheduled.ts:2382` — lock-active 경로 `estimateBoardingLockArrival`: arrivals empty면 positions로 fallback. positions도 없으면 null → etaMissing. Schedule fallback 없음 (**GAP**).
- `scheduled.ts:3317` — boardingPrompt 경로: `fetchArrivals(display.originStation)` 결과가 direct caller `attachTrainCodeForLeg`로 전달. positions fallback은 있으나 schedule fallback 없음 (**GAP**).
- `autoLock.ts` — paradigm shift (#1729) 후 `attemptAutoLock` 제거됨. backend autoLock은 없음 (out of scope).

### 2. device CompositeArrivalProvider 흐름
- `CompositeArrivalProvider`: Korail ↔ Seoul routing wrapper. Seoul API outage 시 timetable fallback 없음.
- **단, `BffArrivalProvider.ts:27-28`가 이미 BFF empty 응답 시 `getFallbackArrival` → `buildScheduleArrival` 경로를 사용 중** (schedule fallback 작동 중).
- `useArrivalInfo`도 `createArrivalProvider()` → `BffArrivalProvider` → schedule fallback chain이 이미 wired. (**옵션 B 이미 완료**)

### 3. TimetableProvider 현재 사용처
- `src/features/route/api/TimetableProvider.ts`는 route feature의 interface 정의 파일 (abstract). 실제 구현체 `StaticTimetableProvider`는 별도 파일.
- `src/features/alarm/utils/scheduleFallback.ts`가 실제 timetable/headway data를 사용하는 구현체. `buildScheduleArrival`이 진입점.
- arrival feature는 `scheduleFallback.ts`를 통해 이미 schedule data를 활용 중.

### 4. Wire-completion gate
- device side: BFF empty → `getFallbackArrival` → schedule fallback 이미 wire됨 (**옵션 B 완료**).
- backend side: `fetchArrivals` empty → schedule fallback 없음 (**옵션 A 미구현, GAP**).

### 결정 조정
- **옵션 B는 이미 작동 중 — 추가 구현 불필요.**
- **옵션 A만 구현 필요**: backend `fetchArrivals` empty 시 schedule-based arrival entry를 합성해 lockless/lock-active 경로가 etaMissing 대신 schedule 기반 ETA를 사용하도록 보강.

## 7. Wire-completion 5단 self-check

1. **Orphan**: schedule fallback caller wiring 완성 시 새 export 추가 가능 → ignore pattern 갱신 또는 caller 추가
2. **V/X dashboard**: backend log에 `schedule-fallback used` 카운터 추가 + DebugModal arrival source 표시
3. **의존 PR**: 잔여 #1, #2와 독립
4. **측정 plan**: production 1주, schedule-fallback used 카운터 + boardingPrompt 차단 reason 분포
5. **Device verify**: 실기기 trip (Seoul API outage 시) 1건 — schedule fallback arrival 표시 확인

## 관련 메모리

- [[reference_ios_wifi_api_constraint]] device wifi 연결 사용자만 SSID 잡힘
- [[feedback_device_self_contained_fusion]] backend / WiFi / Seoul 모두 죽어도 device 자체 정합
- [[lesson_seoul_outage_user_blackhole_chain]] Seoul outage → user 23분 black hole chain
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- [[feedback_decision_no_false_binary]] 옵션 4개 명시

## BG agent 위임 지시

- worktree: 격리 필수
- 작업 순서:
  1. audit 4건 (#6 Audit 필요 사항) — 각 caller wiring + provider 흐름
  2. audit 결과 plan SSoT 갱신 (조정 필요시)
  3. A + B 구현 + acceptance 테스트
  4. PR 본문에 audit 결과 + Wire-completion 5단 포함
- 추가 audit (별도 메모리로 보고): C/D 옵션의 production 가치
- 머지 후 worktree 즉시 cleanup
