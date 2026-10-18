# Emit 경로 수렴 리펙토링 (device 알림 발사 → notice router 단일화)

작성 2026-08-27. 발사 단일화(ADR-035)의 **구조적 토대** = 흩어진 device emit primitive를 `features/notice` router 단일 경로로 수렴.
본 문서는 리펙토링 착수 전 **보존 의무 SSoT** — 모든 migration 이슈/PR은 이 문서의 매트릭스·사고방지 체크리스트를 근거로 작성한다.

---

## 🔴 0. 재조사 정정 (2026-08-27, 확실화 후) — 초안 전제 2개 뒤집힘
착수 전 router 구현을 직접 읽어 아래 2개를 정정. **이 절이 §1~§3보다 우선한다.**

- **정정1 — F1(device-authority 역행)은 현존 blocker 아님**: router `gate-alarm-not-in-ssot`(alarmEvents 게이트)는 **미구현**(NotificationRouterImpl 주석 "후속 PR 예정"). wired된 건 `passedStations` 게이트뿐 + stale>5분 auto-pass → device fire reject 안 함. §2-B는 "미래 wire 시에만" 유효.
- **정정2 — notice router는 dormant scaffolding**: `deliver()` production 호출 **0개**(유일 실사용 `clearAllForTrip`). ADR-017 T12(#1575, 2026-06-20) 산물인데 fire-path wiring 미완. 현 ADR-035(device 권위)는 router 미언급.
- **de facto authority = `firedAlarms`**(158 refs): stationPipeline + bgPositionTrainFire + undergroundConsensusFire 전부 `getFiredAlarms`/`alarmKey`로 수렴. 나머지 dedup 6종은 보조 게이트(경쟁 authority 아님).
- **router 제거 비용 ≈ 0**: 외부 소비자는 DebugModal "Notification Delivery" 하나인데 deliver() 미호출로 항상 빈 로그.
- **결론**: "emit→router 수렴"은 죽은 scaffolding 되살리기(중복 choke point). 실질 리펙토링 = (a) dead router 제거 (b) emit primitive 3개→헬퍼 1개. 진짜 scatter는 device↔backend(ADR-035 Phase2).
- **✅ 방향 결정(2026-08-27): B = firedAlarms authority 확정 + dead router 제거.** T2 = **#2391 → PR #2392 dev 머지 완료**(behavior-preserving, 발사/dedup 0줄). emit primitive 헬퍼 수렴(b)은 저가치 churn 의심 → 보류(진짜 단일화는 Phase2 backend 퇴역).
- **✅ T1(ETA lockless) = #2393 → PR #2394 dev 머지 완료**: `isInTripByEvidence` 공통 헬퍼(HomeScreen+stationPipeline), firedAlarms non-empty를 in-trip 신호 추가(#2154/#2290 준수). 코드-only, **ETA=1분 실증은 탑승 번들에서**.
- **탑승 실증 = 맨 마지막**(번들 1회). T1(ETA #2290 lockless)은 "버그 vs #2290 의도된 과다표시" 판정 미결 — 착수 전 설계 판정 필요(route-progress 재사용이 #2154 위반/#2290 설계 역행인지). Phase2 backend 퇴역은 탑승 결과 hard-gate.

---

## 1. Emit 부가역할 매트릭스 (2026-08-27 실측)

| emit site | surface | trigger | dedup 원장 | 위젯 fwd | backend mirror 게이트 | 판정 |
|---|---|---|---|---|---|---|
| **`notice deliver()`** (목표) | banner+widget+in-app+LA | — | ✅ (alarmId,surface) | ✅ surface.widget | ✅ gate-not-in-ssot | **수렴 도착점** |
| `fireLocalAlarmNotification` (stationNotification.ts:578→74) | banner | null | caller `markStationFired` | ✗ | ✗ | **migrate → router.banner** |
| `fireFgAuxStationPassedNotification` (stationNotification.ts) | banner | null | self `markLocalStationFired` + **backend collapse-id 매칭(#2063/#2086)** | ✗ | (token gate) | **migrate** (collapse-id 규칙 보존 필수) |
| `silentPushTask` skew-fallback (tasks/silentPushTask.ts:1602) | banner | null | `addFiredPushId` + `markLocalStationFired` | ✗ | sleep read | **migrate 후보** (ledger 2종 보존) |
| `safetyNetScheduler.ts:216` | banner (alarm.wav, MAX) | scheduled | 자체 occurrenceIdx + delivered-tray cleanup(#1924) | ✗ | ✗ (backstop) | **🔒 독립 유지** |
| `lastTrainAlarm.ts:155` | banner (막차) | null | ✗ | ✗ | ✗ | **🔒 독립 유지** (별 도메인) |

**router 밖 위젯 forward 2곳 (emit primitive 아님, orchestrator):**
- `undergroundConsensusFire.ts:167`, `bgPositionTrainFire.ts:170` → `saveStationToWidget` 직접. 수렴 대상이나 별 트랙(후속).

---

## 2. 사고 방지 체크리스트 (동일 사고 + 신규 사고)

리펙토링/이관 PR은 아래 A~E를 본문에서 각각 판정한다. 하나라도 미판정이면 머지 금지.

### A. 【동일 사고 재발】 채널 dual-role severing (2026-07-30, #2063→#2092)
- emit 경로를 옮기면 그 emit이 **부가로 지던 역할**(SSoT mirror 갱신 / BG 위젯 forward / dedup 원장 기록)이 함께 안 옮겨져 알림·실시간성 두절.
- **방지**: migration PR에 "이관 전 부가역할 → 이관 후 보존" 대조표 필수. 해당 emit·채널의 **소비자 전수** 명시 후 각각 생존 판정.
- 출처 lesson: `memory/lesson_channel_dual_role_severed_on_redesign.md`

### B. 【신규·hard-gate】 device-authority 역행 (F1)
- notice router의 `gate-alarm-not-in-ssot`은 "backend mirror fresh인데 alarmId 부재 → reject". device 단일권위 fire는 **backend 없이 발사돼야** 하는 게 존재 이유(ADR-035) → 그대로 태우면 device fire가 reject = **backend 재종속 = ADR-035 역행**.
- **방지**: router에 device-authority mirror-bypass **선행(F1)** 없이는 어떤 migrate PR도 머지 금지. F1 = 직렬 hard-gate.

### C. 【신규】 backstop / 별도메인 억제
- `safetyNet`(outage backstop)을 router로 수렴시키면 게이트/dedup에 걸려 **backstop이 죽음** — 메인 경로 죽어도 살아야 하는 게 존재 이유. `lastTrain`은 도착알람 아님.
- **방지**: safetyNet·lastTrain은 수렴 대상에서 **명시 제외**. 이관 목록에 넣지 않는다.

### D. 【신규】 collapse-id 파손
- `fireFgAux`의 backend collapse-id 매칭 규칙(`buildStationNotifCollapseId`, #2063/#2086)이 깨지면 뒤늦은 backend push가 로컬 알림을 교체 못 해 **중복 배너**.
- **방지**: collapse-id 빌드 규칙·identifier를 이관 후에도 동일 유지 검증.

### E. 【신규】 dedup 원장 유실
- `markStationFired`/`markLocalStationFired`/`addFiredPushId` 기록이 이관 중 누락 → dedup 붕괴 → spam 재발(#1575 destination-early 88건 회귀 클래스).
- **방지**: 각 site의 ledger 기록을 이관 후에도 **동일 시점·동일 인자**로 유지. 회귀 테스트로 "2회 fire = 1 deliver + 1 suppress" 보존.

### F. 【신규】 병렬 BG 충돌
- 여러 agent가 router 인터페이스 동시 수정 → 발산.
- **방지**: F1/F2(foundation) **직렬 선행**. migrate PR은 서로 다른 파일만 병렬. worktree isolation 필수.

---

## 3. 시퀀싱

```
[직렬 선행] F1: router device-authority mirror-bypass   ← 모든 migrate 의존, 단일 PR (사고 B 방지)
[직렬 선행] F2: router.banner가 collapse-id/ledger 인자 수용 (F1과 묶어도 됨)
        ▼
[병렬 BG · worktree · sonnet · 1 PR each]
   ├ P1: fireLocalAlarmNotification → router.banner   (체크 A,E)
   ├ P2: fireFgAux → router.banner                    (체크 A,D,E)
   └ P3: silentPush skew-fallback → router.banner      (체크 A,E)
[제외·독립 유지] safetyNet, lastTrain                   (체크 C)
[별 트랙·후속] undergroundConsensus/bgPositionTrain 위젯 forward → router.widget
```

병렬 BG = P1/P2/P3 3개. F1/F2는 병렬 선행 직렬. safetyNet·lastTrain은 손대지 않음.

관련: ADR-035, #1575(router), #2063/#2086(collapse-id), #2092(채널 severing fix), `memory/lesson_emit_consolidation_notice_router_hazards.md`
