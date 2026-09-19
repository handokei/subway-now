# Plan #1836 — Phase 6.1: 지하 cold start + 후보 선택 UI (단독 사용자 모드)

**SSoT**: 본 문서. audit 결과 BG agent 자율 갱신.

**작성 원칙**: max effort 원인 분석 + 문제 파악 + 해결 방안 + 트레이드오프. 앱 다운로드 가치 중심.

---

## 1. 앱 다운로드 가치 (사용자 관점)

### 사용자가 우리 앱을 다운로드하는 이유

1. **지하철 도착 알림** — "내릴 역 임박했어"
2. **매역 알림** — 잠금 화면/홈위젯에서 진행 확인
3. **환승 안내** — 환승 시점에 알림
4. **trip 종료 알림** — 도착 시 알림

### 현재 실패 케이스 (사용자 frustration evidence)

| 시나리오 | 현재 동작 | 사용자 가치 |
|---|---|---|
| 지상 + 의향 명시 | ✅ 작동 | 95% |
| 지상 lockless | 부분 | 70~85% |
| 지하 cold start + 의향 명시 (boardingPrompt 응답) | ✅ 작동 | 95% |
| **지하 cold start lockless + 5G/LTE** ★ | **❌ chain 시작 불가** | **0~30%** |
| **late start (이미 train 안)** | **❌ 시작점 모름** | **0~30%** |
| Route 변경 (자동) | 부분 | 30~50% |

### 가장 critical 갭

★ **지하 cold start + lockless** — 사용자가 boardingPrompt 응답 안 하면 chain 시작 자체 불가. 사용자 frustration 핵심 원인.

→ 본 Phase 6.1이 직접 해소.

---

## 2. 문제 (Production evidence)

### Day 2 dump 직접 evidence

```
## Silent Push
received=0 (last (never))

## Environment Distribution
unknown=100.0%

## Boarding Prompt Acceptance
displayed=0, responded=0, boarded=0
```

→ 35분 trip 동안 device가 위치 파악 0건 + chain 시작 0건.

### 우리 코드의 reject 메커니즘

`src/features/nearest-station/hooks/useNearestStation.ts`:
```ts
if (accuracy > 50m) {
  // movement-low-accuracy suppress
  // → fusion candidate 평가 자체 skip
}
```

지하 + WiFi 없음 (5G/LTE) 환경에서 iOS가 반환하는 위치 정확도는 300~1000m. 50m 게이트 초과 → 우리가 위치 자체를 reject → chain 시작 불가.

### 비교 — 네이버/카카오는 작동

| 앱 | 정확도 요구 | 사용자 경험 |
|---|---|---|
| 네이버 지도 | 100~500m OK | "여기쯤" 점 표시. 사용자가 시각적 인지 |
| 카카오맵 | 동일 | 동일 |
| Citymapper | 노선 + 역 수동 선택 | 사용자 명시 |
| **우리 (현재)** | **50m 이하만** | **지하에서 위치 모름** |

차이: **알림 발사 vs 지도 표시 use case**. 우리는 자동 알림 발사라 정확도 prereq 높음. 그런데 cold start 시작점은 알림 발사 prereq가 아님 — 정확도 완화 가능.

---

## 3. 원인 분석

### 근본 원인 1 — 단일 정확도 게이트

```
현재: accuracy ≤ 50m → 모든 path 허용 (시작점 선택 + 알림 발사)
       accuracy > 50m → 모든 path reject

문제: 시작점 선택은 50m 게이트 필요 없음 (사용자 명시 선택 prereq)
      알림 발사는 50m 게이트 정합 (자동 결정 prereq)
```

### 근본 원인 2 — boardingPrompt cold start trigger 없음

backend boardingPrompt cron이 motion + ETA + environment 종합 평가해서 표시. 그런데:
- motion 평가는 5~10분 lag (CMMotionActivity)
- ETA 평가는 GPS 정확도 필요
- 지하 cold start 직후에는 둘 다 부족 → boardingPrompt 표시 0건

device 측에서 cold start 직후 즉시 표시할 path 부재.

### 근본 원인 3 — 후보 선택 UI 없음

현재 boardingPrompt는 "단일 train code 표시 + Y/N". **다중 station 후보 선택 UI 없음**.

지하 cold start 후 500m 반경 5개 station이 후보일 때 사용자가 선택할 UI가 없어서 자동 매칭 prereq.

### 근본 원인 4 — 시간표 후보 narrow 자동 wire 안 됨

`scheduleFallback.ts` 부분 존재. 그런데 cold start 시점에:
- "현재 시각 + 운행 line + 가능 trip 후보" narrow down 자동 wire 없음
- 사용자가 직접 노선 선택 또는 검색 fallback도 없음

### 근본 원인 5 — 즐겨찾기 / historic 활용 wire 안 됨

`useAppStore`에 즐겨찾기 / destination 저장. 그런데 cold start 후보 narrow에 활용 wire 0.

---

## 4. 해결 방안 — 4 옵션 (false binary 차단)

### A. ★ Cold start 전용 path 추가 (채택 후보, 단독 사용자 모드)

```
지하 cold start 감지 (별 path):
  1. GPS 정확도 > 50m + barometer "지하" 분류
     또는 첫 GPS fix가 50m 이상 + 사용자 trip 시작 시점
  ↓
  2. 정확도 500m 반경 안 station 후보 추출
  ↓
  3. 환승 호선 dedup (stnName 기준)
  ↓
  4. 후보 narrow 보조 신호 weighted:
     - 시간표 (운행 중 line만)
     - barometer (지하/지상 분류)
     - 즐겨찾기 (사용자 historic)
     - 이전 trip 종료 지점 (최근 7일)
  ↓
  5. 후보 분기:
     - 1개 → 자동 boardingPrompt "X역에서 탔어요?" Y/N
     - 2~5개 → 다중 station 선택 UI (목록)
     - 6개+ → 노선 검색 fallback
  ↓
  6. 사용자 선택 → 시작점 확정 → chain 시작
```

device-local 데이터로만 작동. backend 의존 X.

### B. Backend 통합 cold start trigger

backend cron이 cold start 사용자 감지 → silent push로 boardingPrompt 표시 trigger.

- 장점: 자동 trigger
- 단점: silent push 의존 (Day 2 evidence received=0). 사용자 5G/LTE에서 보장 X.

### C. 정확도 게이트 완화 (전체)

`accuracy ≤ 200m`으로 완화. 알림 발사도 허용.

- 장점: 코드 변경 최소
- 단점: false fire 폭증 위험. paradigm 정신 위반.

### D. 노선/역 수동 입력 (Citymapper 패턴)

사용자가 매번 출발역 + destination 선택. 자동 추정 X.

- 장점: 정확도 100%
- 단점: UX ↓ (매번 입력). 우리 차별점 ↓.

---

## 5. 트레이드오프

| 옵션 | 정확도 | UX | 코드 복잡도 | paradigm 정합 | device 의존 |
|---|---|---|---|---|---|
| A (cold start path + 후보 선택) | 80~90% (후보 narrow 의존) | ★★ (선택 1회) | 중간 | ✅ | device-only |
| B (backend trigger) | 70~80% (silent push 의존) | ★★★ (자동) | 큼 | ✅ | backend 필수 |
| C (게이트 완화) | 50~70% (false fire ↑) | ★★ (자동 but 오류) | 작음 | ❌ false fire | device-only |
| D (수동 입력) | 100% | ★ (매번 입력) | 작음 | ✅ | device-only |

### A vs B 비교 (가장 합리적 두 옵션)

| 측면 | A | B |
|---|---|---|
| Day 2 evidence (silent push received=0) | 영향 X | **영향 직격** — 작동 보장 X |
| 5G/LTE 사용자 | 작동 | 작동 보장 X |
| backend outage 시 | 작동 | 작동 X |
| 학습 곡선 | 1회 선택 후 자동 | 자동이지만 안 뜸 |
| **frustration 해소** | **직접** | 부분 |

→ **A 채택** (단독 사용자 모드 = device-only).

### A 옵션의 트레이드오프

| 측면 | trade-off |
|---|---|
| 후보 narrow 정확도 | 시간표 + barometer + 즐겨찾기로 1~3개 narrow 가능 (사용자 N명일 때 cell ID 매핑 추가 정확도 ↑) |
| 사용자 부담 | 1회 선택 (cold start 시). 이후 자동 |
| Edge case (6개+ 후보) | 노선 검색 fallback. 모호 시 사용자에게 책임 위임 |
| 잘못된 선택 (오선택) | accelerometer fingerprint 진행 중 mismatch 감지 → 재확인 prompt |

---

## 6. 결정

**채택: A — Cold start 전용 path + 후보 선택 UI (단독 사용자 모드)**

이유:
1. Day 2 evidence (silent push received=0) 영향 X — device-only 작동
2. 5G/LTE 사용자 frustration 직접 해소
3. paradigm 정신 정합 — 사용자 명시 의향 prereq
4. 단독 사용자 모드 (사용자 1명 환경에서도 작동)
5. 후속 Phase 6.2 (D1 collaborative)로 정확도 추가 향상 가능

### 구현 priority

```
Sub-step 1 (P0, 1 PR): Cold start 감지 + 정확도 분기 게이트
Sub-step 2 (P0, 1 PR): 후보 station 추출 + 환승 호선 dedup
Sub-step 3 (P1, 1 PR): 시간표 + barometer + 즐겨찾기 weighted narrow
Sub-step 4 (P1, 1 PR): 다중 station 선택 UI (boardingPrompt 확장)
Sub-step 5 (P2, 1 PR): 진행 중 mismatch 감지 + 재확인 prompt
```

→ 5 sub-step 분할. 큰 작업이라 BG agent 1개씩 직렬.

본 PR은 **Sub-step 1+2 통합** — cold start 감지 + 후보 추출 (UI는 별 PR로).

---

## 7. Acceptance

### Sub-step 1+2 (본 PR)

- `src/features/nearest-station/hooks/useColdStartCandidates.ts` 신규
- cold start 감지 조건:
  - 첫 GPS fix accuracy > 50m
  - barometer "지하" 또는 environment=unknown
  - 사용자 trip 없음 (active trip 0)
- 후보 추출:
  - GPS 위치 ± 500m 반경
  - 환승 호선 dedup (stnName)
  - 결과: `ColdStartCandidate[]` 배열
- 테스트:
  - 지하 cold start fixture → 후보 추출 동작
  - 환승 호선 dedup 동작 (왕십리 2/5/분당 → 1개)
  - 정확도별 후보 개수 (50m: 1개, 200m: 2~4개, 500m: 3~6개, 1km+: 6+개)

### Out of scope (별 PR)

- Sub-step 3 (시간표 + barometer + 즐겨찾기 narrow)
- Sub-step 4 (다중 선택 UI)
- Sub-step 5 (mismatch 감지)

---

## 8. Wire-completion 5단

1. **Orphan**: `useColdStartCandidates` + caller (HomeScreen / TripScreen 등) wire 검증
2. **V/X dashboard**: DebugModal에 "Cold Start Candidates" 섹션 추가 — 후보 개수 + narrow 결과 가시화
3. **의존 PR**: PR #1835 (D1 도입) 머지 후 진행 — D1 schema에 cold start metric 적재 wire 가능
4. **측정 plan**: Day 3+ trip 시 cold start 감지 + 후보 개수 분포 1주 측정
5. **Device verify**: 실기기 지하 cold start trip 1건 — 후보 추출 + UI 동작 확인 (Sub-step 4 후)

---

## 9. 시장/학술 evidence

| 앱 | cold start 처리 | 우리 비교 |
|---|---|---|
| Citymapper | 노선 + 역 수동 입력 (옵션 D) | Sub-step 4와 유사 fallback |
| Google Maps Transit | GPS 정확도 ↓ 시 노선 검색 | 동일 |
| 네이버 지도 | 지도 표시만 (알림 X) | use case 다름 |
| Transit App | accelerometer fingerprint (학술 90%) | Phase 6.2~6.3 통합 후보 |

→ 우리 옵션 A는 시장 best practice + paradigm 정신 정합.

---

## 10. Audit 결과 (2026-06-26 BG agent 완료)

1. **정확도 게이트 위치**: `useNearestStation.ts:382` — watch callback에서 `!isAccuracyAcceptableForDisplay(accuracy)` 시 early return. 지하에서 accuracy=300~1500m → `MAX_ACCURACY_M_DISPLAY=250m` 초과 → GPS 자체를 drop → chain 시작 불가. `useNearestStation`은 수정하지 않는다.

2. **trigger 위치 결정**: 별 hook `useColdStartCandidates.ts` — `useNearestStation`의 반환값 (`gps`, `environment`, `hasTrip`)을 입력으로 받음. 기존 hook 미수정 (surgical change 원칙).

3. **반경 추출 효율**: O(533) iterate + haversine. cold start는 one-shot (폴링 아님) → spatial index 불필요. `extractColdStartCandidates` 순수 함수로 분리.

4. **dedup 기준 확정**: 정규화 함수 `normalize(name)` — 후행 `(...)` 제거. `groupStationsByName.ts`와 동일 로직. "왕십리(성동구청)" × 3 + "왕십리" × 1 → key="왕십리" → 1개 그룹. 실증: `extractColdStartCandidates(37.561827, 127.038352)` → candidates.length=1.

5. **ColdStartCandidate 데이터 모델**:
   ```ts
   interface ColdStartCandidate {
     stationName: string;        // 정규화 이름
     lines: readonly LineNumber[]; // 환승 호선 목록
     distanceKm: number;         // 가장 가까운 entry까지 거리
     lat: number;                // 가장 가까운 entry 위도
     lng: number;                // 가장 가까운 entry 경도
     stations: readonly Station[]; // 전체 entry (Sub-step 4 UI용)
   }
   ```

6. **D1 metric wire**: `useColdStartCandidates` 반환값(`ColdStartCandidate[] | null`)을 호출자가 받아 candidates 길이 등을 D1에 적재. 별 PR (Sub-step 4 이후). 본 PR에서는 candidates 배열만 산출.

### IGNORE_PATTERN 갱신

`scripts/check-orphan-exports.sh`에 `useColdStartCandidates\.ts` 추가. Sub-step 4 caller가 별 PR이므로 의도적 entry-point로 등록.

---

## 11. 관련 메모리

- [[feedback_user_intent_equal_protection]] paradigm — 사용자 명시 의향 = chain 시작 prereq
- [[feedback_device_self_contained_fusion]] device self-contained
- [[reference_ios_wifi_api_constraint]] 5G/LTE 사용자 wifi 미연결 한계
- [[lesson_motion_activity_intermittent_signal]] CMMotionActivity 5~10분 lag
- [[reference_subway_accelerometer_market.md]] Transit App 90% / 시장 사례
- [[reference_domain_naver_kakao_diff]] 네이버/카카오 차별점
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- Plan #1835 D1 도입 (의존 prereq)

---

## 12. BG agent 위임 지시

### 작업 순서 (본 PR — Sub-step 1+2)

1. SSoT plan 정독
2. audit 6건 (#10)
3. plan SSoT §10 갱신
4. `useColdStartCandidates.ts` 신규
5. cold start 감지 + 후보 추출 + dedup 구현
6. acceptance 테스트
7. PR 본문에 audit 결과 + Wire-completion 5단

### 격리 규칙

- worktree 절대 경로만, parent 이동 금지
- 메인 repo `tasks/plan-1836-...`만 수정 가능

### 자율 scope

- 정확도 분기 게이트 위치 결정 (`useNearestStation` 분기 vs 별 hook)
- 500m 반경 추출 알고리즘 (단순 iterate vs spatial index)
- ColdStartCandidate 데이터 모델
- 환승 호선 dedup 정확한 정책 (stnName vs canonical)

### Out of scope (Sub-step 3~5는 별 PR)

- 시간표/즐겨찾기 weighted narrow (Sub-step 3)
- 다중 station 선택 UI (Sub-step 4)
- mismatch 감지 (Sub-step 5)
