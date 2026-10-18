# BG → device silent push wire 분석 (2026-06-27)

Evidence: backend `logs-2026-06-27T05_09_32.690Z.json` (UTC) + device dumps. KST = UTC+9h.

## Backend silent push 발사 entry point 전체 표

| Entry | 파일:line | trigger | payload `kind` |
| --- | --- | --- | --- |
| `fireArvlCdStationPush` (`buildStationPassedImminentPayload`) | scheduled.ts:1442/1528 | lock 활성 + arvlCd∈{0,1} + dedup pass | `waypoint.kind` (`'intermediate'/'transfer'/'destination'`) |
| `fireVanishFallbackStationPush` | scheduled.ts:1918 | trainCode 소실 + hop 시간 경과 | `waypoint.kind` |
| `runLocklessIntermediate`→`sendSilentPush` | scheduled.ts:2987 | lock 없음 + `infoModeEnabled===true` + intermediate + ENTERING/ARRIVED + motion gate | hard-coded `'intermediate'` |
| `maybeReschedulePush`→`sendReschedulePush` | scheduled.ts:2855 / apns.ts:512 | lock 활성(runTrainCodeTracking) + ETA shift ≥15s + motion ≠ stationary | hard-coded `'reschedule'` |
| `evaluateAndMaybeFireBoardingPrompt`→`sendBoardingPromptPush` | scheduled.ts:3362 / apns.ts:742 | lock 없음 + 9-AND gate (≥1 후보) | alert (`'boarding-prompt'`) |
| `runFallbackPushes`→`sendAlertPush` | fallback.ts:57 | PENDING_PUSHES entry ageMs > 60s | **alert push** (silent 아님) |

`toSilentPushSsot` (scheduled.ts:1418) = SSoT payload 빌더, 발사 X.

## 본 trip 13:33~14:02 발사 vs 수신 매칭

Backend tail (token=`e25e1158`, 추적 origin: line=7 / 용마산 / trainCode=7151):

| KST | Backend event | payload kind | 비고 |
| --- | --- | --- | --- |
| 13:40:13 | reschedule push (next=중곡) | `'reschedule'` | 13:40:14 env mismatch retry → 13:40:15 corrected sandbox |
| 13:41:14 | reschedule push: no-ssot fallback | (stat) | 발사 자체는 미발생, stat 만 누적 |
| 13:42:14 | arvlcd-fire: station-passed push (중곡, arvlCd=1) | `'intermediate'` | lazy-seed ssot 직후 |
| 13:43:13 | reschedule push (next=군자(능동)) | `'reschedule'` | — |
| 13:43:15 | alert fallback fire (중곡, ageMs=62590) | (alert) | 13:42 silent push 60s ACK miss → fallback |
| **13:43:16~** | (cron 30분 매분) `boarding-lock: skip cycle ... locklessOptIn=false` | — | silent push 발사 0 |

Device dump 1: `received=3 (last 13:43:23)`, `stn=0 xfer=0 dst=0 unk=3`. 시각 timeline `13:40:18 / 13:41:15 / 13:43:23`.

발사 3건 ↔ 수신 3건 카운트 일치. 단 kind 분류 불일치 (아래 섹션).

## 13:53~14:02 강변~삼성 진행 중 0건 root cause (lockMissing 분기 trace)

Backend 13:44~14:02 매 cron 사이클 = 동일 패턴:
```
boarding-lock: skip cycle (lock missing or expired) | @<역> | locklessOptIn=false | waypointKind=intermediate
boarding-prompt: gate blocked (no-candidates)  또는  skipped empty candidates (#1888 RC-13)
```

trace:
1. scheduled.ts:975 `isBoardingLockActive(trip, now)` = false (`trip.boardingLock === undefined`).
2. scheduled.ts:980 `trip.infoModeEnabled === true` 분기 false → `runLocklessIntermediate` 미진입.
3. `stats.lockMissing++` + `evaluateAndMaybeFireBoardingPrompt` 만 호출.
4. 9-AND gate `no-candidates` (또는 RC-13 candidates empty) → silent push 미발사.

즉 **device 13:43:23 BoardingLock 활성화(line=2, trainCode=2175) metadata 가 backend 까지 도달하지 않음**.

이유 — `useApnsTripRegistration.ts:127~136` `isLockConsistentWithRoute`:
- backend KV trip route firstLeg.line = `7` (이전 trip 잔존 또는 device 가 line7 route 로 register 한 상태).
- device 의 BoardingLock.boardingLine = `2` (사용자 실제 탑승).
- `firstLegLine !== lock.boardingLine` → `false` 반환.
- `useApnsTripRegistration.ts:149` 분기 false → `boardingLockMeta = null`.
- `useApnsTripRegistration.ts:189` `...(boardingLockMeta ? { boardingLock: boardingLockMeta } : {})` → backend register payload 에 `boardingLock` 키 omit.
- backend `Trip.boardingLock = undefined` 영구 → `isBoardingLockActive` 영구 false → station-passed silent push 영구 미발사.

Device dump 1 의 `## Trip — lockless=false / tripStartedAt=— / route hop count=— / ## Trip Route Lines (no route)` 는 device 가 trip route 자체를 hydrate 못함을 시사 — backend KV active trip 과 device store 불일치 상태.

trip-2 dump (`active=yes`, `route=(none)`, `received=0`) 도 동일 패턴 — BoardingLock 활성인데 route 없음 → register payload route omit 가드 (POST `/trips` 자체 미발사) → backend 가 trip 자체 없음 → silent push 0 (no-trip path).

## kind=unk 3건 정확 분류

`countSilentPushKindBreakdown` (`alarmLog.ts:1177~1196`) bucket: `'station-passed' | 'transfer' | 'destination' | 'unknown'`.
`logSilentPushReceived` (alarmLog.ts:871~892) 은 `kind === 'intermediate'` → `'station-passed'` 매핑.
`logSilentPushRescheduleReceived` (alarmLog.ts:904~917) 은 `kind` 필드 미적재 → unknown.

| 시각 | Backend push kind | Device handler | bucket |
| --- | --- | --- | --- |
| 13:40:18 | reschedule | silentPushTask.ts:834 → `logSilentPushRescheduleReceived` | unknown |
| 13:41:15 | reschedule (no-ssot fallback log 이후, retry 추정 또는 BG suspend 지연 delivery) | 동일 | unknown |
| 13:43:23 | reschedule (군자(능동)) | 동일 | unknown |

13:42:14 backend `arvlcd-fire` (kind='intermediate') 는 device timeline 에 미존재 — `lastSkipped=(never)` 이라 `logSilentPushSkipped` 도 미호출. 가능 원인: silentPushTask 의 lock/lockless 분기 통과 후 다른 gate(ACTIVE_TRIP_KEY mismatch / pushId dedup / line guard 등) drop, 또는 silent push 미도달 (APNs sandbox corrected 직후 device 가 production 토큰 등록 상태에서 sandbox 발사 → 무시).

## APNs env mismatch + 응답 status

- 13:40:14 `apns env mismatch — retry with opposite host` from=production to=sandbox.
- 13:40:15 `apns env corrected` (KV `trip.apnsEnv = sandbox`).
- Device dump 1 `apnsEnv=production` — RC-5 (PR #1915, commit 26e8f91f) `LAST_CONFIRMED_APNS_ENV_KEY` AsyncStorage stamp 미반영. cold start race / 미배포 빌드 가능. 다음 register 시 build env (production) 로 또 송신 → mismatch self-heal 무한 반복.
- 개별 push status code 는 log 미적재. `sendWithEnvHeal` 은 stat 누적만.
- 13:42 push 가 sandbox 로 발사된 후 device APNs token 이 production 으로 등록된 상태라면 APNs 가 BadDeviceToken 반환 → device 미수신 = 13:42 timeline 부재 설명.

## 본 fix (영역 B 등) 적용 후 개선 path

사용자 가설: "B fix: `isLockConsistentWithRoute=false` → `boardingLockMeta=null` → backend `boardingLock=undefined` → lockMissing 분기 정상화 → silent push 정상 발사".

실제: **현 코드가 이미 그 동작 — 그것이 회귀의 시발점**. PR #1366 (5d990b86) 가도입한 transient transfer state 가드가 본 trip 에서 false-positive 로 작동.

실제 개선 path 2 갈래:

1. **Route stale 갱신**: device 가 line2 lock 활성 시 line2 route 로 backend register POST → `firstLegLine=2 ↔ lock.boardingLine=2` 일치 → metadata 송신 → lock 활성 → silent push 정상화.
2. **`infoModeEnabled` wire 신규**: `RegisterTripPayload` (`alarmBackend.ts:64~115`) 에 `infoModeEnabled` 필드 추가 + device 토글/auto-set wire. `runLocklessIntermediate` 분기로 회복 (intermediate kind 한정).

현재 wire 결함: `infoModeEnabled` 가 backend `Trip` type 에는 정의(`types.ts:160~162`)되어 있으나 device `RegisterTripPayload` 인터페이스에는 부재 + register caller 의 어떤 곳에서도 적재 미존재. 사용자 명시 의향 신호가 backend 에 도달할 path 자체가 없음.

## V/X 표 매핑: V4 (매역 silent 알림) 충족 여부

| 단계 | 본 trip | 충족 |
| --- | --- | --- |
| device register POST | route(line7 stale) ↔ lock(line2) mismatch → metadata omit | X |
| backend lockActive | KV `boardingLock=undefined` | X |
| station-passed push 발사 | 30분간 0건 | X |
| device 수신 stn bucket | stn=0 | X |
| **V4 종합** | line2 강변/잠실나루/잠실/잠실송파/삼성 5역 silent missed | **미충족** |

V8a/V8e (lockless skip + 사용자 명시 의향): 의향 신호 backend 도달 불가 (`infoModeEnabled` wire 부재) → paradigm Phase 6 "단독 사용자 모드" prereq 미성립.

## 후속 조치 추천

1. **device route hydration 회귀 진단** — dump `route hop count=—` 가 backend KV active trip 과 불일치 패턴 별도 조사 (trip-2 도 `active=yes`/`route=(none)`).
2. **`infoModeEnabled` 송신 wire 신규** — `RegisterTripPayload` 필드 + device store/hook 토글. 사용자 명시 의향 ON 시 lockless intermediate 회복.
3. **`isLockConsistentWithRoute` mismatch alarmLog forward** — 현재 `logger.info` 만. DebugModal gauge + S6 telemetry.
4. **PR #1915 RC-5 검증** — apnsEnv=production stamp 미반영 cold start race 조사.

**결론**: silent push 미수신 wire 단절은 APNs/backend 발사 path 가 아니라 **device 의 lock-route line mismatch 가드 + register payload omit**. backend 는 본 trip 동안 active trip 인지 후 lockMissing + boarding-prompt no-candidates 만 처리. 사용자 가설 "영역 B fix" 는 이미 현 코드 동작이며 그것이 회귀의 시발점.
