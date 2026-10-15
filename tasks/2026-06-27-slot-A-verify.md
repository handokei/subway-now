# Slot A Verify — lockSuggestion 도달 path (2026-06-27 13:40 7호선 lock)

영역 A 가설: "backend deriveLockSuggestion이 lockSuggestion stamp → device가 사용자 의향 0 상태에서 채택" (slot-A-rca primary).

## lockSuggestion 도달 path 확정

**Backend stamp → wire 후보 (4개)**
1. POST /position response (primary, `index.ts:1260~1271`) — `ssot.lockSuggestion`가 200 body에 spread.
2. silent push payload via `toSilentPushSsot` (secondary, `scheduled.ts:1418~1440`, `1482`/`3110`) — `payload.ssot.lockSuggestion`.
3. POST /trips response — **미포함**. `index.ts:709~713`은 `{ok, token, confirmedEnv}`만 반환.
4. KV trip 직접 fetch — **미존재**. device가 KV/SSoT를 direct GET하는 경로 없음.

**Device sink**: 두 path 모두 `persistBackendSsotMirror`(`backendSsotMirror.ts:89`)로 `BACKEND_SSOT_MIRROR_KEY` AsyncStorage write. POST /position response는 `positionUpload.ts:281 persistFromPositionResponse`, silent push는 `silentPushTask.ts:802`. 채널은 1개 (mirror) — wire는 2개 (response embed + silent push).

## device useLockSuggestion reader 호출 path

`useLockSuggestion.ts:86~104`: `setInterval(tick, 5000)` 폴링 → `readBackendSsotMirror()` (AsyncStorage read) → `computeNextState` (stale 5min cap) → `setState`. consumer = `useBoardingLockController.ts:140` (`const { suggestion: lockSuggestion } = useLockSuggestion()`). 채택 effect `:186~232`는 lockSuggestion 있고 lock 없으면 즉시 `createLock` — **9-AND gate 우회 (motion / directionalArrivals 매칭 X), allowedLines만 검증**.

**별도 store stash 없음** — useState만. lockSuggestion은 다른 hook에 propagate되지 않음 (single consumer).

## 13:40:08 timing 추적 결과

| 시각 (KST) | Event | Source |
|---|---|---|
| 13:39:46 | POST /position #N-1 | 기존 lockless trip |
| 13:40:08.0xx | BoardingLock 활성화 (raw L582) | **미상** |
| 13:40:08 | `cross-trip-mirror-register` → `clearBackendSsotMirror()` (`useApnsTripRegistration.ts:398`) | device |
| 13:40:08.256 | POST /position (UTC 04:40:08) | device |
| 13:40:09.064 | POST /trips status=200 (boardingLock metadata 포함, content-length 1586B) | device |
| 13:40:09.139 | /position response 200 (wallTimeMs=883) — **`{ok:true}` only** (ssot=null, no lockSuggestion/originStationId) | backend |
| 13:40:13.753 | cron `reschedule push: no-ssot fallback` token=e25e1158 (backend log) | backend |
| 13:40:15.183 | cron run-complete: `pushed=1, silentPushFiredByKind.reschedule=1, rescheduleFallbackNoSsot=1, lockMissing=0, autoLockSuccess=0` | backend |
| 13:40:18 | silent-push-received | 중곡 (첫 inbound) | device |
| 13:42:13.956 | **첫 SSoT 생성** = `arvlcd-fire: lazy-seed ssot currentStationId=중곡` | backend |

**확정 사실**:
1. **Backend SSoT는 13:42:13까지 null이었다** (lazy-seed가 첫 write). `deriveLockSuggestion`은 SSoT write를 통해서만 작동 (`advanceTripPosition.ts`). 따라서 13:40:08 시점에 lockSuggestion stamp는 **backend에 존재할 수 없다**.
2. **13:40:13 silent push는 `sendReschedulePush` payload** (`apns.ts:519~534`) — `ssot.lockSuggestion`을 carry **하지 않는다** (reschedule payload에는 `ssot` 필드 자체 없음).
3. **13:40:08.256 POST /position response는 `ssot=null` 분기** — `index.ts:1267~1270`은 `ssot?.lockSuggestion` 조건부 spread, ssot=null이면 `{ok:true}` only.
4. Device dump `## Backend SSoT (no recent SSoT push)` (L62) — mirror가 dump 시점에 empty. R11-a clear가 13:40:08에 fire (`cross-trip-mirror-register` L286).

**결론**: 13:40:08 BoardingLock 활성화는 **lockSuggestion path가 아니다**. `BACKEND_SSOT_MIRROR_KEY`가 13:42:13까지 backend write 후보가 없었고, mirror도 13:40:08 register 직전 clear됐다. RCA의 path A 추정(useBoardingLockController:186~232)은 본 trip에서 **trigger 불가**.

남은 device-side 후보 (모두 차단됨):
- `hydrateLockFromCandidate` (L320): backend `boardingPrompt(all)=0` → autoLockCandidate 0 (RCA 확인).
- Origin auto-lock (L434~517): `chosen.arrivalCode` ENTERING/ARRIVED/DEPARTED(0/1/2) 강제. raw 모든 cycle arvlCd∈{5,99} → 차단.
- `createLockFromTrain` (L266): 사용자 명시 탭 (BoardingTrainList/TransferTrainList).

dump alarm log 200-entry cap이 13:40:08 lock creation 진입점 log를 잘라 정확한 path 식별 불가. 단 위 3개 device path는 evidence 부재 / strict 차단되어 **사용자 명시 탭(`createLockFromTrain`)이 잔존 가능성 가장 높음**. RCA 가정(사용자 명시 의향 0)이 잘못됐을 가능성 검토 필요.

## 영역 A 확률 업데이트

**80% → 5%**

핵심 reverse evidence:
- Backend SSoT가 13:42:13까지 null → lockSuggestion stamp 발생 자체 불가능.
- 13:40:13 silent push는 reschedule kind only (ssot/lockSuggestion 미carry).
- 13:40:08.256 /position response는 `ssot=null`이라 lockSuggestion 누락 spread.
- mirror가 13:40:08 register 직전 force-clear됨.

남은 5%: 직전 trip의 mirror가 cleanup race로 살아남아 useLockSuggestion이 stale stationId/trainCode를 read해 채택했을 가능성. 단 dump `(no recent SSoT push)`로 dump 시점 비어 있어 trip 중간에 clear됐을 수도. 이 가능성을 확정하려면 `BACKEND_SSOT_MIRROR_KEY` AsyncStorage value를 13:40:08~13:40:10 사이 시계열 capture 필요(불가).

**우선순위 이동 권고**: RCA primary가 lockSuggestion path가 아니라면 path B(SSoT seed race + lazy-seed) 또는 path 5(`createLockFromTrain` 사용자 탭 확인)로 재조사 필요. F1/F2 (`useBoardingLockController` lockSuggestion gate 보강, deriveLockSuggestion medium confidence 차단) fix는 본 trip 회귀를 차단하지 않는다.
