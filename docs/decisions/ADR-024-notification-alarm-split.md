# ADR-024 — 알림(Notification) ≠ 알람(Alarm) 분리 스펙

## 상태

Accepted — 이슈 #2065 (Epic #2061), 2026-07-29. 사용자 체감 회귀 2건(동일 알림 반복 발사 / 일반 모드 알람음)의 4-audit(발사 지점 27곳 전수 / backend cron chain / fixture 인프라 / 지하 위치서비스 리서치) 결과로 확정.

## 배경

**알림은 매 역 진입 정보 배너(무소리, backend 단일 dedup, miss 저비용)이고, 알람은 환승/도착 1역 전 안전망(alarm.wav, 원격 visible 주 채널 + device 부가 + OS 예약 backstop, 취침 전용)이다 — 둘은 서로 다른 신뢰 계약이므로 발사 정책을 공유해선 안 된다.**

기존 코드는 이 둘을 분리하지 않고 동일한 "알림" 개념으로 취급했고, 그 결과 2건의 회귀가 발생했다:

1. **동일 알림 반복 발사** — "5분 dedup"은 backend `arvlCd` 경로에만 실존한다. 실제 사용자 도달을 담당하는 device 발사 지점 13곳 중 다수가 dedup 제약 밖에 있다.
   - OS 사전예약 3종(`alarmScheduler` / `tripBoundScheduler` / `boardingLockScheduler`)은 예약 후 OS가 자체 발사하므로 런타임 dedup이 불가능하고 cancel에만 의존한다.
   - `fireWithGate`는 identifier를 지정하지 않아 알림이 스택된다.
   - `boarding-prompt` / `sleep-transfer`는 in-memory dedup이라 프로세스 재시작 시 상태가 소실된다.
2. **일반 모드에서 알람음** — 취침 gate가 실재하는 발사 지점 13곳 중 1곳(`shouldSuppressBySleepRule` 경유 경로)에만 적용된다. `sendAlarmNotification`은 `sleepMode`를 진동/TTS 세기에만 사용하고, `alarm.wav` 발사 자체는 모드와 무관하게 실행된다.

추가로 backend의 매역 진입 감지(`arvlCd`)는 정확하지만 **silent push만 발사**하므로, `silentPushTask`가 기동하지 않는 상태(앱 kill/throttle)에서는 사용자 도달이 0건이 된다.

## 결정

### 1. 스펙 표 (Epic #2061 본문 재수록)

| | 알림 (Notification) | 알람 (Alarm) |
|---|---|---|
| 발사 시점 | 매 역 진입 | 환승역/도착역 **1개 역 전** |
| 근거 신호 | backend cron 역 진입 감지 (SSoT) | 동일 |
| 모드 | 일반 모드. **취침모드 mute (backend 분기)** | **취침모드 전용** |
| 소리 | 무소리 배너 | alarm.wav |
| 제약 | 동일 알림 5분 1회 (서버 단일 dedup) | "1역 전 = 출발역"이면 발사 금지 (환승·도착 동일) + 등록 시 UI 안내 |
| 채널 | **backend visible push 단일 결정자** (device 발사 관여 X) | **원격 visible(alarm.wav+time-sensitive) 주 채널** + device TTS/진동 부가(배너 생성 금지) + OS 예약 안전망(취침 한정, outage 대비) |

### 2. "단일 결정권자"의 정의

**단일 결정권자 = 정책·dedup의 단일 소유 + 멱등 발사.** 물리적으로 발사 경로가 하나뿐이라는 뜻이 아니다.

- "컨텍스트 사망 시 miss"를 막기 위해 물리적 단일 경로(예: 원격 push 하나에만 전부 의존)는 **기각**한다 — 네트워크/OS throttle로 그 하나가 실패하면 전체가 침묵한다.
- 대신 원격 push와 로컬(device) 알림은 identifier 체계가 근본적으로 다르므로(원격 = APNs collapse-id / 서버 dedup key, 로컬 = `expo-notifications` identifier) **상호 멱등이 불가능**하다.
- 해소 방식: **채널당 발사 주체를 1개로 고정**한다. 알림 채널은 backend visible push가 유일한 발사 주체(device는 관여하지 않음)로, 알람 채널은 backend 원격 visible이 주 채널이고 device는 배너를 새로 만들지 않는 TTS/진동 부가 + OS 예약이 outage 전용 backstop으로 존재한다. 각 채널 내부에서 발사 주체가 하나이므로 정책·dedup 소유가 명확하다.

### 3. 채널 결정 기록

- **boarding-prompt = B7 원격 visible 단일.** 로컬(device) boarding-prompt 알림은 제거한다.
- **trip-ended = B12 원격 단일.** 로컬 trip-ended 알림은 제거한다.
- **소리 정책**: 응답을 요구하는 prompt류(B7 boarding-prompt, B9)는 `sound: default` 유지. 정보류(B12 trip-ended)는 무소리.
  - 근거: prompt 응답은 "사용자 확정 flow"(2026-07-03 결정, `project_2026_07_03_user_manual_action_flow`)의 chain 전제 조건이다 — 사용자가 알아채지 못하면 chain 자체가 시작되지 않으므로 소리로 주의를 끌 필요가 있다. 정보류는 chain을 시작시키지 않으므로 무소리가 맞다.

### 4. self-contained 원칙과의 경계

- **알림은 backend 의존을 의도적으로 허용한다.** 정보성이고 miss 비용이 낮으며, 2026-07-29 사용자가 명시적으로 결정했다. Device self-contained fusion paradigm(메모리: `feedback_device_self_contained_fusion`)은 "정확한 발사 시점 판단"에 적용되는 원칙이며, 이미 backend가 SSoT로 판단을 끝낸 알림의 전달(delivery) 채널까지 device가 중복 보장할 필요는 없다.
- **알람은 OS 예약 안전망 원칙을 유지한다.** 환승/도착 1역 전은 miss 시 사용자가 실제로 하차를 놓치는(overshoot) 고비용 실패 모드이므로, backend outage 상태에서도 발사되어야 한다. OS 사전예약(`alarmScheduler` 등)이 이 backstop 역할을 계속 수행한다.

### 5. 알람 잔여 리스크

앱 kill 상태에서 원격 alarm push가 성공적으로 도달했지만 device가 이미 예약해둔 OS 알람을 cancel할 기회를 얻지 못하면(예: cancel 요청 자체가 kill로 인해 전달 안 됨), **OS 안전망이 버퍼(180s) 뒤 동일 알람을 1회 추가 발사**할 수 있다.

- 이 리스크는 의도적으로 수용한다: outage-miss(알람이 아예 안 울림)를 막기 위한 backstop이 존재하는 한, 극히 드문 경합 창(180s 버퍼 이내 cancel 실패)에서의 중복 1회는 miss보다 훨씬 저비용이다.
- 중복 알람이 매 trip마다 반복 재현되면(N≥3) 별도 이슈로 cancel 신뢰성을 재조사한다 — 본 ADR은 trade-off 수용만 기록한다.

## 결과

### 긍정

- 알림/알람이 서로 다른 dedup·소리·채널 정책을 갖게 되어, "5분 dedup을 알람에도 적용해야 하는가" 같은 category error 질문이 원천적으로 사라진다.
- 채널당 단일 발사 주체로 인해 회귀 발생 시 "어느 채널의 어느 발사 지점인지" 즉시 특정 가능(디버깅 시간 단축).
- 사용자 확정 flow(prompt류)와 정보 알림(trip-ended류)의 소리 정책이 명시적으로 문서화되어 향후 새 알림 종류 추가 시 분류 기준이 생김.

### 부정

- 알림 채널에서 backend 단일 의존이 되므로, backend cron이 완전히 죽으면(silent push와 달리) 매역 알림도 0건이 된다 — 단, 이는 정보성 알림이므로 스펙 표상 수용된 trade-off다.
- 알람 채널의 OS 예약 backstop이 중복 발사 리스크(§5)를 구조적으로 남긴다 — 완전 제거가 아니라 "outage-miss 방지와의 trade로 수용".
- 기존 device 로컬 boarding-prompt / trip-ended 발사 경로 제거는 후속 구현 이슈(#2064, #2067, #2069)에서 코드 변경이 필요하며, 본 ADR은 스펙만 정의한다(코드 변경 없음).

### 후속 이슈 매핑 (Epic #2061)

| 이슈 | 범위 |
|---|---|
| #2063 | Phase 1-backend: 매역 알림 visible 전환 + sleepMode mute |
| #2064 | Phase 1-device: 매역 device 발사 제거 + FG 표시 정책 |
| #2066 | Phase 2-backend: 취침 알람 원격 visible 전환 |
| #2067 | Phase 2-device: 알람 로컬 정리 + OS 예약 통합 |
| #2069 | Phase 3: 이중 채널 정리 + dead code 삭제 |
| #2070 | Phase 4: fusion 지하 신호 재정의 |

## 관련

- **ADR-023** — Backend vs Device sleep mode 경계. 본 ADR 결정에 따라 "backend sleepMode 분기 금지" 원칙이 알림/알람 주 채널에 한해 개정됨(개정 이력 참조).
- **ADR-010** — Sensor fusion 정책. 첫 줄 원칙("false positive/miss는 비대칭이 아니라 동급")이 알림·알람 각각에 독립 적용됨을 본 ADR §3~5에서 명시.
- **ADR-019** — 알림 상태 단일 출처. FG/BG dedup 통합의 "이중화 구조 제거" 교훈이 본 ADR §2 "채널당 발사 주체 1개" 원칙의 직접 선행 사례.
- **ADR-022** — Arrival API SSoT 재설계. `arvlCd` 단일 신호가 본 ADR의 "근거 신호" 열의 근거.
- **Epic #2061** — 본 ADR의 상위 스펙 출처. Sub-issue 트리는 §결과 표 참조.
