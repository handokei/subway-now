# Slot E — `triggerTripEndRecall` early-return verification (75% → revised)

## triggerTripEndRecall.ts:99~140 코드 흐름

```
L84  triggerTripEndRecall()
L86    tripStart = await getTripStartedAt()   // ROUTE_KEY 와 별 키 (TRIP_STARTED_AT_KEY)
L87    if (tripStart === null) return 'no-trip-start'  ← 1차 early return
L93    lastUploadedRaw = AsyncStorage.getItem(LAST_UPLOADED_RECALL_TRIP_START_KEY)
L94    if (lastUploadedRaw === tripStart) return 'duplicate'
L99    routeStops = await loadRouteStops()    // ROUTE_KEY + TRIP_ORIGIN_KEY + DESTINATION_KEY
L100   if (routeStops === null) return 'route-arc-failed'  ← 2차 early return ★
L104   await computeAndUploadTripRecall(...)  // POST /telemetry/recall
L117   await triggerPrescheduledUpload()      // POST /telemetry/prescheduled
L122   await triggerRegressionFlush()         // POST /telemetry/regression
L127   await triggerSignalDumpUpload()        // POST /telemetry/signal-dump
L132   await triggerAlarmLogForward()         // POST /telemetry/alarm-log ★ Slot E의 핵심
```

**확정**: line 132 `triggerAlarmLogForward`는 line 100 early-return 안에 가려져 있다. 다른 caller 없음 (grep 결과 `triggerTripEndRecall.ts:132` + 정의 `:205` 두 매치뿐). 즉 routeStops null → R2 trip-evidence forward 완전 dead wire.

## ROUTE_KEY cleanup vs triggerAlarmLogForward timing race

`useDestinationStore.setDestination(null)` (line 141~211):
1. **sync**: `set({destination: null})` + `set({tripOrigin: null})`
2. **fire-and-forget queue**: `tripTransitionQueue.then(triggerTripEndRecall).then(runTripBoundCleanups)` (line 190-193). 두 chain 사이 안전 — `runTripBoundCleanups`(L82 `removeItem(ROUTE_KEY)`)가 trigger 뒤에 도착.
3. **React 별 path**: `HomeScreen.tsx:464` useEffect deps `destination?.id` 변경 감지 → `AsyncStorage.removeItem(ROUTE_KEY)` 별 fire-and-forget. **이 race가 #1379에서 차단됐다고 주석에 적혀 있지만 ROUTE_KEY는 보호 안 됨 (DESTINATION_KEY만 inline write 직렬화).**

→ ROUTE_KEY는 **두 갈래에서 동시에 removeItem 발사**: ①queue chain의 runTripBoundCleanups + ②HomeScreen useEffect. triggerTripEndRecall은 microtask 우선이므로 보통 getItem이 먼저 ready되지만 AsyncStorage RN bridge는 비결정적 jsi 큐.

## 13:53:05 / 13:53:43 / 13:58:28 / 14:03:01 transition path

- **13:53:05**: dump `sticky:unlocked-moved-away | 건대입구` + `fg-hydrate hydration-ready`. 사용자 환승 후 sticky lock 해제. POST /trips (callId mqvvwgqh2) + DELETE LA (mqvvwgze3). 같은 trip hash → 같은 destination, **isSwitch=false**. setDestination 비호출 또는 노옵.
- **13:53:43**: POST /trips (mqvvxak45). routeSig 변경(7→2 line 환승) 재등록. useApnsTripRegistration의 `routeSig` deps만 변함 — setDestination 비호출.
- **13:58:28**: POST /trips (mqvw3eknf). 잠실나루 도착 후 route-progress confidence 진입으로 route 변경 가능. setDestination 비호출.
- **14:03:01**: **DELETE /trips (mqvw98uxh) 발사** + `destination=(none)` 캡처. 사용자가 명시적으로 setDestination(null) 호출. queue chain 발사.

→ 14:03:01만 `triggerTripEndRecall` 호출 path. 나머지 3건은 useApnsTripRegistration의 route deps 재발사이며 telemetry forward는 trigger 안 됨.

## 영역 E 확률 업데이트 — 75% → 35% (stable 부재, race 부재, 별 원인)

**Revised**: routeStops null early-return은 **회귀가 아니라 race-free**. 14:03:01 시점에 ROUTE_KEY는 여전히 유효 (직전 14:02:57 bg-scheduled에서 ROUTE 기반 revalidate 정상 발사 = ROUTE 활성). trigger가 먼저 getItem할 가능성 매우 높음.

**진짜 가능성 (재배분)**:
- 35% — `getTripStartedAt() === null` (line 87 1차 early-return). tripStartedAt 보관 여부는 dump의 `tripStartedAt=—` 라인이 cleanup 후 캡처라 사전 상태 불명. 검증 필요: tripStartedAt이 사용자 trip 도중 9h+ force-end로 cleared됐는지.
- 30% — `triggerTripEndRecall` 자체가 호출 안 됨. 추정 원인: 14:03:01 시점 setDestination(null)이 prev=destination 상태에서 호출되지 않고, **이전 cleanup으로 이미 destination=null이 set된 상태에서 재호출** → `isSwitch=false` (line 127) → if (isSwitch) block 건너뜀 → triggerTripEndRecall **미호출** (line 165 분기 제외).
- 20% — `forwardTripTelemetry` 내부 skip: `trip-too-short` (<30s) 또는 `empty-payload` (alarmLog/fusionLog/gpsDrops/ssotMirror 모두 0). dump `lockless=false` + `tripStartedAt=—` 후 캡처라 길이 추정 불가.
- 15% — 기존 가설(loadRouteStops null) 잔존.

**Stable cause vs race 결론**: race 아님. line 99-102 early-return은 가능한 분기지만 본 trip dump 데이터로는 우선 경로가 아님. **Stable cause는 line 87 (`tripStart === null`) 또는 isSwitch=false 분기로 trigger 자체 미호출**일 가능성이 더 큼.

## 회귀 차단 fix 재정의

- L100 early-return 안에서도 `triggerAlarmLogForward(tripStart)` 직접 호출 — race 안전망 + (1) 가설 잔존 15% 대비. routeStops null과 alarmLog forward는 의미상 독립.
- 동시에 L87 tripStart null 분기에서도 forward 호출 — 9h+ force-end 후 setDestination(null) 시 evidence 보존.
- `useApnsTripRegistration` 라우트 재등록 path(13:53:43 / 13:58:28)에서도 telemetry forward 별도 trigger 검토 — sub-trip 분석 evidence 누적.
