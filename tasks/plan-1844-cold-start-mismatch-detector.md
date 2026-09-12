# Plan #1844 — Phase 6.1 Sub-step 5: Cold Start Mismatch Detector

## §1 목적 / 사용자 가치

cold start 선택 오류를 사용자가 지속 탑승 중에 자동으로 감지해 재확인 기회를 준다.

- **수혜자**: cold start 환경(지하·GPS 약)에서 잘못된 역을 선택한 사용자
- **가치**: 잘못된 출발역 기준 알람이 계속 발사되는 것을 조기 차단 → 정확도 게이트 유지
- **ADR-010 동급 원칙**: 사용자 명시 의향 trip(boardingPrompt 응답)은 lock 활성과 동급 정확도 보장

---

## §2 설계 원칙

1. **false positive 우선 방어**: mismatch 1~2회 flicker로 재확인 트리거 금지 — 연속 N회 일치 실패 조건
2. **한 번 일치 → reset**: 일치 판정이 나오면 해당 reason 카운터를 0으로 초기화 (bouncing 방지)
3. **pure hook**: 감지 로직은 순수 함수 + useRef 카운터. side effect 없음
4. **alarmLog 측정**: mismatch 적재로 1주 production 빈도 측정 가능

---

## §3 Mismatch Reason 정의

| Reason | 감지 조건 | 연속 임계 |
|--------|-----------|-----------|
| `route-diverged` | lock.boardingLine의 arc station 위치가 observed 현재역보다 3 hop 이상 벗어남 | 3회 연속 |
| `line-mismatch` | lock.boardingLine ≠ observed(fusedResult) station.line | 3회 연속 |
| `environment-mismatch` | lock boarding station.environment='underground' + observed environment='surface' | 3회 연속 |

**한 번 일치 → reset**: 각 reason마다 독립 카운터. 일치 판정이 나오면 해당 카운터=0.

---

## §4 Hook 인터페이스

```ts
// src/features/nearest-station/hooks/useStationMismatchDetector.ts

export type MismatchReason =
  | 'route-diverged'   // arc 위치 3 hop 초과 이탈
  | 'line-mismatch'    // 관측 노선 ≠ lock 노선
  | 'environment-mismatch'; // 지하 선택 + 지상 관측

export interface StationMismatchResult {
  /** mismatch 감지 여부. false일 때 다른 필드는 의미 없음. */
  detected: boolean;
  /** mismatch 사유. detected=false 시 null. */
  reason: MismatchReason | null;
}

export interface UseStationMismatchDetectorInput {
  /** 현재 진행 중 lock. null이면 감지 비활성. */
  boardingLock: BoardingLock | null;
  /** useFusedNearestStation 결과 현재역. null이면 감지 비활성. */
  fusedResult: NearestStationResult | null;
  /** 현재 arc(탑승~waypoint). 빈 배열이면 route-diverged 감지 비활성. */
  arcStations: readonly Station[];
  /** 현재 추정 hop index. null이면 route-diverged 감지 비활성. */
  currentHopIndex: number | null;
  /** 환경 분류. environment-mismatch 감지용. */
  environment: Environment;
}
```

---

## §5 감지 알고리즘

### 5.1 line-mismatch

```
if (lock.boardingLine !== fusedResult.station.line)
  lineMismatchCount++
else
  lineMismatchCount = 0
detected = lineMismatchCount >= LINE_MISMATCH_THRESHOLD
```

### 5.2 environment-mismatch

```
lockBoardingEnv = lock boarding station 조회 (stationLookup by id + line)
if (lockBoardingEnv === 'underground' && observed === 'surface')
  envMismatchCount++
else
  envMismatchCount = 0
detected = envMismatchCount >= ENV_MISMATCH_THRESHOLD
```

### 5.3 route-diverged

```
if (arcStations.length > 0 && currentHopIndex !== null) {
  expectedIdx = nearest arc idx matching fusedResult.station.id
  if (expectedIdx === -1 || |expectedIdx - currentHopIndex| > ROUTE_DIVERGE_HOP_THRESHOLD)
    routeDivergedCount++
  else
    routeDivergedCount = 0
  detected = routeDivergedCount >= ROUTE_DIVERGE_THRESHOLD
}
```

### 5.4 우선순위

`route-diverged` > `line-mismatch` > `environment-mismatch` 순서로 첫 번째 detected reason 반환.

---

## §6 상수

| 상수 | 값 | 의미 |
|------|-----|------|
| `LINE_MISMATCH_THRESHOLD` | 3 | 3회 연속 노선 불일치 |
| `ENV_MISMATCH_THRESHOLD` | 3 | 3회 연속 환경 불일치 |
| `ROUTE_DIVERGE_THRESHOLD` | 3 | 3회 연속 arc 이탈 |
| `ROUTE_DIVERGE_HOP_THRESHOLD` | 3 | arc 위 ±3 hop 이탈 |

---

## §7 caller wire (HomeScreen)

```tsx
// src/screens/HomeScreen.tsx 또는 trip controller
const mismatch = useStationMismatchDetector({
  boardingLock: lock,
  fusedResult: result,
  arcStations,
  currentHopIndex,
  environment,
});

{mismatch.detected && (
  <ActionBanner
    accent={colors.warning}
    actionLabel="재선택"
    onActionPress={onTriggerReselect}
    testID="mismatch-banner"
    actionTestID="mismatch-banner-action"
  >
    <Text>출발역이 맞지 않습니다. 현재 위치를 다시 선택해 주세요.</Text>
  </ActionBanner>
)}
```

Sub-step 4 picker 미머지 시 fallback: 재선택 탭 시 useBoardingPromptResponder reset + trigger.

---

## §8 테스트 매트릭스

### 8.1 감지 비활성 (null guard)
- lock=null → detected=false
- fusedResult=null → detected=false

### 8.2 line-mismatch
- 노선 일치 → 감지 없음
- 1~2회 불일치 → 아직 감지 없음
- 3회 연속 불일치 → detected=true, reason='line-mismatch'
- 2회 불일치 후 1회 일치 → reset → 감지 없음

### 8.3 environment-mismatch
- underground 선택 + surface 3회 연속 → detected=true
- surface 선택 → 감지 없음 (지상 선택은 정상)
- underground 선택 + underground 관측 → 감지 없음
- 2회 surface 후 1회 underground → reset

### 8.4 route-diverged
- arc 없음 → 감지 비활성
- arc 위 ±3 hop 이내 → 감지 없음
- arc 밖 (arc idx 없음) 3회 → detected=true
- 2회 이탈 후 1회 일치 → reset

### 8.5 우선순위
- route-diverged + line-mismatch 동시 → reason='route-diverged'

### 8.6 alarmLog 적재
- detected 직후 appendAlarmLog 1건 (dedup 60s)

---

## §9 Wire-completion 체크

1. **Orphan**: useStationMismatchDetector → HomeScreen caller 반드시 wire
2. **V/X dashboard**: alarmLog reason='cold-start-mismatch' → `/admin/alarm-log-stats` 집계
3. **의존 PR**: #1838 (Phase 6.1 Sub-step 1+2 머지). Sub-step 3/4와 독립 가능
4. **측정 plan**: 1주 trip에서 mismatch 감지 비율 ≤5% 목표 (FP 차단 지표)
5. **Device verify**: 의도적 오선택 trip 1건 — 재확인 배너 표시 확인
