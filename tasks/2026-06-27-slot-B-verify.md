# Slot B 검증 — `promptDisplay` cross-trip stale stamp

## "skipped empty candidates" 결정 input field 확정

backend `evaluateAndMaybeFireBoardingPrompt`(scheduled.ts:3362~) input = **2개 필드만**: `trip.promptGeoContext`(3371), `trip.promptDisplay`(3372). `waypoints`/`routeStops` 미사용. RC-13 skip 로그(3472~3477) `{line:display.line, originStation:display.originStation, direction:geo.direction}`. backend logs 5건 모두 `line="7" originStation="용마산" direction="down"`. UTC: 04:33/34/44/45/46.

## frontend POST /trips body 구성 흐름

`useApnsTripRegistration.ts:166~196` → `callRegister()`: ① `freshContext=buildBoardingPromptContext({route,currentStation,destination})`(166) ② `promptContext = freshContext ?? cachedPromptContext`(171) — **fallback to cache** ③ POST body stamp(181~196). `buildBoardingPromptContext`(boardingPromptContext.ts:59~92): `getFirstLeg(route,destination.name)`(66); `getNextStationName(currentStation.id,destination.id,route)` — null이면 즉시 null(67); `originStation=currentStation.name`, `line=leg.line`(88~89). **`route` = 사용자 원 경로 freeze, `currentStation`만 fusion으로 갈아치워짐.**

## cross-trip 13:43:22 promptDisplay trace

POST /trips 2회 확인 (UTC 04:43:23.540 + 04:43:24.231 = KST 13:43:23/24). chain: ① `route` = **line 7 용마산→… 원본** (RC-11 #1883 freeze, HomeScreen.tsx:454~498) ② `currentStation` = **2-012(강변)** (fusion 13:43:22 7-019→2-012) ③ `getNextStationName("2-012",destId,route(line=7))` → `current.line=2` ≠ `route.fromLine=7` → `getNextStationOnLine(7,"강변")` 7호선에 "강변" 없음 → **null**(stationRoute.ts:1174) ④ `buildBoardingPromptContext` **null 반환**(68) ⑤ `freshContext=null` → `promptContext = cachedPromptContext` — 직전 cycle **`{originStation:"용마산",line:"7"}`** stamp ⑥ POST body 그대로 stale → backend KV `trip.promptDisplay` **갱신 X** ⑦ 동시 `isLockConsistentWithRoute(lock.boardingLine="2", firstLegLine="7")` → false → **lock metadata 송신 skip**(148~161) → backend KV `boardingLock=undefined` → 13:44~46 cron `lockMissing` 분기 → display "7/용마산" fetch → 0 후보 → RC-13 skip 3회.

**단일 root**: RC-11(#1883) route freeze가 cross-trip cascade에서 promptDisplay + lock metadata 동시 stale 유발.

## 영역 B 확률 업데이트

**95% → 99%**. 단일 root, 4 layer 결정적: L1 backend log `line=7/용마산` 5건 · L2 scheduled.ts:3371~3372 input = `trip.promptDisplay` 단독 · L3 `getNextStationName` 실패 → cachedPromptContext fallback · L4 RC-11 freeze → `route` 영구 line=7. 남은 1%: KV read 권한 거부, 단 log+code 동일 결론.

**보조 P2(lockMissing) = P1과 같은 root의 양면**. Slot B RCA fix **F1**(boardingPromptContext: lock 활성 시 `lock.boardingLine` + currentStation 우선)이 promptDisplay + lock 둘 다 single-fix.
