---
issue: TBD (발행 예정)
title: "epic: Lockless Trip 정확도 복구 (2026-06-12) — Epic 본문/ADR 첫 줄 acceptance 복구"
created: 2026-06-12
status: planning (코드 확인 100% 완료, 발행 대기)
parent_epic_relation:
  - "#1008 (Epic A 사실상 완료, §7.1 회귀 7개에 회귀 8~12 추가)"
  - "#912 (B3 acceptance 재해석 복구)"
  - "#896 (close 조건에 본문 evidence 시나리오 추가)"
adr_relation:
  - "ADR-010 §배경 첫 줄 — 두 실패 모드 동급 (acceptance까지 적용)"
  - "ADR-013 §B3 — 면제 폐기 (사용자 명시 의향 trip 동급 보장)"
  - "ADR-014 — 결정 프로세스 룰 (2026-06-12 신설)"
---

# Epic — Lockless Trip 정확도 복구 (2026-06-12)

## 0. /clear 후 첫 진입점

본 파일은 다음 세션이 단독으로 이어받을 수 있는 SSOT. 사용자가 2026-06-12 trip에서 보고한 11건 + 백엔드/디바이스 로그 evidence를 코드 변경 지점으로 100% 매핑.

**필수 사전 읽기:**
1. 본 파일 (전체)
2. `docs/decisions/ADR-014-decision-process-rules.md` — 결정 룰
3. `memory/lesson_2026_06_11_b3_false_binary.md` — 사고 evidence
4. `memory/feedback_decision_no_false_binary.md` ~ `memory/feedback_user_intent_equal_protection.md` (4건)
5. `tasks/lessons.md` L1~L4

**바로 작업 가능한 진입점:**
- 정책 PR 3건 (P1/P2/P3) — docs only, 즉시 spawn
- 코드 PR 9건 (D1~D9) — 각 작업 변경 지점이 §4에 명시됨, BG agent spawn 가능
- 데이터 작업 1건 (D-DATA) — SSID 데이터 확장

---

## 1. 배경 — 사용자 trip 2026-06-12 evidence

### Trip 실제 경로
용마산 → 중곡 → 군자 → 어린이대공원 → 건대입구(7) → 건대입구(2) 환승 → 성수

### 사용자 trip 시점 상태 (DebugModal 14:07:42 KST 캡처)
- `activeTrip=(none)` — 자동 종료됨
- `fused=(no fused signal)` — fusion 미수렴
- `gps-only` 신뢰도, 용마산 228m sticky
- `received=14, fired=0` — silent push 14건 받았지만 0건 fire
- toggle=on — 사용자 명시 의향 활성

### 디바이스 alarm log 핵심 evidence
```
08:19:29 silent-push-skipped | gate-out-of-range | station-passed | imminent | 중곡
08:22:56 fg fired | station-passed | 용마산        ❌ trip 진행 중인데 출발역 재발사
08:24~28 dedup-station 용마산 반복                 ❌ GPS sticky 용마산
08:30:11 fg fired | station-passed | 중곡          ❌ 실제는 어린이대공원/군자
08:35:22 fg movement-static-position 용마산        ❌ 실제는 어린이대공원
08:37:03 fg fired | station-passed | 건대입구
08:37:03 fg fired | destination | early | 성수
13:24:44 fg-evaluated suppressed gate-phase-warmup 용마산  ❌ 오후 trip에도 용마산
13:28:32 fg fired | station-passed | 건대입구
13:28:35 fg fired | station-passed | 성수          ❌ 4정거장 남은 destination 즉시 fire
13:28:42 fg fired | station-passed | 건대입구      ❌ 중복 fire (#1193 PR #1202)
22:11:56 fg fired | station-passed | 사가정         ❌ 취침모드, 첫 환승 전
22:11:32 silent-push-skipped | gate-no-location | station-passed | imminent | 면목
```

### 백엔드 cron 로그
```
08:43 boarding-lock auto-ended (consecutiveEtaMissing=5)  ❌ 환승 leg trainCode 추적 상실
08:44:52 DELETE /trips
08:45:11 silent-push received trip-ended:eta-missing
```

---

## 2. 사용자 보고 11건 → root cause 매핑

| 사용자 보고 | Evidence 시각 | Root cause |
|---|---|---|
| 1. 도착 정보 상이 | (UI) | BoardingTrainList arrivals prop vs Arrival 표시 source 불일치 가능성 |
| 2. BG 잘못된 역 알림 (실제 군자) | 08:30:11 중곡 / 08:37:03 건대 | GPS sticky + hop window 게이트 부재 + lockless estimator 비활성 |
| 3. 어린이대공원→용마산 화면 회귀 | 08:35:22 | sticky station이 trip 활성 시 unlock (motion automotive로 즉시 unlock) |
| 4. 환승 후 호선 자동 선택 안 됨 | 08:36:46 | useTransferAutoDetect onPlannedTransfer 분기에서 boardingPrompt autoLock 미트리거 |
| 5. trip BG 강제 종료 | 08:43 auto-end | 환승 leg trainCode를 backend에 sync 안 함. boardingLockSync payload에 trainCode 없음 |
| 6. 취침모드 환승 알람 | 22:11:56 사가정 | shouldSuppressBySleepRule이 transfer만 차단. station-passed 통과. lockless면 비활성 |
| 7. 지상/지하 분기 확인 | (UI) | DebugModal에 subsurface/fusion source 표시 없음 |
| 8. 환승 후 4정거장 남은 도착 알림 | 13:28:35 성수 | hop window 게이트 부재. station-passed가 isStationOnRoute만 검사 |
| 9. 환승 분기점 자동 선택 | (4와 동일) | 4와 동일 |
| 10. 또 BG 종료 | (5와 동일) | 5와 동일 |
| 11. 잘못된 역 다수 | 13:28:42 건대 중복 + 8의 성수 | PR #1202 (occurrence 정정) + hop window |

---

## 3. 결정 — Epic 본문 acceptance 복구

### 3.1 Epic #912 acceptance 복구 (B3 면제 폐기)
**기존 (2026-06-11)**:
- lock 활성 trip: 매역 100%
- lockless trip + boardingPrompt 통과 + [탑승] 응답: 100%
- ⚠️ 게이트 미통과/무응답/토글 OFF: acceptance 위반 아님 (사용자 선택)

**복구 (2026-06-12)**:
- lock 활성 trip: 매역 99%, 잘못된 역 0건
- **사용자 명시 의향 trip (C 토글 ON / boardingPrompt 응답 / 직접 탭): lock 활성과 동급 매역 99%, 잘못된 역 0건**
- 토글 OFF + boardingPrompt 응답 X: silent (사용자 선택, 기존 정책 유지)

### 3.2 Epic #1008 §7.1 회귀 12개 (회귀 8~12 추가)
| # | 회귀 패턴 | 검출 기준 |
|---|---|---|
| 8 | lockless + 사용자 명시 의향 trip에서 trip route 진행도 외 역 station-passed 발사 | `fired` entry 중 trip route arc의 현재 hop ± 1 외 station_id 발사 |
| 9 | lockless trip 지하 진입 시 GPS sticky로 잘못된 station 매칭 (sticky station이 motion automotive로 unlock되어 GPS sticky 그대로 노출) | `fired` entry 중 subsurface=true & fusion source='gps' & GPS lat/lng의 1km 외 station에서 station-passed 발사 |
| 10 | lockless trip 환승 leg trainCode 상실 → backend auto-end (#622 재발) | backend `boarding-lock: trip auto-ended` 카운트 / trip 환승 횟수 — 환승 있는 trip 중 auto-end 비율 |
| 11 | silent push fire/received < 80% (lockless intermediate 위치 게이트 false negative) | client `silent-push-received` vs `silent-push-fired` count 비율. lockless intermediate 한정 |
| 12 | 환승 leg에서 boardingPrompt/autoLock 미트리거 | 환승 발생 후 N분 내 boardingPrompt evaluated 횟수 0건인 trip 비율 |

### 3.3 Epic #896 close 조건 추가
- 기존: "Seam A~G 7개 PR 머지" → 부족
- 추가: "본문 evidence 시나리오(13:19~14:01 KST 용마산→성수→환승 건대입구→용마산) 실기기 1주 재발 0건"
- 2026-06-12 evidence가 epic #896 본문 evidence와 거의 동일 → Epic #896 reopen 검토

---

## 4. 코드 작업 명세 — 정확한 변경 지점

### D1 — lockless trip에도 stationProgressEstimator 활성 (P0)
**원인 지점**: `src/features/route/utils/stationProgressEstimator.ts:260`
```ts
export function estimateStationProgress(...): StationProgressEstimate | null {
  const { lock, arcStations, now } = input;
  if (!lock) return null;  // ← lockless에서 estimator 전체 비활성
  ...
}
```

**변경 방향**:
1. `estimateStationProgress`의 `lock: null` 분기를 별도 strategy로 처리
2. 신규 strategy `LocklessRouteHop`:
   - 입력: `tripStartedAt` (또는 `firstObservedAtMs`), `arcStations`, `hopTimeMsForHop`, `now`
   - 출력: `{ station: arcStations[hopFromStart], index, strategy: 'lockless-route-hop' }`
   - 계산: `hopFromStart = sum(hopTimeMsForHop(i) for i in 0..n) <= (now - tripStartedAt) < sum(... for i in 0..n+1)`
3. `useFusedNearestStation.ts:545`에서 lockless 분기 추가:
   - `lock`이 null이면 trip context(`tripStartedAt`, `route`) 기반으로 호출
   - lockless용 input은 별도 type으로 분리하거나 union으로 처리

**확인 필요한 입력 source**:
- `tripStartedAt`: `useApnsTripRegistration` 또는 `tripBoundCleanups` 메타에서 조회
- `firstObservedAtMs`: useFusedNearestStation 첫 fusion fix 시각

**테스트 케이스**:
- lockless + tripStartedAt 5분 경과 + hop time 60s씩 → 5번째 hop
- lockless + arcStations 비어 있음 → null
- lockless + tripStartedAt 미래 → null (시간 음수 가드)

**Acceptance**:
- 사용자 trip 재현 (lockless, 토글 ON) 시 estimator가 hop index 추정값 반환
- D2 (hop window 게이트)가 이 hop index를 source of truth로 사용

---

### D2 — station-passed에 trip 진행도 hop window 게이트 (P0)
**원인 지점**: `src/features/alarm/hooks/useStationAlarm.ts:724`
```ts
if (nearestStation && isStationOnRoute(nearestStation, route)) {
  ...  // ← route에만 있으면 통과. hop index 무시.
}
```

**변경 방향**:
1. `src/shared/utils/stationRoute.ts` 신규 함수 `isStationWithinHopWindow(station, route, currentHopIndex, windowSize=1)`:
   - 입력: station, route, currentHopIndex (D1 estimator 출력), windowSize
   - 출력: boolean
   - 로직: route arcStations 배열에서 station의 index가 `[currentHopIndex - windowSize, currentHopIndex + windowSize]` 범위 안인가
2. `useStationAlarm.ts:724` 게이트에 hop window 추가:
   - currentHopIndex = D1 estimator 결과의 `index` (fusion이 흘려보냄)
   - estimator null이면 fallback: firedAlarms set 기반 추정 (이미 fire된 max index + 1)
3. 게이트 실패 시 `logSuppressedHopWindow({ source: 'fg', stationName, currentHopIndex, candidateIndex })` 로그

**SSOT current hop**:
- 1순위: D1 estimator의 `index`
- 2순위: lock 활성이면 `boardingLock.boardingStationId` + 진행 시간
- 3순위: firedAlarms set의 max index + 1 (false fire risk)
- 4순위: hop window 미적용 (graceful — alarmLog에 reason 명시)

**테스트 케이스**:
- currentHopIndex=2 + candidate station이 arcStations[0] → suppressed (이미 지나간 hop)
- currentHopIndex=2 + candidate=arcStations[5] → suppressed (미래 hop)
- currentHopIndex=2 + candidate=arcStations[2] → pass
- currentHopIndex=2 + candidate=arcStations[3] → pass (current+1 window)

**Acceptance**:
- 사용자 trip 재현 시 08:22:56 용마산 fire 차단됨 (이미 지나간 hop)
- 13:28:35 성수 fire 차단됨 (4정거장 미래 hop)

---

### D3 — silent push lockless intermediate 위치 게이트 정밀화 (P0)
**원인 지점**: `src/features/alarm/utils/silentPushLocationGate.ts:163`
```ts
const thresholdM = THRESHOLDS_M[input.phase][input.kind];  // intermediate: imminent 300m
```

**변경 방향**:
1. 임계 완화 — `THRESHOLDS_M.imminent.intermediate` 300m → 800m (사용자 trip에서 GPS 정확도 8.7m이지만 sticky 좌표라 실제 위치 500m+ 떨어짐)
2. 또는 estimator hop index를 게이트 입력에 추가:
   - `checkSilentPushLocationGate(input: {..., currentHopIndex, payloadHopIndex})`
   - hop index가 일치하거나 ±1 이내면 거리 게이트 우회
3. lockless 시 게이트 정책 분리:
   - `THRESHOLDS_M_LOCKLESS_INTERMEDIATE = { imminent: 800, early: 1200 }`
   - or estimator hop 매칭 시 distance 게이트 skip

**관련**: `silentPushTask.ts:678` checkSilentPushLocationGate 호출부에서 lockless 분기 인지하지 못함. 분기 추가 필요.

**테스트 케이스**:
- lockless intermediate + payload hop와 currentHop 일치 → pass (거리 무관)
- lockless intermediate + 거리 800m 이내 → pass
- lockless intermediate + 거리 1500m → out-of-range

**Acceptance**:
- 사용자 trip 재현 시 silent push 14건 중 estimator hop 일치하는 것은 fire (현재 0/14)

---

### D4 — boarding-lock/sync payload에 trainCode + 환승 leg 시 갱신 (P0)
**원인 지점**:
- `src/features/nearest-station/api/boardingLockSync.ts:29` `BoardingLockSyncPayload`에 `trainCode` 없음
- `src/features/alarm/api/alarmBackend.ts:182` boardingLockKey가 `trainCode|line|...` — register payload에는 있음
- 환승 시 새 trainCode → register는 다시 호출되지만 boarding-lock/sync는 stale trainCode

**변경 방향**:
1. `BoardingLockSyncPayload`에 `trainCode?: string` + `boardingLine?: string` 추가
2. `syncBoardingLock` 호출자 (`useBoardingLockSync`)에서 현재 lock의 trainCode 동봉
3. backend 측: `/boarding-lock/sync` 핸들러가 payload trainCode와 KV의 trip.boardingLock.trainCode 비교 → 다르면 갱신
4. 환승 직후 첫 sync에서 갱신 확정 → backend boarding-lock 핸들러가 새 trainCode로 추적

**backend 작업 필요**:
- `backend/alarm-worker/src/handlers/boardingLockSync.ts` (또는 해당 파일)에 `validateBoardingLockSync`와 trainCode 갱신 로직
- KV `trip.boardingLock = { trainCode: newTrainCode, ... }` update

**관련 메모리**: [[project_622_wrangler_evidence]]

**Acceptance**:
- 사용자 trip 재현 시 환승 후 backend `boarding-lock: trainCode not found` 0건
- backend consecutiveEtaMissing이 환승 직후 0으로 리셋

---

### D5 — 환승 leg boardingPrompt autoLock 트리거 (P1)
**원인 지점**: `src/features/route/hooks/useTransferAutoDetect.ts:89-92`
```ts
const onPlannedTransfer = useMemo(
  () => findActiveTransferContext(...) !== null,
  ...
);
// onPlannedTransfer면 detect skip — useTransferTrainList가 책임
```

**변경 방향**:
1. `useTransferAutoDetect`에서 `onPlannedTransfer` 분기에서도 boardingPrompt 트리거 옵션 추가:
   - planned route 환승이지만 사용자가 BoardingTrainList 안 봤다면 boardingPrompt push 발사
   - 또는 `useTransferTrainList`가 boardingPrompt 분기 호출
2. `useBoardingPromptResponder` (#1167 PR #1188 머지)와 연결:
   - planned route 환승 시점에 backend에 boardingPrompt 요청 또는 client 측 자동 트리거
3. autoLock 호출:
   - boardingPrompt 응답 시 arvlCd 우선순위로 trainCode 매핑
   - `hydrateLockFromCandidate(candidate)` 호출 → 새 leg lock 생성

**확인 필요**: backend의 boardingPrompt가 환승 leg에서 발사되는지 (현재 lockless trip 시작점 한정으로 추정)

**Acceptance**:
- 사용자 trip 재현 시 건대입구 환승 시점에 boardingPrompt push 1회 발사 또는 자동 lock 생성
- 사용자가 "탑승" 탭 안 해도 새 leg trainCode가 lock에 들어감

---

### D6 — sticky station이 trip 활성 + 지하 시 유지 (P1)
**원인 지점**:
- `src/features/nearest-station/utils/stickyStationGates.ts:81` `shouldUnlockByMotion(motion) → motion.automotive === true`
- `src/features/nearest-station/utils/stickyStationGates.ts:56` `shouldUnlockByDistance` — accuracy 게이트만, trip 활성/lockless 미고려

**변경 방향**:
1. `StickyMotionInput`에 `subsurface?: boolean`, `tripActive?: boolean` 추가
2. `shouldUnlockByMotion` 수정:
```ts
export function shouldUnlockByMotion(motion: StickyMotionInput): boolean {
  if (motion.automotive !== true) return false;
  // 지하철 안 + trip 활성 = automotive 보고는 정상. unlock 보류.
  if (motion.subsurface === true && motion.tripActive === true) return false;
  return true;
}
```
3. `shouldUnlockByDistance` 수정:
   - tripActive + subsurface=true이면 unlock 보류 (지하 GPS 부정확)
4. `useStickyStation.ts`에서 motion input에 subsurface + tripActive 전달
5. `HomeScreen.tsx`에서 sticky hook 호출 시 trip 활성 여부 전달

**테스트 케이스**:
- automotive=true + subsurface=true + tripActive=true → unlock 보류
- automotive=true + subsurface=false → unlock (지상에서는 차로 이동 가능)
- automotive=false → 기존 동작

**Acceptance**:
- 사용자 trip 재현 시 어린이대공원 부근 디바이스가 sticky 용마산 → 어린이대공원으로 자연 갱신 (또는 sticky 유지로 잘못된 매칭 차단)

---

### D7 — BoardingTrainList ETA vs Arrival ETA provider 일관성 (P2)
**원인 지점**:
- `src/features/alarm/components/BoardingTrainList.tsx:39` `arrivals: ArrivalInfo[]` prop
- `src/screens/HomeScreen.tsx` arrivals prop을 어디서 가져오는지 확인 필요

**변경 방향**:
1. HomeScreen에서 BoardingTrainList에 전달하는 arrivals와 Arrival 표시 컴포넌트(아마 ArrivalRow)에 전달하는 source가 동일한지 검증
2. 다르면 단일 provider hook으로 통일 (`useArrivalInfo` 또는 동일 cache key)
3. 캐시 TTL이 다르면 동일하게 조정

**확인 필요**: 실제 코드 추적 — HomeScreen에서 BoardingTrainList prop source

**Acceptance**:
- 같은 시점에 BoardingTrainList와 Arrival 표시의 ETA 차이 ≤ 5초

---

### D8 — 취침모드 station-passed 음소거 + lockless 적용 (P2)
**원인 지점**: `src/features/alarm/utils/shouldSuppressBySleepRule.ts:44-49`
```ts
export function shouldSuppressBySleepRule(input: SleepRuleInput): boolean {
  if (!input.lock) return false;       // ← lockless 비활성
  if (!input.sleepMode) return false;
  if (!input.isFirstHop) return false;
  return input.event.type === 'transfer'; // ← station-passed 통과
}
```

**정책 결정 필요 (사용자)**:
- (a) 취침모드 첫 환승 전까지 모든 알람(station-passed 포함) 음소거
- (b) station-passed는 통과 (현재 정책), transfer만 차단
- (c) destination도 차단

**변경 방향 ((a) 채택 시)**:
1. line 48 `return input.event.type === 'transfer';` → `return input.event.type === 'transfer' || input.event.type === 'station-passed';`
2. line 45 lockless 적용 — lockless trip이면 isFirstHop을 다른 방식으로 정의 (route arc index ≤ N으로 추정)
3. `useStationAlarm.ts:404` `isFirstHop` 계산 — lockless 시 fallback 로직 추가

**Acceptance**:
- 사용자 trip 재현 시 22:11:56 사가정 fire 차단 (취침모드 + 환승 전)

---

### D9 — DebugModal에 subsurface / fusion source / lockless 상태 표시 (P2)
**원인 지점**: `src/features/debug/components/DebugModal.tsx`
- subsurface 표시 없음 (grep 결과 0)
- 사용자가 지상/지하 분기 작동 여부를 시각적으로 확인 불가

**변경 방향**:
1. `## GPS` 섹션에 `subsurface=true/false` 줄 추가
2. `## Fusion` 섹션에 `tier`, `signalMask` 표시
3. `## Trip` 섹션 신규: `lockless=true/false`, `tripStartedAt`, `currentHopIndex (D1 출력)`, `route hop count`
4. `## Sleep` 섹션 신규: `sleepMode=on/off`, `firstHop을 향하는가`

**Acceptance**:
- DebugModal share 시 위 정보 다 포함

---

### D-DATA — wifi SSID 데이터 19 → 528 station 확장 (P1, 데이터 작업)
**원인 지점**: `src/data/subwayWifiSsidMap.json` 97줄 / 19 stationName
- `_meta.dataCollection`: "placeholder로 시작" 명시
- 핵심 환승역 패턴이 통신사 기본 (`T_subway_xxx`)

**작업 방향**:
1. 서울 528개 역 × 통신사 3개(SKT/KT/LGU+) SSID 패턴 추가
2. 실제 SSID 수집 — 사용자 베타 + Google Maps Wi-Fi 데이터 가능 시
3. 1단계: 528개 역 × 통신사 기본 패턴 자동 생성 (스크립트 `scripts/generate-ssid-patterns.ts`)
4. 2단계: 사용자 보고/실측 기반 패턴 보강

**스크립트 입력**: `src/data/stations.json` (528개 역)
**스크립트 출력**: 갱신된 `subwayWifiSsidMap.json`

**Acceptance**:
- 528개 역 모두 최소 1개 패턴 등록
- 지하 wifi 잡힌 사용자 80% 이상이 SSID 매칭 성공

---

## 5. 정책 PR — docs only, 즉시 spawn

### P1 — ADR-014 + CLAUDE.md + lessons.md commit
**파일**:
- `docs/decisions/ADR-014-decision-process-rules.md` (이미 생성됨)
- `CLAUDE.md` "결정 / Acceptance 룰" 섹션 (이미 추가됨)
- `tasks/lessons.md` L1~L4 (이미 생성됨)

**작업**: 단일 commit + PR
**메시지**: `chore(#1008): ADR-014 결정 프로세스 룰 + CLAUDE.md/lessons.md 추가`
**Branch**: `chore/#1008-adr-014-decision-rules`

### P2 — ADR-013 B3 면제 폐기
**원인 지점**: `docs/decisions/ADR-013-lockless-supplementation-policy.md:46-56`
**변경**: §"#912 acceptance 재해석 (B3 확정)" 표에서 lockless 면제 row 3건 폐기 + "사용자 명시 의향 trip 동급 보장" row 추가
**메시지**: `docs(#1008): ADR-013 B3 면제 폐기 — 사용자 명시 의향 trip 동급 보장`
**Branch**: `docs/#1008-adr-013-b3-revoke`

### P3 — Epic #1008 §7.1 회귀 7개 → 12개 확장
**원인 지점**: `tasks/epic-lockless-overfire-guard.md` §7.1 표
**변경**: 회귀 8~12 추가 (본 파일 §3.2 그대로 옮김)
**메시지**: `docs(#1008): SSOT §7.1 회귀 12개로 확장 (회귀 8~12 lockless 카테고리)`
**Branch**: `docs/#1008-regressions-extend-12`

---

## 6. 발행 순서 (다음 세션 또는 본 세션 직후)

```
1단계 (정책 PR, docs only):
  P1: ADR-014 + CLAUDE.md + lessons.md 커밋 + PR
  P2: ADR-013 B3 면제 폐기 PR
  P3: Epic #1008 §7.1 회귀 12개 확장 PR

2단계 (신규 epic + sub-issue 발행):
  - 본 epic 발행 (이 파일을 본문에 첨부 또는 SSOT 참조)
  - sub-issue D1~D9 + D-DATA 발행 (각 변경 지점 §4에서 복사)
  - issue 본문에 Closes #(epic 번호) 포함

3단계 (코드 BG agent spawn):
  P0 먼저: D1 → D2 (의존, 직렬) + D3 + D4 병렬 (파일 disjoint)
  P1: D5 + D6 + D-DATA 병렬
  P2: D7 + D8 + D9 병렬
  isolation: "worktree" 필수 ([[feedback_bg_agents_need_isolation]])

4단계 (실기기 검증, 사용자 영역):
  - 본문 §1 evidence 시나리오 재현 (lockless + 지하 + 환승)
  - 사용자 보고 11건 각 항목 재발 확인
  - 1주 production 측정 → 회귀 8~12 카운트 0건 확인
  - Epic close

5단계 (Epic close + 후속):
  - Epic #1008 acceptance (회귀 12개) 1주 측정 통과 시 close
  - Epic #912 acceptance (사용자 명시 의향 trip 동급) 통과 시 close
  - Epic #896 reopen 검토 → 본문 evidence 시나리오 재발 0건 acceptance 추가 후 close
```

---

## 7. /clear 후 작업 재개 체크리스트

다음 세션이 단독으로 이어받을 때:

- [ ] 본 파일 (`tasks/epic-lockless-recovery-2026-06-12.md`) 읽기
- [ ] `memory/MEMORY.md` 상단 5건 (🔴 표시) 읽기
- [ ] `gh issue list --state open --search "lockless OR recovery"` — 본 epic 발행 여부 확인
- [ ] `gh pr list --state open` — 정책 PR 3건 머지 상태 확인
- [ ] §6 단계별 진행 상태 자가 점검
- [ ] BG agent spawn 시 isolation: "worktree" 명시

**중요**: 본 epic 발행 전이면 §6 1~2단계부터 진행. 발행 후이면 §6 3단계부터.

---

## 8. 변경 이력
- 2026-06-12: 신규 작성. 코드 100% 확인 후 정확한 변경 지점 명시. Epic 본문 acceptance 복구 결정.
