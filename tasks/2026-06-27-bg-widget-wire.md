# BG Widget Wire — RC-15 #1911 + Wire Gap 분석 (2026-06-27)

## widgetStorage.ts 전체 schema + 동작

**File**: `src/features/widget/api/widgetStorage.ts` (104 lines).

**Exports**: `saveStationToWidget(station, distanceKm, savedAt?, options?, tripContext?)`, `clearWidgetStation()`. Type: `SaveStationToWidgetOptions{force?}`, `WidgetTripContext{currentStationName, destinationName, nextTransferName?, tripActive}`.

**Bundle ID**: `group.com.subwaynow.app` (App Groups). UserDefaults keys (in `modules/live-activity/ios/LiveActivityModule.swift`): `stationName`, `lineColor`, `distanceM` (Int as String), `savedAt` (Double seconds), `tripActive` (Bool), `currentStationName`, `destinationName`, `nextTransferName`.

**Schema** = station name + lineColor + distanceM + savedAt epoch ms. **GPS 좌표는 저장 안 함**. station/distance는 device fusion 결정 후 결과만 stamp.

**Dedupe**: module-level `lastDedupeKey` (`${station.id}:${50m-bucket}`) + `FRESHNESS_REFRESH_MS=5min`. force=true는 dedupe 우회 (R9-a/#1612).

## update 호출자 + trigger 조건 매트릭스

| Caller | Trigger | force | tripContext 전달 |
|---|---|---|---|
| `HomeScreen.tsx:865` `useWidgetMirror` | liveResult.station 변경 (50m bucket), FG only | n | **never (3rd arg omitted)** |
| `HomeScreen.tsx:844` AppState 'active' 복귀 | FG 복귀 시 1회 | **y** | never |
| `backgroundLocationTask.ts:291` | BG 위치 task tick (`expo-task-manager`, expoTL `BG_LOCATION_TASK`) | n | never |
| `alarm/api/notificationRouter.ts:74` widget surface | NotificationRouter req.data.station 있으면 | n | never |
| `alarm/api/notificationRouter.ts:90` clearAll | trip-bound cleanup | (clear) | — |
| `alarm/store/tripBoundCleanups.ts:138` | trip 종료 4 entry point (FG setDestination(null) / silent push trip-ended / state-rehydration / launch-reconciliation) | (clear) | — |

**핵심 결함**: `saveWidgetTripContext` native API는 wire 존재(`widgetStorage.ts:90`)하나 production 호출자 중 어디에서도 `tripContext` 인자를 전달하지 않음 → `tripActive` 항상 false, currentStation/destination/nextTransfer 키 항상 미설정. RC-15 expired-fallback 분기(`SubwayWidget.swift:229`)는 dead branch.

## iOS 위젯 timeline reload 정책

- `TimelineProvider.getTimeline`: 5분 간격 base entry + savedAt+STALE(2m) / savedAt+EXPIRED(10m) 전이 시점 추가 entry 삽입 (`.after(now+5min)` policy). **앱이 죽어 있어도** OS가 freshness 변화 시점에 UI 재구성 (#1890 RC-15 핵심).
- Reload trigger: `WidgetCenter.shared.reloadAllTimelines()`가 `saveWidgetStation`/`saveWidgetTripContext`/`clearWidgetStation`에서만 호출. 즉 **앱 process alive시 device fusion → reload**. 앱 dead시 timeline의 사전 emit entry로 OS 자율 fallback.
- 1분 자동 reload **불가**. WidgetKit budget상 강제 1분 reload API 없음. silent push로 reload 트리거할 수 있으나 본 코드에는 push handler 내 reload 호출 없음 (silent push는 BG fetch만 트리거 → BG task가 `saveStationToWidget` 호출 → reload).
- `widgetURL("subway-now://current-station")` 딥링크 + `TimelineEntryRelevance` (Smart Stack iOS17+, trip=0.8, transfer=1.0, 평시=0.3).

## 본 trip widget update evidence

- 백엔드 로그(`logs-2026-06-27T05_09_32.690Z.json`)는 silent push cron metrics(`deferred/exhausted/scanned`)만, widget 직접 evidence 없음.
- 코드 추적: 본 trip 14:02 silent push 0건이면 BG task tick은 권한/budget 따라 살아있을 수 있으나 widget update path는 BG task → fusion → `saveStationToWidget` 단일 경로. fusion이 stale GPS 좌표(영역 H — 14:03:03 origin)로 잘못된 station을 결정하면 widget도 같은 stale station stamp.

## stale 좌표 노출 mechanism + 영역 H 영향

위젯에 GPS 좌표 직접 저장 X — **station name 직접 저장**. 따라서 stale mechanism은:
1. **fusion 결정 시점 결함**: `getLastKnownPositionAsync` maxAge 미적용(영역 H) → cached lastFix로 fusion이 origin 역 결정 → `useFusedNearestStation` result → `useWidgetMirror` → `saveStationToWidget`로 origin 역명 stamp. 위젯은 이걸 그대로 노출.
2. **dedupe 50m bucket 정상 동작**: 잘못된 station name이 stamp된 후엔 같은 bucket이라 다음 호출 skip. 5분 freshness 윈도우 후에야 재호출. **stale 좌표가 보정되어도 fusion 결과가 같으면 위젯은 유지**.
3. **RC-15 gate** (`SubwayWidget.swift:229`, `freshness != .expired`): savedAt+10min 초과 시 tripActive 분기 차단 → nearest station 폴백. 그러나 본 trip은 trip 미등록 또는 tripContext 미전달이라 nearestStation 분기만 사용 → RC-15 dead. 즉 nearestStation 분기는 expired tier에서도 `contentOpacity=0.45` dim + "정보 오래됨" caption만 표시, station name은 **그대로 노출**.

## 본 fix 적용 후 widget 정상화 plan

- **영역 H (maxAge)** 수정 → fusion이 fresh GPS 기반으로 결정 → `saveStationToWidget`에 정확한 station stamp → 위젯 즉시 정확 (50m bucket이라 dedupe도 정확 station에 적용).
- **영역 B (boardingPrompt)** 수정 → trip 등록 정확 → **그러나 widget에 tripContext가 wire되지 않아 trip 컨텍스트 미표시 회귀 잔존**. PR #1781 wire 미완성.
- **영역 D' (dismissNotificationAsync)** → LA만 차단, widget 별도 채널이라 무관.
- **PR #1911 RC-15**: `tripContext` 미전달이라 본 trip stale widget UI **차단 못 함**. `nearestStation` 분기는 expired tier도 station name 유지 + opacity 0.45만 적용.

## 코드 결함 vs wire 결함 결론

**코드 자체**:
- `widgetStorage.ts`/`LiveActivityModule.swift` 코드 정상. dedupe + force 옵션 + 4-param backward-compat 모두 적절.
- RC-15 `SubwayWidget.swift` 코드 정상. 단 `nearestStation` 분기엔 expired 시 station name 숨김 적용 X (dim만) — 사용자 인식 stale 차단 부분적.

**wire 결함 (critical)**:
1. **HomeScreen `useWidgetMirror(liveResult?.station, liveResult?.distanceKm)` 3rd arg `tripContext` 누락** (HomeScreen.tsx:865). `WidgetTripContext` 인터페이스만 존재, **production 호출자 0건**. PR #1781 미완성.
2. **BG task widget 호출(backgroundLocationTask.ts:291)도 tripContext 없음** — BG에서도 trip 컨텍스트 위젯 전달 불가.
3. **NotificationRouter widget surface (notificationRouter.ts:74)도 tripContext 없음** — 알람 발사 시 위젯 trip 표시 안 됨.

**측정 plan**: 새 trip 등록 → `defaults read group.com.subwaynow.app tripActive` (시뮬레이터/실기기) → 항상 0/false 확인. trip 컨텍스트 wire 후 1/true 확인.

**우선순위**: 영역 H (maxAge) 수정이 위젯 정확성 회복의 single root fix. tripContext wire는 별도 #1781 후속 PR로 trip 컨텍스트 UI 활성 (RC-15 expired-fallback 실제 동작 가능 조건).
