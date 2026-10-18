# 2026-06-27 Slot C 검증

## gate-hop-window 61회 effectiveHopIndex + firedAlarms 추정

dump #1 `fired=0 (last (never))` (L57). silent-push-received 3건(13:40:18, 13:41:15, 13:43:23 — 중곡/군자) 은 firedAlarms에 영향 없음 — `firedAlarmsRef.add(key)`는 `fireAndLog` 진입부(useStationAlarm.ts:705~706)에서만 일어나며 silent push는 별도 채널.

→ `inferHopIndexFromFiredAlarms(empty set, arc)` = -1 → 1191~1200 `effectiveHopIndex < 0` 분기 → `gate-hop-window-no-source` 적재 기대.

**모순**: gate-hop-window 61 vs gate-hop-window-no-source 3 (L289). 분기 다름.

해석: 13:53:43 POST /trips 200 + 13:55:10 boarding-lock/sync 200 (L422, L440)로 잠시 lock 활성. **lock cycle 동안 useFusedNearestStation이 `currentHopIndex` prop 명시 전달** → `effectiveHopIndex = currentHopIndex` (firedAlarms 우회). Estimator State (L74~82): 13:53:42 idx=12(삼성) → 13:58:28 idx=8(잠실나루) → 14:02:56 idx=9(잠실송파구청).

candidate=강변 arc idx=4, currentHopIndex=8~12, window=1 → range [7,9]~[11,13] → 4는 일관 범위 밖 → reject. Slot C 리포트 "effectiveHopIndex≈10" 결론은 일치하나 **firedAlarms 기반이 아니라 estimator-driven**. windowSize=1 환승 직후 격차 흡수 불가는 그대로 valid.

## Arrival provider 분기 (MOCK vs Seoul API)

`factory.ts:7~22` production 빌드는 `EXPO_PUBLIC_USE_BFF` 토글에 따라 Bff 또는 SeoulOpenApi만 반환. **MockArrivalProvider 분기 없음**.

(MOCK) 라벨(DebugModal.tsx:828)은 `arrival.isMock=true`일 때만. `arrival.isMock=true` 경로는 두 provider 공통 `getFallbackArrival` (arrivalApi.ts:63~83) → `hasHeadwayData(line)` true면 `buildScheduleArrival`(source='schedule', isMock=true), false면 정적 `MOCK_ARRIVALS`(source=undefined).

dump #1 14:03 (MOCK) = fallback 경로. dump #2 15:50 라벨 없음 = 실시간 응답 정상.

## ETA "13:54 도착 예정" 계산 경로

`useArrivalCountdown.ts:30` `isCountable = !isMock || source==='schedule'`. schedule fallback은 매 1초 `arrivalSeconds--` tick. buildScheduleArrival이 wall-clock anchor로 결정적 ETA → "13:54 도착 예정" 텍스트는 arrivalSeconds → 절대 시각 formatTime 변환.

정적 MOCK_ARRIVALS는 up=120s/down=240s 고정. 13:54 캡처 매우 작은 ETA = 정적 MOCK 아님 → schedule fallback. drift 원인: schedule이 평일/시간대만 보고 실 운행 무관, 1~3분 어긋남.

## 확률 업데이트

| 가설 | 이전 | 갱신 |
|---|---|---|
| LOCKLESS_HOP_WINDOW_DEFAULT=1 환승 leg reject 강변 | 85% | **92%** (estimator-driven currentHopIndex 기반, firedAlarms 아님) |
| ETA MOCK provider 원인 | 50% | **0%** (factory 분기 없음, 기각) |
| ETA Seoul API outage → schedule fallback | 신규 | **75%** |
| ETA 정적 MOCK_ARRIVALS (hasHeadwayData=false) | 신규 | **15%** (2호선은 true 예상) |

**Slot C fix 보정**: useStationAlarm.ts:1192 effectiveHopIndex 직후 route.transfers crossover 감지 시 windowSize override. ETA fix는 `source==='schedule'` 시 UI "시간표 기반" 라벨 (provider 변경 불필요).
