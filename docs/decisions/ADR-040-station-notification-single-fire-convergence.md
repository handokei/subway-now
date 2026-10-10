# ADR-040: 역 통과(station-passed) 알림 표시 경로 단일 발사 수렴

- **상태**: **채택 (Accepted)** — 2026-10-10 (사용자 결정: "1로 진행해")
- **일자**: 2026-10-08 제안 / 2026-10-10 채택
- **배경**: 사용자 지적 — "알림 표시 경로가 왜 4개나 되는거야 그냥 단일발사잖아"
- **Supersedes**: ADR-033(매역 device-FG 단일 권위) · ADR-035(도착알람 device 단일 권위) · ADR-036(발사권위 이전 완결) — **매역(station-passed) 표시 축에 한해**. 근거는 아래 §수정·대체·모순.
- **채택 근거**: 2026-10-10 조사(E+C). ①ADR-033/035/036의 종착 상태는 **hard gate가 열리지 않아 도달하지 못했다**(misexecute 아님) ②ADR-033 D1 근거 (a)의 전제(backend 지연 35~51s)가 10/9 실측 1~2s로 **소멸**했다
- **검증 상태 표기**: confirmed(코드 `file:line` / D1 / 덤프로 확인) / assumed(추론, 미검증)

## 맥락

역 통과 1건이 거치는 경로는 코드상 5개로 보이지만, 실제로 사용자에게 보이는 건 2개뿐이고 나머지는 구조적으로 죽어 있다. 죽은 경로도 로그·payload·KV write를 계속 만들어 **"살아있는 경로가 몇 개인지"를 코드만으로 알 수 없게** 만든다 — 사용자가 "4~5개"로 느끼는 이유다.

- **(A) backend visible alert push** — 살아있음, 사실상 유일한 표시 채널. `scheduled.ts:3622` `fireArvlCdStationPush`(+ `fireVanishFallbackStationPush`). 소리 정책 `:2705-2709`(매역 `sound:null`+`active`, 환승/도착 `alarm.wav`+`time-sensitive`). **collapse-id 비일관 확인**: `:3814/:4029/:4662`는 trip 단위, `:4241`(sync catch-up)만 역 단위.
- **(B) content-available 동반 silent push** — ~~구조적 no-op~~ → **🔴 2026-10-08 정정: 죽은 경로가 아니다.** 표시만 no-op이고(`silentPushTask.ts:1409-1421`이 매역 kind를 `legacy-station-kind-ignored`로 skip, #2064 의도), **그 BG wake 위에 상태 sync가 얹혀 있다**: `persistBackendSsotMirror`(`silentPushTask.ts:1050-1053`, kind 분기 **이전** 실행) + `finally`의 LA/위젯 refresh(`:1425-1446`). `apns.ts:527-533,557-568`이 명시하듯 #2092가 이 조합을 **"SSoT mirror·BG 위젯 채널 복원"** 목적으로 의도적으로 추가했다. content-available을 빼면 **wake 자체가 사라져 상태 sync가 통째로 끊긴다**.
  → **(B)는 "표시 경로"가 아니라 "상태 sync 경로"다. 제거 대상에서 제외하고, 역할을 그렇게 재명명한다.** 1단계에서 실제로 제거한 것은 (D)뿐(PR #2917).
- **(C) device 로컬 FG aux 발사** — 살아있음. `useStationAlarm.ts:304-414` `dispatchStationPassed` → `:396-410`(FG+lock+route+destination). 목적은 backend 전달 지연(실측 35~51s) 우회.
  - **#2903이 1차 가드 구현 완료**: `stationNotification.ts`의 `handleNotification`이 backend push 표시 직전 `markLocalStationFired`로 공유 store 기록 → `fireFgAuxStationPassedNotification`이 `hasRecentLocalStationFire`로 스킵.
  - **남은 공백**: 마커는 "표시된 순간"에만 생긴다 → **아직 안 왔지만 곧 올 push를 기다릴 방법이 없다**. 지금은 기다리지 않고 즉시 발사.
- **(D) legacy prescheduled 취소** — 구조적 no-op. `silentPushTask.ts:1389-1396`이 `'station-passed'` 취소를 시도하나 `AlarmLocalKind`(`alarmLocalAuthority.ts:29`)에 그 종류가 없어 대상이 존재하지 않음(ADR-026 결정 2).
- **(E) LA fallback notification** — 덤프에 다수 관측, file:line 미확인. 본 ADR 범위 밖.

## 이 ADR이 수정·대체·모순하는 결정

**ADR-033 · ADR-035 · ADR-036 세 개를 매역(station-passed) 표시 축에서 supersede한다.** 2026-10-08 초안은 ADR-033 하나만 보고 "실행되지 않았거나 롤백됐다"로 두 가능성을 열어뒀는데, 2026-10-10 조사로 **어느 쪽도 아님**이 확정됐다.

### 대체 대상과 각 결정 내용

| ADR | 날짜 | 매역 발사 Owner 결정 |
| --- | --- | --- |
| ADR-033 D1 (`:30-35`) | 8/22 | 매역 = **FG device-local 단독**. backend `fireArvlCdStationPush` intermediate kind **제거** |
| ADR-035 item 5 (`:62`) | 8/27 | 도착알람 도메인 **device 단일 권위**. `fireArvlCdStationPush` intermediate/transfer/destination visible **전부 퇴역**. ADR-026 supersede, 032·033 consolidate |
| ADR-036 Phase 2 R1 | 9/2 | 033+035를 **실행 계획으로 완결**. 종착 상태 = `backend는 silent(content-available)만`, `visible(aps.alert) 전면 제거` |

### 왜 도달하지 못했나 — hard gate가 열리지 않았다 (confirmed)

ADR-036은 Phase 2(backend visible 퇴역)를 **"Phase 1 실증 후에만"** 으로 hard-gate했고, Phase 1 D3는 **"도착알람 도메인이 FG(active)·BG(locked)·지하(arvlCd) 3환경 모두에서 device 단독 발사됨을 실기기로 검증"** 이다. 그 검증은 수행된 적이 없다.

그리고 그 device 발사 장치 전체가 `EXPO_PUBLIC_MINIMAL_ALARM` 뒤에 **dormant**다 — 이 변수는 `.env`·`.env.example` 어디에도 없고 `isMinimalAlarmEnabled()`(`src/shared/constants/debugFlags.ts:21`)는 `process.env`만 읽으므로 **항상 false**다(confirmed).

| 경로 | 역할 | 상태 |
| --- | --- | --- |
| `bgPositionTrainFire.ts:55` | #2383 position-train 발사 = ADR-036 Phase 0 축1 | `return false` |
| `bgWaypointArvlcdFire.ts:73` | BG waypoint arvlCd 발사 | `return false` |
| `undergroundConsensusFire.ts:64` | 지하 consensus 발사 | `return` |
| `stationPipeline.ts:503/636` | **G0-3 게이트 arvlCd-우회**(ADR-036 critical path) | 우회 비활성 |
| `useStationAlarm.ts:1127` | Phase 1 **D1** FG phase 발사 | 비활성 |

ADR-035 item 3이 이 상태를 이미 적어뒀다 — "`EXPO_PUBLIC_MINIMAL_ALARM` 기본값 승격 … **device 발사가 flag 뒤 dormant인 상태 종료**. (승격은 **Phase 1 검증 후**)". **승격이 일어나지 않았다.**

→ **따라서 backend visible이 살아있는 것은 misexecute가 아니라 게이트가 설계대로 닫혀 있던 결과다.** 2026-10-09 라이드가 이를 실증한다: 36분 지하 구간에서 기기의 지하 발사 장치 전체가 flag로 꺼져 있어 backend만 커버했고(D1 `cron-fire-attempt` 13역 전부 `sent`), 기기가 쏜 2건(마장 `fg station-passed`, 광화문 `bg destination`)은 flag 밖인 #2122 FG 보조 경로였다.

### ADR-033 D1 근거 (a)는 소멸했다 (confirmed)

ADR-033 D1의 1순위 근거는 **"backend 경로(35~51s)는 거짓 문구 원천"**(출처 #2122, 8/3 실측 34.6s·51.0s)이었다. 2026-10-09 실측은 **1~2초**다.

| 역 | D1 `cron-fire-attempt` 발사 | 기기 `silent-push-received` | 지연 |
| --- | --- | --- | --- |
| 왕십리(성동구청) | 11:49:24 | 11:49:26 | 2s |
| 행당 | 11:51:24 | 11:51:26 | 2s |
| 신금호 | 11:52:54 | 11:52:55 | 1s |
| 청구 | 11:54:54 | 11:54:55 | 1s |
| 동대문역사문화공원 | 11:56:54 | 11:56:55 | 1s |
| 을지로4가 | 11:58:54 | 11:58:55 | 1s |
| 종로3가 | 12:01:30 | 12:01:32 | 2s |
| 광화문(세종문화회관) | 12:03:54 | 12:03:55 | 1s |

**방법 동일성**: `buildSilentPushData`(`backend/alarm-worker/src/apns.ts:375`)가 `sentAt`(worker 시계)을 payload에 담고 기기가 `receivedAt`(device 시계)과 대조한다 — #2122가 쓴 "R2 trip-evidence sentAt/receivedAt"과 **같은 쌍**이다. 채널도 같다(#2122 본문: "매역 알림의 유일한 배너 채널이 backend alert push").

**시계 편차 배제 — 분산 논거**: 상수 시계 편차는 값을 평행이동시키지만 **분산은 보존**한다. 8월은 2건이 34.6~51.0s로 **16.4s** 벌어졌고, 10/9은 8건이 **1s** 안에 모였다. 33초 편차를 가정하면 10/9 값들이 34~51s 범위로 흩어져야 하는데 그렇지 않다. 보조로, 광화문 push는 worker 12:03:54 발사 / 기기 12:03:55 수신이라 33초 편차 시 **발사 전 수신**으로 기록돼야 한다.

**한계 (정직)**: 지연이 **왜** 줄었는지는 확정하지 못했다 — 후보는 #2909 역 단위 collapse-id(10/8) · `apns-expiration 90s` · `interruptionLevel=active` · 당일 네트워크 조건. 8월 샘플이 2건뿐인 것도 한계다. **확정된 것은 "35~51s가 상시 조건"이라는 전제가 깨졌다는 것까지**이며, "항상 1~2초"는 확정이 아니다(assumed).

**소급 재측정 불가 사유**: 전용 지표 `silentPushLatency`/`silentPushReachRatio`의 원천은 `PENDING_PUSHES` KV(`observabilityMetrics.ts:180`)이고 TTL이 **`pending:` 120s / `sent:` 5min**이다. 12시간 뒤 덤프의 `silentPushLatency=no data`·`silentPushReach(backend)=0% (0/0)`은 결함이 아니라 **설계된 보존 기간**이다. R2 `trip-evidence/`(90일)는 살아있으나 키가 `{tokenPrefix}-{tripStartedAt}`이고 그 `tripStartedAt`은 **기기 쪽 값**이라 D1 `started_at`으로 유도할 수 없으며 목록 조회 엔드포인트도 없다(`seoul-capture`에만 존재).

### 뒤집지 않는 것 (supersede 범위 한정)

- **ADR-033 D1 근거 (b)(c)는 유효하다** — (b) device-local 발사는 `shouldSuppressBySleepRule` device 게이트가 작동 (c) BG/suspend에서 매역 미발사가 안전. 본 ADR은 (a)만 무효화한다.
- **ADR-035 첫 줄 원칙은 유효하다** — "iOS 식별자 공간 분리상 **emitter가 2개면 이중발사를 물리적으로 못 막는다**". 10/9에 backend 13발 + 기기 2발이 **실제로 공존**해 이 예측이 관측됐다. 본 ADR의 "표시 책임자는 A 하나" 원칙은 이 논거를 **계승**한다 — 뒤집는 것은 "그 하나가 device여야 한다"는 부분뿐이다.
- **ADR-036 Phase 0/1의 코드 자산은 폐기하지 않는다** — `MINIMAL_ALARM` 뒤 dormant 경로의 처분은 §열려있는 결정으로 미룬다.
- **ADR-033 D2(문구 표준)·D3(취침/일반 경계)는 범위 밖** — 발사 Owner 축만 supersede한다.
- ADR-010·ADR-014·ADR-023·ADR-026 인용은 기존 결정을 뒤집지 않는다(매역 무음 유지, false positive/miss 동급).

## 결정

**원칙**: 표시 책임자는 **A 하나**. 그 책임자가 실패했다고 **device가 스스로 판단할 수 있을 때만**(유예 후 마커 미확인) 대리 **C**가 쏜다. B·D는 제거. collapse-id는 **역 단위로 통일**(사용자 승인).

| 경로 | 목표 | 조치 |
|---|---|---|
| A | **Owner 유지** | `:3814/:4029/:4662`에 station 인자 추가해 `:4241`과 통일. 매역 `sound:null` 유지(ADR-014/023) |
| C | **조건부 대리로 축소** | 유예 타이머 후 `hasRecentLocalStationFire` 재확인 → 미확인 시에만 발사. #2903 마커 재사용, 신규 인프라 없음 |
| B | ~~제거~~ → **상태 sync 소유자로 유지**(2026-10-08 정정) | 변경 없음. 표시는 하지 않지만 BG wake로 SSoT mirror·위젯·LA refresh를 담당한다(#2092). 제거하면 상태 sync가 끊긴다 |
| D | **제거** | `silentPushTask.ts:1389-1396` station-passed 분기 삭제 |
| E | **보류** | 별도 조사 |

## 대안 (기각)

1. **C 완전 제거(순수 단일 채널)** — backend 지연 35~51s 구간에 사용자가 아무 알림도 못 받는다. miss 증가로 기각(ADR-010: false positive와 miss는 동급).
   - 🔴 **2026-10-10 정정: 이 기각 근거가 소멸했다.** 위 §수정·대체·모순에서 10/9 실측 1~2s를 확정했으므로 "35~51s 구간"이 상시 조건이 아니다. ADR-035 첫 줄(emitter 2개 = 이중발사 물리적 방지 불가)은 유효하므로 **C 완전 제거가 오히려 그 원칙에 정합**한다. 재평가를 §열려있는 결정 5로 등록한다 — 다만 지연이 다시 커지는 조건(네트워크 열악·APNs 혼잡)을 측정으로 배제하기 전에는 제거하지 않는다.
2. **collapse를 trip 단위로 통일** — `collapseId.ts:51-58`의 기존 의도("최신으로 교체, 스택 방지")에 맞추는 안. 그러나 덮어쓰기가 "안 왔다"는 체감을 만든다는 분석에 사용자가 동의해 **역 단위 분리로 확정**.
3. **B·D 방치** — 기능적으로 무해하나, 본 ADR의 출발점이 "코드 표면적이 4~5개로 보이는 것"이므로 죽은 경로는 제거한다.

## 결과

- 알림센터에 역 단위로 배너가 쌓인다(trip당 1건 덮어쓰기 → 역별 유지). 매역은 무음이라 소리 스팸 아님.
- 정상 전달 트립에서 중복 배너 감소, 지연 트립에서는 유예 시간만큼 체감 지연 증가(아예 없는 것보다 나음).
- B·D 제거는 사용자 가시 동작 무변화.

## 마이그레이션

- **0단계 — collapse-id 역 단위 통일**(결정 완료, 위험 낮음). 롤백=1줄 revert. Acceptance: 역A→역B 연속 통과 replay에서 역A 배너 잔존 확인.
- **1단계 — B/D 제거**(가시 동작 무변화). Acceptance: 배포 전후 D1 fired/displayed 비율 불변.
- **2단계 — C 유예 타이머**(위험 최대). feature flag로 감싸 OFF 시 즉시 복귀. Acceptance(신규 라이드 아님, replay): ①정상 전달 트립 → 대리 발사 0 ②지연 트립(35~51s 증거) → 유예 후 대리 발사 발생. 배포 후 D1로 1주 측정.
- **3단계 — E 조사**: 별도 스코프.

## Acceptance / close 조건 (2026-10-10 추가 — L20 룰 ③)

**건드린 축 전부에 close 조건을 둔다.** ADR-039는 close 조건 4개가 전부 발사/판정 축이고 **표시 축 조건이 0개**여서, 10/9 라이드가 "LA가 한 역 뒤처짐"에도 ①도착 알림 13건 ④overshoot 0으로 **기준상 성공**으로 집계됐다(`tasks/lessons.md` L20 메커니즘 3). 본 ADR은 표시 축을 재배정하므로 표시 축 조건이 필수다.

| # | 축 | 조건 | 판정 수단 |
| --- | --- | --- | --- |
| AC1 | 발사 | 매역 push가 역마다 1회 발사 | D1 `cron-fire-attempt outcome=sent` 역별 1건 |
| AC2 | **표시** | 기기 receipt가 **표시 사실을 양성으로 기록** — `displayed=true` + `source='backend-alert'` | 덤프 `Whole Chain`의 `backend=[...]`가 역마다 채워짐. **#2930/#2933로 전제 확보** |
| AC3 | **표시** | 같은 역에 배너가 **2건 이상 쌓이지 않음**(단일 emitter 달성) | 덤프 `Notifications fired` + `source` 분포. backend·device 양쪽 발사 역 0건 |
| AC4 | **표시** | LA/위젯이 표시하는 역이 실제 진행과 **1역 이상 어긋나지 않음** | **현재 판정 불가** — `live-activity-updated` 로그에 역명/N정거장 payload 없음. §열려있는 결정 8 참조 |
| AC5 | 지연 | 매역 push 지연 p95가 "OO역 도착" 문구를 거짓으로 만들지 않음(제안 상한: 1 hop 소요시간) | **현재 소급 불가** — KV TTL 2~5분. #2905에서 90일 보존처 적재 필요 |
| AC6 | 회귀 | 지상 발사 불변 — 되는 걸 후퇴시키지 않는다(ADR-036 AC3 계승) | replay 19/19 유지 |

**close 금지 조항**: AC4·AC5는 현재 **측정 수단이 없다**. 측정 수단 없는 조건을 "해당 없음"으로 적지 않고 **미측정으로 명시**한다 — 그것이 ADR-039가 표시 축을 비워둔 방식이고 L20이 금지하는 것이다. **PR 머지는 close가 아니다**(L2).

## 열려있는 결정

1. ~~collapse 교체 vs 분리~~ — **해소**(역 단위 분리 승인).
2. **유예 윈도우 길이**(제안 15~20초) — #2905 전달률/지연 분포 측정 후 재조정.
3. **소리 등급** — 9/30 3단 우선순위와 충돌 없음(매역 무음 유지). 대리 발사도 동일 등급인지 2단계 구현 PR에서 검증.
4. **lockless 대리 포함 여부** — 현재 `lock &&` 조건이라 제외. `feedback_user_intent_equal_protection`과 충돌 가능, 별도 확인.
5. **C 완전 제거 재평가** (2026-10-10 신규) — §대안 1의 기각 근거가 소멸했다. 선행 조건: 지연 분포를 **상시 관측**할 수 있어야 한다(현재 KV TTL 2~5분으로 소급 불가). #2905 측정 설계에 "지연 p50/p95를 90일 보존처로 적재"를 포함한다.
6. **`EXPO_PUBLIC_LOCAL_FIRE_DEFER` 활성 시점** (2026-10-10 신규) — 본 ADR의 "표시 책임자는 A 하나" 원칙을 실제로 달성하는 스위치가 이 flag다(#2928, 2단계). **현재 `.env`에 없어 OFF이므로 기기는 여전히 즉시 발사하고 emitter가 2개로 공존한다**(10/9 실측 backend 13 + 기기 2). ADR이 채택됐어도 **배선은 미완**이다. 켜는 시점·검증 방법을 결정해야 한다.
7. **`MINIMAL_ALARM` 뒤 dormant 코드 처분** (2026-10-10 신규) — ADR-036 Phase 0/1 자산(`bgPositionTrainFire`·`bgWaypointArvlcdFire`·`undergroundConsensusFire`·G0-3 우회·D1 FG phase)이 flag 뒤에 남는다. 선택지: (a) 유지 — 되돌릴 여지 보존, 단 "코드 표면적" 문제 존속(본 ADR의 출발점) (b) 제거 — 표면적 축소, 단 device 권위 복귀 시 재구축 (c) 유지 + `docs/agents/invariants.md`에 "dormant, 승격 조건=Phase 1 D3" 기록. **결정 전 제거 금지.**

8. **AC4 판정 수단 신설** (2026-10-10 신규) — LA가 실제로 표시한 역/N정거장을 기록해야 AC4를 판정할 수 있다. 현재 `live-activity-updated | fired`뿐이다(`alarmLog.ts:1318`). 덤프 **빌드 식별자 부재**(build/commit/sha 0건)도 같은 묶음 — "어느 코드로 돌았나"를 덤프로 답할 수 없다.

## 리스크

- **지하**: device도 네트워크가 끊겨 "backend 미발사"와 "내 미수신"을 구분 못 함 → 현행과 큰 차이 없음. **지상 한정 개선**임을 acceptance에 명시(지하에서 "효과 없음"을 회귀로 오판 금지).
- **BG**: C는 `AppState==='active'` 조건이라 BG 무영향. 본 설계는 **FG 한정**이며 ADR-026의 "매역 로컬 폴백 0건"은 유지.
- **유예 타이머가 새 실패 지점**: 버그 시 "쏴야 할 때 안 쏨(miss)" 발생. 양방향 replay 없이는 배포 금지.
- **마커 race**: 타이머 만료와 마커 생성이 동시일 때 중복 가능 — 0단계 collapse 통일이 "동시 2건 표시" 증상을 흡수하나 완전 제거는 아님.
