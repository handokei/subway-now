# ADR-027 — Boarding 후보 정확도: line/direction은 확정값에서만

- **Status**: Proposed (2026-08-07)
- **Scope**: 클라이언트 Seoul API 직호출 경로(`SeoulOpenApiProvider`)만. BFF 경로는 현재 미사용(`EXPO_PUBLIC_USE_BFF` 미설정) → 대상 제외.
- **적대적 검증**: 초기안(slice 전 line 필터 + picker line 필터)만으론 HOLES-FOUND → 재정의

---

## Context

### 증상④
환승역 건대입구(2·7호선)에서 **2호선 탑승 후보 리스트가 비었고**, 다음역 성수 도착쯤에야 2호선 열차(2038)가 떴다. auto-lock 후보는 엉뚱하게 **7호선(7377)**.

### 검증이 밝힌 진짜 원인 (초기안 불충분)
1. **line 미확정**: origin fetch 시점 `approachLine`가 route/lock 미확정이면 fusion의 **임의 line 선택**(`approachLine.ts:8-11`, #797)으로 떨어짐 — 환승역서 7호선이 될 수 있음. 이 상태로 line 필터하면 line-2 리스트가 또 빈다(같은 증상, 다른 원인).
2. **fetch window**: `/0/10/` 전노선 10행(`arrivalApi.ts:106`). 환승역서 10행이 전부 7호선이면 slice 전에 line 필터해도 line-2가 0개.
3. **auto-lock line 미필터**: `directionalArrivals`가 direction만 필터(`useBoardingLockController.ts:266`), picker는 line 무관(`boardingPromptAutoLock.ts:32`). `allowedLines={2,7}`(`stationRoute.ts:174`)가 7377을 통과(`:484`) → 7호선 후보 선택.
4. **direction 미해결**: loop line 2에서 `resolveTripDirection` null(`tripDirection.ts:139`) → 잘못된 방향 열차 lock 가능.
5. **현장 2038은 이미 출발한 열차** — origin 응답에 없음. 이건 slice 수정이 아니라 **#2139 `usePrevTrainCandidate`(전열차 back-map) 소관**. ④는 "출발역 후보 truncation"을 고치는 것이고, "이미 떠난 열차 늦게 뜸"은 #2139 튜닝(별개).

---

## Decision

1. **line은 route/lock 확정값에서만 필터** — fusion의 임의 `station.line`로 boarding 후보를 필터/선택하지 않는다. 확정 전에는 필터하지 않고(누락 방지) 확정 후 필터.
2. **filter-before-slice + window 확대** — origin boarding-list 경로에서 line 필터를 `slice(0, maxPerDirection)` **이전**에 적용하고, 전노선 truncation 방지를 위해 fetch window를 확대(또는 per-line 확보). **단 cache invariant 보존** — `useArrivalInfo`의 line-independent 응답(`useArrivalInfo.ts:16-21`)과 일반 arrival 표시는 영향받지 않도록 boarding-list 경로에만 scope.
3. **auto-lock 후보에 line + direction 사전필터** — `directionalArrivals`/picker 진입 전 `approachLine`(확정) + destinationDirection으로 필터. loop line null-direction은 안전 처리(잘못된 방향 lock 금지).
4. **"이미 출발한 열차" 케이스는 #2139 소관 명시** — ④의 acceptance에서 제외, #2139 튜닝으로 분리.

---

## Consequences
- 수정: `arrivalApi.ts`(filter-before-slice + window, origin scope), `useBoardingLockController.ts`(approachLine/direction plumb + 필터), `boardingPromptAutoLock.ts`(line 인지), `approachLine.ts`(확정 여부 신호).
- 유지: `useArrivalInfo` cache invariant, 일반 arrival 표시, BFF 경로(미사용, 무변경).

## Trade-offs
- line 확정 전에는 필터 안 하므로(누락 방지) 확정 지연 구간에 타 노선 후보가 잠깐 섞일 수 있음 → direction 필터로 완화.
- window 확대 = 응답/렌더 소폭 증가.
- BFF 경로는 미수리 잔존 — 향후 활성 시 별도 이슈(문서화).

## Acceptance
1. **red replay fixture**: 건대입구에서 line-2 boarding 후보 > 0 + auto-lock 후보 line=2(7377 아님). 현재 red.
2. field verify: 환승역 탑승 시 출발역에서 정노선 후보 표시(이미 떠난 열차 제외).
