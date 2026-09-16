# ADR-033 — 매역 진행 알림: Device-FG 단일 권위 + 문구/취침 경계 재정의

## 상태

Proposed — 2026-08-22. 사용자 결정 세션(취침모드 P1 + 알림 문구 회귀) 결과. ADR-023 2026-07-29 개정을 **매역(intermediate station-passed) 채널에 한해** 부분 supersede. ADR-024 알림 채널 정의를 매역 채널에 대해 재조정. 환승/도착 채널 및 취침 loud-wake-in-suspend 소유권은 본 ADR 범위 밖(후자는 OPEN).

## 배경

2026-08-21~22 사용자 검증 세션에서 3가지가 확정됐다:

1. **매역 알림 문구 회귀** — 사용자에게 "OO역 통과 / OO역을 지나고 있어요"(`route.intermediatePassedTitle`/`intermediatePassedBody`) 문구가 오고 있으나, 사용자는 이 문구를 의도한 적이 없다. 원했던 것은 "**OO역 도착 / 환승역까지 N정거장 남음**"(도착 확정 + 남은 정거장 카운트)이다.
2. **채널 지연 문제** — 매역 알림이 backend visible push(`fireArvlCdStationPush`, #2063)를 통해도 오는데, backend→device APNs 전달이 실측 35~51s(#2122). "OO역 도착"은 도착 순간 진실이어야 하는데 backend 경로에선 열차가 이미 그 역을 떠난 뒤 도착해 **거짓 문구**가 된다.
3. **취침/일반 혼선** — 과거 `stationPrescheduler`(#918)가 일반 모드에서 loud로 발사되던 회귀(#2158)가 있었고 #2202로 OS 사전예약 채널이 퇴역됐다. 현재 매역 알림은 무음이나, 취침(매역 억제)·일반(매역 노출)·일반 도착(gentle) 경계를 acceptance로 재확정할 필요가 있다.

### FG 판정 메커니즘 (근거)

FG에서 device는 backend 없이 자체 판정한다: `useNearestStation`(GPS 30s) + `useArrivalInfo`(Seoul arvlCd 30s)를 device가 직접 폴링 → 열차가 경로상 다음 waypoint에 진입/도착(arvlCd∈{0,1})했다고 판정 → `useStationAlarm`이 dedup/cross-category/hop-window/movement/silence/SSoT 게이트 통과 후 `fireFgAuxStationPassedNotification`으로 **로컬 즉시 발사**(#2122). backend 왕복이 없어 지연이 sub-second다.

### 지하 커버 (근거 + 한계)

지하에서 GPS는 무쓸모다. 역 식별 SSoT는 `useFusedNearestStation`의 티어 캐스케이드로 넘어간다:
- `gps-fast-path` — 지상 전용(지하 사멸).
- **`arvl-arrived-match`** — arvlCd 도착 신호로 역 식별(지하 주력).
- `undergroundSSOTConsensus` — 기압-정지 / 모션-정지 / arvlcd-도착 중 **≥2 합의**로 역 판정(#1290, GPS 독립, "device self-contained fusion").

즉 지하 매역 식별은 "arvlCd 단독"이 아니라 **arvlCd + 센서 합의**다. 이 합의 티어의 **정확성(항상 올바른 역을 집는가)은 이 프로젝트의 핵심 미해결 문제**이며(fusion 티어 회귀 다수: tier-lock 고착, arc 폭주, motion 5~10분 뒤집힘, lockless 시간적분), **CI로 증명 불가 · 실기기 탑승으로만 close**된다.

## 결정

### D1 — 매역 진행 알림은 Device-FG 단일 권위

매역(intermediate station-passed) 진행 알림의 발사 주체를 **FG device-local 단독**으로 한다. backend `fireArvlCdStationPush`의 intermediate/station-passed kind 발사는 제거한다(환승/도착 kind는 유지).

- **근거**: (a) FG device-local은 지연 sub-second라 "OO역 도착" 문구가 항상 진실. backend 경로(35~51s)는 거짓 문구 원천. (b) device-local 발사는 device가 렌더링 주체 → `shouldSuppressBySleepRule` device 게이트가 다시 작동 → ADR-023 2026-07-29 개정이 근거로 든 "visible push는 device가 사후 억제 불가"가 **매역 채널에선 해소**된다. (c) BG/suspend에서 매역은 정보성이므로 미발사가 안전(자는데 느린 매역 push 스팸 방지).
- **ADR-023 2026-07-29 개정과의 관계**: 그 개정은 "매역을 visible push로 전환 → device 사후억제 불가 → backend sleep 분기"였다. 본 결정은 매역을 device-local로 되돌려 그 전제를 무효화하므로, **매역 채널에 한해** 해당 개정을 supersede한다. 환승/도착 및 취침 알람 주 채널의 backend 분기는 본 ADR 범위 밖(변경 없음).

### D2 — 문구 표준: "OO역 도착 / {대상}까지 N정거장 남음"

- title: `route.stationPassed`("{{name}}역 도착") 계열. "통과/지나고 있어요"(`intermediatePassedTitle`/`intermediatePassedBody`) 폐기.
- body: 남은 정거장 카운트. 환승 전 구간 → "환승역까지 N정거장", 환승 후 구간 → "도착역까지 N정거장"(`stopsRemainingToDestination`/`stopsRemainingViaTransfer` 재사용). 대상(target kind/name)과 count를 발사 시점에 route/lock/hopIndex에서 도출해 알림 빌더까지 배선한다(현재 `fireFgAuxStationPassedNotification`은 역이름만 받아 count 미보유 — 배선 갭).

### D3 — 취침/일반 경계

| 이벤트 | 일반 모드 | 취침 모드 |
|---|---|---|
| 매역 진행 | 알림(gentle, FG only) | **억제** |
| 환승 | 알림 | loud wake |
| 도착 | **알림(gentle)** — 알람 아님 | loud wake |

- 취침 매역 억제는 `shouldSuppressBySleepRule`(transfer/station-passed 첫 hop, destination 항상 통과) 정책 유지.
- **일반 모드 도착은 loud 알람이 아니라 gentle 알림**(사용자 명시: "알람 말고 알림"). #2158류(일반 모드 loud) 회귀 재발 가드 필수.

### D4 — 취침 loud-wake-in-suspend 소유권: OPEN (보류)

폰이 deep-suspend(지하+저전력)일 때 취침 loud wake는 device 코드가 안 돌아 backend만 발사 가능하나, backend가 loud/gentle을 정하려면 sleep 상태를 알아야 하고 그 상태는 POST 동기화라 stale 리스크가 있다. 해법 후보 (A) backend 소유+staleness-bound heartbeat / (B) device 로컬 예약(ETA 기반)은 **backend push가 deep-suspend 폰에 실제로 도달하는지 미검증**이라 지금 결정하지 않는다. **실기기 탑승(저전력ON+지하+취침)에서 backend fire 로그(#2347) ↔ device 수신 시각 대조로 도달·지연을 측정한 뒤 별도 ADR로 결정**한다.

## Acceptance (사용자 가치 → acceptance → 코드)

| # | 항목 | 검증 | close 게이트 |
|---|---|---|---|
| A1 | 매역 문구 "OO역 도착 / {대상}까지 N정거장 남음" | unit + i18n(ko/en/ja/zh) | CI |
| A2 | count·target 발사 시점 배선(환승 전 "환승역까지" / 후 "도착역까지") | unit | CI |
| A3 | 취침=매역 억제 / 일반=매역 노출 | 시나리오 테스트 | CI |
| A4 | 일반 도착=gentle 알림(loud 아님), #2158류 회귀 가드 | 시나리오 테스트 | CI |
| A5 | movement 게이트가 지하(GPS speed 불명)에서 유효 arvlCd 매역을 오억제하지 않음 | unit + 조사 | CI + 탑승 |
| A6 | backend 매역 push 제거 | code | **🔴 지하 FG fusion 매역 발사 실기기 확인 후에만 머지** |
| A7 | 지하 매역 정확성(arvl-arrived-match가 올바른 역) | — | 🔴 fusion 신뢰성, 탑승 전용 |
| A8 | 취침 loud-wake-in-suspend 도달 측정 | — | 🔴 탑승 측정 → D4 결정 |

**A6는 A7이 실기기로 확인되기 전 머지 금지** — 순서 역전 시 지하 매역 알림 전면 공백 리스크. 2단계(FG 로컬 발사 선반영 → 탑승 확인 → backend push 제거).

## 구현 지점

- 문구/빌더: `src/features/alarm/utils/stationNotification.ts`(`buildStationPassedContent`, `fireFgAuxStationPassedNotification`), locale `src/shared/i18n/locales/*.json`.
- 발사 호출부/배선: `src/features/alarm/hooks/useStationAlarm.ts:270`(FG aux 호출), count/target 도출.
- movement 게이트: `useStationAlarm.ts:1500-1511`(#727/#728/#733 정적 misfire 가드) 지하 경로.
- backend 제거: `backend/alarm-worker/src/scheduled.ts`(`fireArvlCdStationPush` intermediate/station-passed kind), backend i18n `backend/alarm-worker/src/i18n.ts`.
- 취침 게이트: `src/features/alarm/utils/shouldSuppressBySleepRule.ts`(정책 유지).

## 관련

- **ADR-023** — 취침 backend/device 경계. 2026-07-29 개정을 매역 채널에 한해 supersede.
- **ADR-024** — 알림≠알람 분리. 매역 채널의 "visible push 1차" 전제를 device-local로 조정.
- **ADR-026** — Fire-authority single-emitter. 매역 단일 emitter = device-FG로 확정(정합).
- **#2122** — FG 보조 발사(APNs 35~51s 우회). 본 ADR이 이를 매역 정식 채널로 승격.
- **#2202** — OS 사전예약 매역 채널 퇴역(선행).
- **#918/#2063/#2066** — 매역 backend 채널 계보(본 ADR로 intermediate kind 정리).
