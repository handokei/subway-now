# ADR-031 — fire/SSoT 아키텍처 대규모 트래픽 재설계 (글로벌 cron → per-trip DO + SSoT transport 재정의)

- **Status**: Proposed. Phase 0(저위험, DO 없음)부터 tracer-bullet.
- **Supersedes(부분)**: 순수-silent SSoT-forward 결정. **Builds on**: ADR-017/#1553(Backend Trip Position SSoT), ADR-026(단일 emitter, **불변**), ADR-023/#2063(silent→visible).
- **분석**: 2026-08-09 silent-push deadlock RCA + 대규모 트래픽 요구.

---

## Context — 두 개의 구조 문제

### 문제 1 — silent push SSoT-forward deadlock
- backend에 **독립 SSoT-forward 채널 없음.** SSoT는 fire 이벤트 payload에만 piggyback (`scheduled.ts:2447/2847/3767/4281`, `toSilentPushSsot` `:1845`).
- device 채택 = `ssotStation≠null AND ssotFresh(lastAdvanceAt≤180s) AND silentPushHealthy(60s)` (`useFusedNearestStation.ts:1159`).
- **deadlock**: 지하·정지 → fire 게이트(`scheduled.ts:4188/4205`) 차단 → (i) push 0 → 60s 뒤 `silentPushHealthy=false`, (ii) advance 0 → `lastAdvanceAt` stale → 180s 뒤 `ssotFresh=false`. 두 조건 붕괴 → backend-ssot 영구 미채택. 가장 필요한 지하에서 死.

### 문제 2 — 글로벌 cron O(N) 스케일 병목
- `wrangler.toml:108` `*/1 * * * *` → `scheduled.ts:1207` `for trip of listTrips()` 전수 순회 + trip당 `readSsot`(≥1 KV read) + line/station self-poll subrequest. **O(활성 trip)를 고정 1/min.**
- 러시 N=5000 → ≈5000 KV read/min + subrequest 선형. 유휴에도 비용(`wrangler.toml:116` #2055 — 0명인데 quota burn, `lesson_cf_free_quota_cron_kv_burn`).

### 이미 존재하는 지렛대
- **foreground-pull 배관 존재**: `POST /position`(`index.ts:1478`)이 SSoT 일부(`originStationId`+`lockSuggestion`만, `:1536`)를 응답에 embed. device `persistFromPositionResponse`(`positionUpload.ts:362`)가 mirror write. **단 `lastAdvanceAt = lockSuggestion?.decidedAt ?? 0`(`:375`)이라 lockSuggestion 없으면 never fresh** → 오늘의 pull은 adoption freshness를 못 갱신. Phase 0의 지렛대.
- 경로 1(`scheduled.ts:2447`)은 이미 **visible+contentAvailable**로 SSoT 전달(ADR-023 정합). 순수-silent는 경로 3/4뿐.

---

## Decision — 타겟 아키텍처

### (a) SSoT transport 재정의 (silent 은퇴)
- 순수-silent 경로(3/4) 은퇴 → SSoT를 **visible fire payload에 통합**(경로 1과 동형, `contentAvailable:true` 병기로 BG task wake). **silent push는 발사·전송 모두에서 은퇴** (ADR-026 단일 emitter 재확인).
- **foreground pull 보완(Option D)**: `POST /position` 응답을 **full SSoT**(`toSilentPushSsot`)로 확장. device는 push 없이도 FG cycle(~10s)마다 mirror 갱신.
- **adoption을 push 건강과 분리**: freshness를 `lastAdvanceAt`이 아닌 **mirror `receivedAt`**(backend가 이 trip을 여전히 추적 중이라는 신호) 기반으로. `silentPushHealthy` AND-gate 제거(또는 BG-only 강등). → 지하·정지 non-advancing trip도 backend 생존 시 채택 유지 → **deadlock 해소**.

### (b) per-trip Durable Object + self-alarm (event-driven)
- **1 trip = 1 DO**(`env.TRIP_DO.getByName(tripToken)`). 글로벌 DO 금지.
- storage: DO SQLite(`new_sqlite_classes`). trip row + SSoT row 이주. persist-first.
- **self-alarm**: register/position 시 다음 fire 시각으로 `ctx.storage.setAlarm()`. `alarm()`이 **그 trip만** fire 평가(기존 `fireArvlCdStationPush` 등 재사용) → visible push 1발. DO당 alarm 1개 = trip당 "다음 fire" 1개와 정합.
- 요청 모델: (i) `POST /position` RPC → state update + full SSoT 반환(pull), (ii) `alarm()` → fire + visible push(단일 emitter), (iii) `POST /trips` → seed + 최초 alarm. **글로벌 스캔 없음.**
- alarm auto-retry → **idempotent 필수**: #2230 `rescheduleDedup` + #2243 검증 게이트를 alarm fire 경로에 유지.

### (c) foreground pull
- FG 전용·10s throttle·`tripActive` 게이트(`useFgPositionUpload.ts`)로 self-limit. push=이벤트(역 통과), pull=FG 관측 시. 연속 폴링 아님.

**DO 한도/과금 (구현 전 재확인 필수 — 백엔드 free-quota 민감)**: DO 인스턴스 수평 독립(러시 수천 정상), alarm 1/DO(setAlarm replace), alarm retry→idempotent, eviction 시 in-memory 소실→persist-first. **Free plan DO SQLite 가용/한도 재검증.**

---

## Migration — tracer-bullet (각 단계 독립 배포 + 롤백)

### Phase 0 — deadlock 즉시 완화 (DO 없음, 저위험) ★
1. backend `index.ts:1536`: `POST /position` 응답을 `toSilentPushSsot(ssot)` full SSoT로 확장(additive).
2. device `positionUpload.ts:362`: full mirror write(`lastAdvanceAt`/`receivedAt`).
3. device `useFusedNearestStation.ts:1159`: `backendSsotAccepts` freshness를 **`receivedAt` 기반**으로 재정의 + `silentPushHealthy` AND-gate 제거(또는 BG-only).
- 위험: 낮음(additive 응답 + 게이트 완화, DO 무관, flag/상수 reversible).
- Acceptance: 지하·정지 FG trip이 push 0 상태에서 한 /position cycle(~10s) 내 backend-ssot 채택. "silentPushHealthy=false reject" telemetry 소멸. surface trip 회귀 0. **replay harness(#2247)로 red fixture(lockless 정지 → 채택) 재현 후 green.**

### Phase 1 — per-trip DO scaffold (cron 병존, shadow)
- `TripDO` + wrangler binding + `migrations[new_sqlite_classes]`. `POST /trips` dual-write(DO stub). cron authoritative, fire 변화 0.
- Acceptance: DO state가 KV와 shadow-일치(비교 telemetry), 발사 delta 0. 롤백: DO 생성 flag off.

### Phase 2 — fire를 DO alarm으로 (cohort cutover)
- register/position에서 `setAlarm(next fire)`. `alarm()`이 단일-trip fire(기존 함수 + #2230/#2243 게이트 재사용). cron은 DO-migrated trip fire skip(per-trip flag). cohort 롤아웃.
- Acceptance: DO-fired trip이 cron baseline과 타이밍·dedup 일치. 롤백=flag를 cron으로.

### Phase 3 — 글로벌 cron 은퇴
- `scheduled.ts:1207` 전수 순회 제거. 저빈도 housekeeping cron(orphan cleanup)만 잔존.
- Acceptance: 분당 KV read/CPU가 활성 trip 수와 **무관하게 flat**. quota burn 해소.

---

## 스케일 분석
- **현재 O(N)**: 60s 고정 × [listTrips 전체 + trip당 readSsot + line/station subrequest]. 유휴에도 비용.
- **타겟 O(1)/event**: 작업이 이벤트에서만. fire=trip당 self-alarm 1회, 분당 스캔 없음. read는 이벤트당 O(1) 해당 DO 국소. push량=역 이벤트 수(bound), pull=FG-only self-limit.

## 트레이드오프 / 리스크
- DO 과금(trip당 request+duration+SQLite) ↔ 유휴 fleet 고정 invocation 소거. **Free plan DO 한도 재확인.**
- Phase 1~2 dual-write divergence → cutover 전 shadow-compare. fire authority 분할 → per-trip flag reversible. **N=1 금지 — cohort + shadow.**
- iOS content-available throttling: **visible push는 throttle 대상 아님**(무영향). pull이 FG SSoT를 silent budget에서 완전 우회.

## 오너 조율
- **#1553/ADR-017**: SSoT 모델 위에 **얹음**(supersede 아님). SSoT 저장소 KV→DO storage 이주만 조율.
- **ADR-026(단일 emitter)**: **불변**. DO alarm은 *스케줄러*이지 제2 emitter 아님 — 본문 명시.
- **ADR-023/#2063**: 정합(순수-silent만 은퇴, contentAvailable piggyback 유지).
- **#2061**: Phase 0 전 consult.

## 가드레일
- 단일 emitter(ADR-026) 불변. 이번 세션 fix(#2230 dedup/backstop·#2243 검증·#2231 relabel) 각 phase fire 경로에 유지(같은 fire 함수 재사용). 각 phase reversible. **N=1 금지 — cohort + shadow-compare.**
