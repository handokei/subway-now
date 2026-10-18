# BG 알람 다중 채널 아키텍처 — 조사 결과 + 이슈 분해 + 진행 순서

작성: 2026-05-27. `tasks/bg-alarm-analysis.md` 후속. WhileInUse + 매 역 알람 + 저전력 모드 OK를 동시에 만족하는 다중 채널 설계 확정.

---

## 1. 문제 정의 (재확인)

### 사용자 시나리오
- 권한: WhileInUse ("사용하는 동안")
- 상태: 앱 BG + 저전력 모드 ON (배터리 20% 자동 진입)
- 요구: 10개 역 이동 시 10개 알람 모두 수신 (intermediate imminent + transfer/destination early/imminent)

### 현재 차단점
저전력 모드 ON이면 iOS가 **Background App Refresh를 자동 OFF + 수동 변경 불가**.
→ 현재 silent push 단독 구조는 OS가 강제로 차단함 → `lastReceived=(never)`.

### 가치 (정확성·신뢰성 우선)
1. 알람 누락 0 (false negative 없음)
2. 잘못된 알람 최소 (false positive 차단)
3. 타이밍 정확 (10초 단위 오차)
→ 단일 채널로는 불가능. **다중 채널 + 공유 dedup** 필수.

---

## 2. 조사 결과 — 사용 가능/불가능 경로 (검증된 사실)

### 폐기된 경로
| 경로 | 폐기 사유 |
|---|---|
| **사전 예약 (#478에서 제거)** | "안 움직여도 알람 발사" — 위치 게이트 무력. 의도적 제거 결정 유지. |
| **CLLocationPushServiceExtension** | Apple 공식 문서 명시: **"Always" 권한 필수**. WhileInUse 정책과 양립 불가. |
| **자체 WiFi BSSID 매칭 (카카오 방식)** | iOS는 BG WiFi 스캔 API 없음. FG에서도 연결된 1개 AP만. 카카오도 iOS는 시간표 fallback. |
| **WiFi 핑거프린팅 알고리즘 자체 구현** | KRRI 논문(2016) 방식. 안드로이드는 가능, iOS는 BG 스캔 API 부재로 불가. **단 iOS Location Services가 내부적으로 동등한 추정을 자동 수행** → Region Monitoring이 이 이점을 자동 활용. |

### 채택된 경로 — 다중 채널
| 채널 | 동작 | 실패 조건 |
|---|---|---|
| **채널 1: Silent push + 위치 게이트 (현재)** | 정확한 1차 채널 | BG App Refresh OFF / 저전력 |
| **채널 2: Alert push fallback (ACK 타임아웃)** | silent 미도달 시 백엔드가 alert로 폴백 | 거의 없음 (단 위치 게이트 무력) |
| ~~**채널 3: Region Monitoring**~~ | ~~iOS 내장 WiFi 위치 추정 활용~~ | **폐기 — #582** (WhileInUse에서 SDK가 Always 권한 강제) |
| **(Always 사용자 자동) 채널 4: BG GPS task** | 기존 backgroundLocationTask 유지 | "Always" 권한 사용자에게만 |

> **채널 3 폐기 (2026-05-28)** — #563 PoC 결과 `Location.startGeofencingAsync()`가 WhileInUse 권한에서 SDK 레벨로 실패. iOS CoreLocation이 region monitoring API에 Background 권한 entitlement를 요구해 우회 불가. 정책상 WhileInUse가 1차 시나리오이므로 채널 3은 작동 불가. 자세한 내용: `region-monitoring-poc-result.md` (#582).
>
> **메인 BG 채널 대안**: Local Notification 사전 예약 + Live Activity push update (BoardingLock 아키텍처, 이슈 #584/#585/#586).

### 채널 매트릭스 (시나리오별 보장)
| 시나리오 | 채널 1 | 채널 2 | 채널 4 | BoardingLock 사전예약 | 결과 |
|---|---|---|---|---|---|
| WhileInUse + BG App Refresh ON + 지상 | ✅ | (불필요) | — | ✅ | ✅ |
| WhileInUse + BG App Refresh OFF + 지상 | ❌ | ✅ | — | ✅ | ✅ |
| WhileInUse + BG App Refresh OFF + 지하 | ❌ | ✅ | — | ✅ | ✅ |
| WhileInUse + 저전력 + 약한 신호 | ❌ | ⚠️ | — | ✅ (사전 예약) | ✅ |
| Always + 모든 OS 차단 | ❌ | ❌ | ✅ | ✅ | ✅ |

**채널 3 폐기 이후의 메인 BG 경로**: Local Notification 사전 예약 (BoardingLock 아키텍처). 네트워크/푸시 채널과 무관하게 OS 스케줄러가 발사 → WhileInUse + 저전력 + 지하 약신호 시나리오까지 커버.

---

## 3. 아키텍처

```
                       ┌──────────────────────────────────────┐
                       │  공유 dedup: FIRED_ALARMS[alarmKey]    │
                       │  alarmKey = waypointId + phase        │
                       │  먼저 fire한 채널이 이김                │
                       └──────────────────────────────────────┘
                                       ▲
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
   채널 1 (정확)                  채널 2 (도달 보장)              채널 3 (push 무관)
   Silent push +                 Alert push fallback             Region Monitoring
   위치 게이트                    (ACK 타임아웃 시만)              (iOS 내장 WiFi 추정)
```

### 채널 1 — Silent push + 위치 게이트 (현재 유지)
```
[backend cron]
  └─ phase 평가 → 발사 조건 만족
     └─ silent push 발사 (pushId 포함, apns-push-type: background, priority: 5)

[device silentPushTask]
  ├─ 위치 게이트 통과? → 알람 발사 + FIRED_ALARMS[alarmKey] 기록
  └─ 백엔드에 ACK 전송 (pushId, fired/skip, reason)
```

### 채널 2 — ACK 기반 Alert push fallback (신규)
```
[backend cron]
  └─ silent push 발사 후 30초 타이머 시작 (pushId 추적)
     ├─ 30초 내 device ACK 수신 → 종료 (채널 1이 처리함)
     └─ 30초 ACK 없음 → alert push 발사 (같은 pushId, title/body 포함)

[device]
  ├─ iOS가 OS 레벨에서 자동 표시
  └─ 앱이 FG면 listener에서 FIRED_ALARMS[alarmKey] 체크 → 중복 무시
```

### ~~채널 3 — Region Monitoring (폐기, #582)~~

> #563 실기기 PoC 결과 `Location.startGeofencingAsync()`가 WhileInUse 권한에서 SDK 레벨로 거부됨 (Background location permission required). iOS CoreLocation의 region monitoring API는 Always 권한 entitlement 강제 — WhileInUse 1차 시민 정책과 양립 불가. 자세한 내용: `region-monitoring-poc-result.md`.

### BoardingLock 사전 예약 (채널 3 대체)

```
[trip 등록 시점]
  └─ Per-Hop Adaptive Scheduling: 다음 waypoint별 도착 예상 시각을 Local Notification 사전 예약
     └─ 환승 후: 직전 leg 알람 cancel, 다음 leg 알람 신규 예약 (BoardingLock 갱신)

[iOS 스케줄러]
  └─ 네트워크/푸시 채널과 무관하게 예약된 시각에 알람 발사

[device 진입 시]
  └─ 위치 게이트(채널 1) 또는 alert(채널 2)가 예약 알람보다 먼저 발사하면 dedup
```

자세한 설계: `project_alarm_sla_architecture` 메모, 이슈 #584/#585/#586.

---

## 4. 이슈 분해 + 진행 순서

### Phase 0 — PoC (모든 후속 결정의 기반, 가장 먼저)
| # | 제목 | 공수 | 산출물 |
|---|---|---|---|
| **P0** | `chore: Region Monitoring PoC — WhileInUse + BG 진입 wake 검증` | 1~2일 | 실기기 측정: WhileInUse에서 region 진입 wake 안정성, 지하 구간 감지율, 환승 재등록 매끄러움 |

**P0 결과 시나리오**:
- ✅ 안정 → 채널 3 본구현 진행, 채널 2 비중 축소 가능
- ⚠️ 부분 → 채널 2 + 3 병렬 구축
- ❌ 불안정 → 채널 2(alert fallback)가 메인

### Phase 1 — 측정 인프라 (P0와 병렬, 1일)
| # | 제목 | 공수 |
|---|---|---|
| **P1** | `chore: 채널별 도달률 측정 — alarmLog source 확장 (region-entry, alert-fallback)` | 1일 |

### Phase 2 — 채널 2 (Alert push + ACK fallback)
**#562 폐기** 후 다음으로 분해:

| # | 제목 | 공수 | 의존 |
|---|---|---|---|
| **P2a** | `feat: backend pushId 발급 + 디바이스 ACK endpoint` | 2일 | P1 |
| **P2b** | `feat: device silentPushTask가 발사/스킵 결과 ACK 전송` | 1일 | P2a |
| **P2c** | `feat: backend 30s ACK 타임아웃 → alert push fallback 발사` | 2일 | P2a, P2b |
| **P2d** | `feat: backend alert title/body 생성 (buildAlarmContent 동등)` | 1일 | — |
| **P2e** | `feat: device alert push notification dedup (pushId + FIRED_ALARMS)` | 1일 | P2c, P2d |

**머지 순서**: P1 → P2a → P2b → P2d → P2c → P2e

### ~~Phase 3 — 채널 3 (Region Monitoring 본구현)~~ — **폐기 (#582)**

P0 결과: WhileInUse에서 `startGeofencingAsync` SDK 거부. 본구현 불가. 메인 BG 채널은 BoardingLock 사전 예약(#584/#585/#586)으로 전환.

### Phase 4 — 권한 UX (Phase 2 머지 후, 선택)
| # | 제목 | 공수 |
|---|---|---|
| **P4** | `feat: 권한별 알람 신뢰도 안내 + Always 권한 선택적 업그레이드 안내 UX` | 1~2일 |

WhileInUse 강제 X, "Always로 더 정확하게" 옵션 제공. 메모리 `feedback_whileinuse_must_work` 준수.

---

## 5. 전체 타임라인

```
Day 1     : P0 PoC + P1 측정 인프라 (병렬)        ← P0 결과: 채널 3 폐기 (#582)
Day 2     : P1 머지
Day 3~4   : P2a (backend pushId + ACK)
Day 5     : P2b (device ACK 전송)
Day 6     : P2d (alert 문구)
Day 7~8   : P2c (타이머 + fallback)
Day 9     : P2e (dedup)
Day 10    : Phase 2 통합 검증 (실기기 저전력 모드 시나리오)
Day 11~17 : BoardingLock 사전 예약 (#584/#585/#586) — Phase 3 채널 3 대체
Day 18~19 : P4 (권한 UX)
```

총 약 **3주**. Phase 3가 region monitoring → BoardingLock 사전 예약으로 교체됨.

---

## 6. 폐기/유지 결정

### 폐기
- **#562 (단순 alert push hybrid)** — 위 Phase 2 분해가 더 정확. close 처리 후 P2a~P2e 신규 생성.

### 유지
- 현재 silent push 채널 (채널 1) — 정확도 1차 채널로 유지
- 기존 위치 게이트 (`silentPushLocationGate.ts`) — 채널 1에서 유효
- 기존 BG GPS task (`backgroundLocationTask`) — Always 사용자용 채널 4

---

## 7. 검증되지 않은 가정 (정직)

PoC 없이 단정할 수 없는 것:
1. ~~**Region Monitoring + WhileInUse**~~ — **검증 완료 (#563 / #582): 동작 불가**. SDK가 Always 권한 강제. 채널 3 폐기.
2. **ACK round-trip 시간** — 디바이스가 silent push 받고 ACK 보내는 시간 분포. 30초 타임아웃이 적절한지 측정 필요. P2 통합 검증 단계에서 결정.
3. **Cloudflare Worker cron 1분 단위** — 30초 타이머 구현 시 Durable Object 도입 필요할 수 있음. P2c 작업 시 결정.
4. ~~**Apple WiFi DB의 한국 지하철역 커버리지**~~ — 채널 3 폐기로 측정 무의미.

---

## 8. 관련 자료

### 분석/메모리
- `tasks/bg-alarm-analysis.md` — 원본 진단 (가설 a~i)
- `tasks/service-gap-plan.md` — 서비스 갭 정책 트랙
- 메모리 `feedback_whileinuse_must_work` — WhileInUse 1차 시민
- 메모리 `feedback_realtime_priority` — 나쁜 좌표 거부, grace period 금지
- 메모리 `project_bg_alarm_no_always_roadmap` — 사전 예약 부활 폐기, silent push 우선

### 관련 이슈
- #478 silent push 단독화 (위치 게이트 도입, 사전 예약 제거)
- #493 alert push fallback 트랙 (본 계획의 Phase 2 출발점)
- #494 Region monitoring (본 계획의 Phase 3 출발점)
- #506 silent push 미도달 진단 (본 계획 시발점)
- #542 BG silent push 실기기 검증
- #543 FG 복귀 stale 표시 해결
- #562 단순 alert push hybrid (본 계획으로 대체, 폐기 예정)

### 외부 참고
- [CLLocationPushServiceExtension | Apple Developer](https://developer.apple.com/documentation/corelocation/cllocationpushserviceextension) — Always 필수 명시
- [Citymapper SDK iOS Setup](https://docs.external.citymapper.com/getting-started/iOS-setup.html) — Always + BG Location 표준
- [카카오지하철 - 나무위키](https://namu.wiki/w/%EC%B9%B4%EC%B9%B4%EC%98%A4%EC%A7%80%ED%95%98%EC%B2%A0) — iOS 시간표 fallback
- [Geofencing iOS limitations](https://radar.com/blog/limitations-of-ios-geofencing) — 20 region 제한, 20초 머무름 요구
- KRRI 논문 (안태기 외, 2016) — WiFi 핑거프린팅 k-NN Minkowski, 0.5m 그리드 + 8 AP → 평균 1m 정확도. iOS Location Services 내부 추정의 기술 근거.
