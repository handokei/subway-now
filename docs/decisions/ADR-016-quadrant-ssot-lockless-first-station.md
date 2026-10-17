# ADR-016 — 4분면 SSOT 통합 + Lockless 첫 station miss 0 + autoLock/boardingPrompt 재설계

## 상태

Active (재활성화 2026-06-20). Epic #1533. T1~S2 머지 (`S2 #1535는 ADR-017 T8 #1561 흡수 close`). **S1 #1534 / S3 #1536 / #1526 / S11 #1544 재활성화** — 2026-06-20 trip evidence (boardingPrompt 7일 0건 + autoLock direction-mismatch) 직접 회귀 cover.

## 배경

### 2026-06-19 PM Phase 1 (S0/M1) 완료

Phase 1 6 PR 머지(#1547~#1552). 4분면 SSOT 통합 + lockless 첫 station miss 0 acceptance 일부 달성.

### 2026-06-20 trip dump evidence — Phase 2 회귀

`/Users/kimdohan/Downloads/텍스트-55EFF2BEC7B2-1.txt` (1.5h lockless trip):

```
## Auto-lock Candidate
ssot=surface+underground
stability=stable count=5 stationId=2-012   ← stability 추출 OK
direction=mismatch reason=no-route          ← 9-AND gate fail
candidate=null reason=direction-mismatch

## Boarding Prompt Acceptance
displayed=0, responded=0, boarded=0 × 7일 누적
```

= **stability 추출 작동** + **direction-match 게이트가 route 없다고 거부** → autoLock 0 + boardingPrompt 7일 누적 0건.

### 머지된 prompt fix 14건에도 dump 7일 0건

- #1387 (06-16) boardingPrompt displayed wire-up
- #1420 (06-17) BG drain
- #1303 (06-14) context 안정화
- #1456 (06-18) backend fire 재설계 (ADR-015)
- #1320 (06-15) lockless trainCode 바인딩
- #1138 (06-11) boardingPrompt 발사 빈도 monitor
- #1188 (06-11) [탑승] 응답 autoLock fallback
- #1128 (06-10) attemptAutoLock confidence gate
- #1427 (06-17) device-side auto-lock 측정 인프라
- ...총 14건

= 인프라 정의 ↔ consumer 연결의 단절(Wire-completion 미강제) = 한 달 회귀 패턴 root cause.

### 사용자 핵심 인사이트

> "lockless라는게 말이 안되는게 lock을 안해도 우리는 train코드를 보고서 알림 탑승했는지에 대한 탑승 여부 알림푸시를 발사하고 LA도 해놨는데... 처음 시작은 lockless였을 지 몰라도 backend에서 traincode를나 position을 보고 이동중이구나 하고서 알림 푸시를 어떻게든 발사한 이후에 거기서 lock을 걸게 되는거잖아"

→ lockless = transitional state로 강등 + backend advance 결정 = lock 자동 forward.

## 결정

### 원칙 1 — 4분면 SSOT 통합 (Phase 1 머지 완료)

surface / underground / transition / unknown 4분면 환경 SSOT. 각 분면 진입/이탈 조건 결정. ADR-015 §3/§4 통합.

### 원칙 2 — Lockless 재정의 (사용자 룰)

**기존**: lockless = "출발역 모르는 trip의 영구 상태"
**신규**: lockless = **trip 등록 ~ 첫 advance 1~3 cycle transitional state**

| 상태 | 조건 | 동작 |
|------|------|------|
| transitional | `tripStartedAt < 5min` AND `!lockSuggestion` | 정상. cascade GPS-only fallback OK ([[feedback_lockless_redefinition]]) |
| **persistent lockless = X11 회귀** | `tripStartedAt > 5min` AND `!lockSuggestion` | auto-end 검토 또는 silence 강제 |
| post-advance | `lockSuggestion` 도달 | lock 자동 전환 (S1 #1534) |

### 원칙 3 — Backend lockSuggestion forward (T9b, S1 #1534 흡수)

backend `advanceTripPosition` 성공 시 SSoT에 `lockSuggestion` 추가:

```ts
interface TripPositionSSoT {
  // 기존
  currentStationId, motionState, passedStations, alarmEvents, ...
  // T9b 신규
  lockSuggestion?: {
    stationId: StationId;
    trainCode: string;             // arvlcd btrainNo
    lineId: string;
    confidence: 'high' | 'medium' | 'low';   // advance evidence type 기반
    decidedAt: number;
  };
}
```

device boardingLock 결정 권한:
- **1순위**: backend `lockSuggestion` reader-only 채택 (advance와 동급 confidence)
- **2순위**: 현재 9-AND gate (lockSuggestion 없을 때만 fallback)

silent push payload SSoT mirror에 `lockSuggestion` 슬롯 추가 (`apns.ts:175-186` `SilentPushSsotPayload`). device validator (`silentPushTask.ts:424-447` `validSsotMirror`) 확장.

### 원칙 4 — boardingPrompt + autoLock trigger 재설계 (T13, S3 #1536 흡수)

**현재**: backend cron 9-AND gate 통과 시 발사
**사용자 룰**: trip 등록 즉시 LA Interactive + boardingPrompt UI 활성화 (cron 9-AND gate 우회)

trigger 재설계:
- POST /trips 성공 시 device가 즉시 LA Interactive + boardingPrompt UI mount
- backend cron 9-AND gate는 fallback (lockSuggestion 못 보내는 케이스)
- 9-AND gate direction-match → backend SSoT.direction reader-only (route 안 거치고)
- UI는 'A → B 방면' 형태 (trainCode 노출 X, [[feedback_la_interactive_unified_with_boarding_prompt]])

### 원칙 5 — 5-layer wire 검증 (#1526 acceptance evidence)

| Layer | 위치 | 검증 |
|-------|------|------|
| L1 backend cron 호출 | `boardingPrompt.ts:95` | wrangler log evidence (매분 호출 grep) |
| L2 9-AND gate 통과 | direction-match + GPS-series 5개 | 통합 테스트 + lockSuggestion fallback 채택 |
| L3 silent push 발사 | backend → APNS | alarmLog `boardingPrompt-push-fired` ≥ 1건 |
| L4 device UI mount | HomeScreen boardingPrompt component | alarmLog `boardingPrompt-ui-mounted` ≥ 1건 |
| L5 응답 → POST | `/boarding-lock/sync` | alarmLog `boardingPrompt-response-posted` ≥ 1건 |

5단 evidence 모두 production trip에서 확인되어야 #1526 close.

### 원칙 6 — Wire-completion gate (모든 sub-task close 조건)

신규 코드는 5단 검증 통과해야 close. 인프라 정의는 있는데 consumer 누락 패턴 차단 ([[feedback_wire_completion_gate]]):

1. 신규 상수/타입/필드: grep import + read ≥ 1
2. 신규 hook/함수: 호출자 ≥ 1 + consumer 도달
3. 신규 store mutation: subscribe selector ≥ 1
4. 신규 게이트/패스: 통합 테스트 + production alarmLog evidence
5. 기존 호출 deprecation: refactor 후 직접 호출 0건 grep

evidence: 머지된 prompt fix 14건에도 dump 7일 0건 = Wire-completion 미강제 정확한 비용.

## Sub-task 매핑

| Sub | 내용 | 상태 |
|-----|------|------|
| S1 #1534 | Trip 등록 GAP A + instant autoLock + LA Interactive trigger 분리 + **T9b lockSuggestion forward 흡수** | **OPEN (재활성화)** |
| S2 #1535 | silent push currentStationId + cascade | ADR-017 T8 #1561 흡수 close |
| S3 #1536 | 9-AND gate 환경 분기 + **T13 trigger 재설계 흡수** | **OPEN (재활성화)** |
| S4~S6 | realtimePosition 폴링 / pre-scheduled / passedStations | ADR-017 T1/T3에 통합 |
| S7~S10 | device-side / docs | independent |
| S11 #1544 | App Intents + Focus 자동화 + lockless UI 명시 | OPEN |
| **#1526** | autoLock SSOT 출발역 stability 추출 — **acceptance evidence sub-task** | **OPEN (재활성화)** |

## 머지 순서

1. **S1 #1534** (T9b lockSuggestion forward) — ADR-017 T9 V8(e) prerequisite
2. **S3 #1536** (T13 trigger 재설계) — S1과 cross-cut, T9 #1572와 병렬 가능
3. **S11 #1544** (App Intents + Focus) — 독립
4. **#1526** (5-layer wire 검증) — S1 + S3 머지 후 1주 production 측정

## ADR-017과의 관계

ADR-017이 backend SSoT 구조 + device fire gate를, ADR-016이 lockless 재정의 + autoLock/boardingPrompt 재설계를 담당. 두 ADR이 cross-cut:

| ADR-016 sub | ADR-017 통합 |
|---|---|
| S1 #1534 T9b lockSuggestion | ADR-017 T9 #1572의 V8(e) prerequisite |
| S3 #1536 T13 trigger 재설계 | ADR-017 NotificationRouter (T12 #1575) trigger 통합 |
| #1526 acceptance evidence | ADR-017 V/X acceptance 5-layer wire 검증 |

ADR-019 신설 X — 본 ADR-016 재활성화로 처리.

## Acceptance — Wire-completion + 다운로드 가치 V/X 매핑

### V/X 매핑 (cross-cutting)

| V/X | 측정 임계 | ADR-016 sub-task | ADR-017 sub-task |
|-----|----------|------------------|------------------|
| V2 환승 1역 전 알람 | hop ≥ 2 시만, ±10s | S1 (T9b lock 전환 → hop 산출) | T7 ✅, T9 #1572 |
| V3 도착 1역 전 알람 | hop ≥ 2 시만, ±10s | 동일 | 동일 |
| V7 지하 station-passed 정확 | advance ≥ 90% | S3 (9-AND gate 환경 분기) | T11 #1574 |
| X9 사용자 의도 외 fire | 0건 | S1 + S3 (정확한 lock + trigger) | T9 + T10 + T12 |
| **X11 persistent lockless** | 5분+ lockless = 0건 | S1 (lockSuggestion forward) | T10 #1573 (6h backstop) |
| **acceptance evidence (핵심)** | boardingPrompt displayed ≥ 1건/trip | **#1526** | — |

### 측정 acceptance — 1주 production

S1 #1534 + S3 #1536 머지 후:
- boardingPrompt displayed ≥ 1건/trip (지하 trip 포함)
- responded rate ≥ 30%
- boarded rate ≥ 60% (응답 중)
- 7일 누적 displayed = 0건이면 #1526 close 불가 + revert

### Wire-completion 강제

각 sub-task PR이 close 되려면 5단 검증 통과 (위 원칙 6). #1526가 acceptance evidence sub-task로 5-layer wire 검증 전담.

## 사용자 vision 매핑

| 원칙 | ADR-016 구현 |
|---|---|
| "lockless 처음 시작 후 backend가 traincode/position 보고 lock 전환" | S1 #1534 T9b lockSuggestion forward |
| "lock 안 해도 train code로 알림 발사" | S3 #1536 T13 trigger 분리 (trip 등록 즉시) |
| "trainCode 노출 X, A → B 방면 UI" | S3 #1536 LA Interactive UI 재설계 |
| "Wire-completion 원천 차단" | 원칙 6 + #1526 5-layer 검증 |
| "사용자 가치 → acceptance → 코드" | V/X 매핑 + 측정 acceptance |

## 참고

- Epic #1533
- ADR-017 (backend SSoT + device fire gate) — cross-cut
- 2026-06-20 trip evidence: `/Users/kimdohan/Downloads/텍스트-55EFF2BEC7B2-1.txt`
- 선행 ADR: ADR-010 (sensor fusion), ADR-013 (lockless supplementation), ADR-015 (multi-signal consensus)
- 후속 강제 doc: `docs/requirements/15-trip-alarm-notification.md` (cross-cutting acceptance + Wire-completion + V8 4 mitigation + lockless 재정의)
- 관련 mem: [[feedback_lockless_redefinition]], [[feedback_wire_completion_gate]], [[feedback_la_interactive_unified_with_boarding_prompt]], [[lesson_boarding_prompt_9and_gate_gps_only]], [[project_lockless_first_station_miss_zero]]
- ADR-019 신설 X — 본 ADR-016 재활성화로 처리
