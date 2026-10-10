# Plan #1828 — Phase 5: Route-bound station-level Seoul API polling

**SSoT**: 본 문서. audit 결과 BG agent 자율 갱신.

## 1. 문제

### 현재 backend polling 디자인 비효율

`backend/alarm-worker/src/selfPollPosition.ts:135`:
```ts
pollLinesAndStamp(kv, seoul, lines: ReadonlySet<LineNumber>, now)
```

- 활성 trip의 **line union** 단위 polling
- `seoul.fetchPositions(line)` → line 전체 trains (max 100) 반환
- device가 받아서 3km 이상 train은 `candidate-distance-reject` (정상 가드)

### 비효율의 evidence (Day 2 dump)

- `fusion-candidate-reject candidate-distance-reject` 53건/시간 (인천/이매/보정/달월/미금/수서/원인재 등)
- 사용자 trip line의 다른 위치 trains를 모두 device에서 평가하고 reject
- `lesson_gps_drop_fusion_buffer_pollution` 사고 사례 — fusionDebugBuffer 200 cap 점령 위험 (현재 burst dedup으로 보호 중)

### 잠재적 가치

- backend API rate ↓ (line 1 call → station N calls, 단 N << line trains 100)
- device candidate 평가 비용 ↓
- fusionDebugBuffer pollution 위험 ↓
- 정확도 ↑ (trip route bound)

## 2. Seoul Open API endpoint 옵션

| Endpoint | 반환 | 현재 사용 |
|---|---|---|
| `realtimePosition/{line}` | line 전체 trains (max 100) | backend self-poll |
| `realtimeStationArrival/{stnName}` | 특정 역 도착 정보 (max 10) | device `useArrivalInfo` |
| `SearchSTNTimeTableByIDService` | 정적 시간표 | `scheduleFallback.ts` |

## 3. 옵션 (4개, false binary 차단)

### A. Trip route 다음 N개 역만 `fetchArrivals` (역 단위) ★ 채택 후보

- backend = lines union → **station union**
- N=3~5개 역만 polling (route 다음 station + 환승 후보)
- 효율 ↑↑, 정확도 ↑ (route bound)
- API call 분산 — 1 line call → N station calls

### B. fetchPositions(line) + device 필터링 (현재 유지)

- 그대로 두고 device 측 필터링 강화
- 0 LOC change
- 부수적 비효율 누적

### C. 사용자 현재 역만 fetchArrivals (1개 역)

- 가장 효율적
- ❌ 환승/도착 임박 못 잡음 (다음 역 정보 X)
- 채택 X

### D. Route graph-aware polling (full route)

- trip route 따라 모든 역 + 환승 후보 동시
- N calls + KV cache + share
- 가장 정확하지만 구현 비용 ↑
- Epic #1763 (자동 학습) 통합 후 진행

## 4. 트레이드오프

| 옵션 | 효율 | 정확도 | 구현 비용 | API rate | 회귀 위험 | audit 필요 |
|---|---|---|---|---|---|---|
| A (route N) | 높음 | 높음 (bound) | 중간 | N calls/cycle | 낮음 (graceful fallback) | 적음 |
| B (현재) | 낮음 | 정상 | 0 | 1/line | 0 | 0 |
| C (current 1) | 가장 높음 | 환승/도착 miss | 낮음 | 1/cycle | 높음 (환승/도착) | 0 |
| D (graph-aware) | 높음 | 가장 높음 | 높음 | N calls + share | 중간 | 많음 |

## 5. 결정

**채택: A (Trip route 다음 N개 역 `fetchArrivals`)**

이유:
1. evidence 53회 reject가 직접 cover (route bound polling으로 다른 역 candidate 0건)
2. 변경 범위 중간 — `selfPollPosition.ts` + caller 1~2곳
3. 회귀 위험 낮음 — Seoul API 자체 endpoint, fallback path 유지 가능
4. D는 Epic #1763 (자동 학습 route graph) 후 진행이 자연스러움

### N 결정 (Audit 필요)

- N=3: 최소 (다음 역 + 1환승 + 종점)
- N=5: 권장 (다음 역 + 2환승 + 종점 + 종착)
- N=route length: 너무 비싸므로 cap

**잠정: N=5, 단 환승 hop 이상은 후속 역 1개씩 추가** (적응적)

### KV stamp 단위

- 현재: `selfPoll:line:<line>` key, 30s TTL
- 새: `selfPoll:station:<stnName>` key, 30s TTL
- station 별 stamp → device가 KV read로 BFF 응답 사용 가능 (이미 wired)

## 6. Audit 결과 (BG agent 완료 2026-06-25)

1. **현재 caller wiring**: `scheduled.ts:809` — `collectActiveLines(env, now)` → line Set → `pollLinesAndStamp(kv, seoul, activeLines, now)`. `collectActiveLines`는 `listTrips` 1차 iterate + `computeAllowedLines(trip.route, trip.waypoints)`로 line union 추출. 변경 대상: `collectActiveLines` → `collectActiveStations` + `pollLinesAndStamp` → `pollStationsAndStamp`.
2. **station 선정 알고리즘**: `tripMultiHop.ts`는 LA context 계산 전용 (역 선정 아님). `trip.waypoints`가 이미 shift된 잔여 waypoint 배열로 `stationName + line + kind`를 가짐. 다음 N=5 waypoints에서 stationName 추출 → Set으로 trip union dedup. `collectActiveStations`에서 `trip.waypoints.slice(0, N_STATION_LOOKAHEAD).map(w => w.stationName)` 패턴.
3. **arrivalsFromPositions vs fetchArrivals**: `readSelfPollPosition(kv, waypoint.line)` → positions → `arrivalsFromPositions.ts` 합성 → vanish-swap (`scheduled.ts:1993`). 이 path는 position-based이며 line 단위 KV를 읽음. 신규 station arrivals KV는 **별도 key prefix** (`selfPoll:station:<stn>`)로 분리하여 기존 positions path 보존. 신규 arrivals stamp는 device BFF 응답 목적 (추후 device wire-up 별도 PR).
4. **Seoul API rate limit**: N=5 stations × M=3 trips (겹침 고려 dedup) = 최대 10~15 station calls/cron. 현재 1~3 line calls 대비 증가하나, `SeoulArrivalClient` 내부 15s in-memory cache로 같은 역 2 trip이 공유 시 1회만 호출. Seoul 열린데이터 공식 rate limit 문서 없으나 line call(max 100 trains) → station call(max 10 arrivals) 대비 응답 크기 1/10 감소 — 부하 총량은 유사 이하.
5. **fallback path**: `fallback.ts`는 PENDING_PUSHES 기반 alert push fallback — 이 PR과 독립. 기존 `pollLinesAndStamp` path (positions 기반)는 그대로 유지. 신규 `pollStationsAndStamp`는 arrivals empty 시 빈 배열을 KV stamp (graceful — caller가 null로 자연 fallback). #1825는 worktree에 코드 참조 없음 — 독립적 PR로 이미 merged 가정.

## 7. Acceptance

- backend `selfPollPosition.test.ts` 갱신: station union polling 진입 + caller test
- `seoul.test.ts`: fetchArrivals 단위 호출 + KV station stamp 검증
- production 1주 측정:
  - `fusion-candidate-reject` 53/h → 5건/h 이하 (90% 감소 목표)
  - Seoul API call rate: lines union 1 call → stations N calls (rate 변동 측정)
  - 사용자 trip 정확도: nearest-station change 빈도 변동 없음 (회귀 0건)

## 8. Out of scope

- 옵션 D (graph-aware): Epic #1763 통합
- Seoul Open API rate limit 별 audit (Day 2 outage 자체)
- LA Interactive UI 강화

## 9. Wire-completion 5단

1. **Orphan**: station union polling caller 확인 + 새 KV key 사용처 wire 검증
2. **V/X dashboard**: backend log `selfPoll station` 카운터 + DebugModal `fusion-candidate-reject` 분포
3. **의존 PR**: #1825 (schedule fallback) 머지 의존 (graceful fallback 유지)
4. **측정 plan**: 1주 reject 53/h → 5/h + Seoul API call rate
5. **Device verify**: 실기기 trip 1건 — nearest-station 정상 회복, fusion-candidate-reject 분포 ↓

## 관련 메모리

- [[lesson_gps_drop_fusion_buffer_pollution]] fusionDebugBuffer 200 cap 사고
- [[reference_domain_naver_kakao_diff]] 네이버/카카오와 차별점
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- Epic #1763 자동 학습 (D 옵션 통합 후 follow-up)

## BG agent 위임 지시

### 작업 순서

1. SSoT plan 정독
2. audit 5건 (#6 Audit 필요 사항)
3. audit 결과 plan SSoT §6 갱신
4. fix 구현 (옵션 A) + acceptance 테스트
5. PR 본문에 audit 결과 + Wire-completion 5단

### 격리 규칙

- worktree 절대 경로 안에서만 작업
- 메인 repo는 다른 작업 중 — `tasks/plan-1828-...` 파일만 수정 가능
- worktree 내 plan 파일 commit 금지

### 자율 scope

- N (3~5) 결정 audit 결과로 자율
- KV stamp 단위 변경 (line → station) 결정
- Seoul API rate limit 우려 시 cap 조정
