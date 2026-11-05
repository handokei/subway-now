# 요구사항 (Requirements)

이 디렉토리는 subway-now 앱이 **사용자 관점에서 무엇을 보장해야 하는가**를 도메인별로 기술한다.

- `docs/decisions/` (ADR) — **왜** 그렇게 정했는가
- `docs/requirements/` (여기) — **무엇을** 동작해야 하는가
- GitHub Issues — **지금** 누가 무엇을 하고 있는가

각 도메인 문서는 "사용자는 ~할 수 있다" 형식의 capability statement로 작성한다. 문서에 적힌 항목 중 **현재 미구현**은 `⚠️ 미구현` 표시로 갭을 가시화한다.

---

## 사용자 여정 (시간순 인덱스)

| # | 단계 | 도메인 문서 |
|---|---|---|
| 1 | 앱 첫 설치 / 업데이트 → 위치 권한 요청 (1회) | [01-onboarding.md](./01-onboarding.md) |
| 2 | 위치 신호 융합으로 현재 역 자동 인식 | [02-current-station.md](./02-current-station.md) |
| 3 | 목적지 설정 → 공공 API 시간표로 경로 안내 | [03-destination-route.md](./03-destination-route.md) |
| 4 | 탑승 열차 선택 (수동) 또는 "이 열차 탔어요?" 확인 푸시 | [04-boarding.md](./04-boarding.md) |
| 5 | 실시간 진행 — 매 역 갱신 | [05-realtime-progress.md](./05-realtime-progress.md) |
| 6 | 알람 — 환승 1역 전, 하차 1역 전 (액션 트리거) | [06-alarm.md](./06-alarm.md) |
| 7 | 알림 — 매 역 진행, 도착, 탑승 확인 (정보 전달) | [07-notice.md](./07-notice.md) |
| 8 | 자동 하차 감지 | [08-disembark.md](./08-disembark.md) |
| 9 | 잠금화면 / Live Activity — BG에서도 매 역 갱신 | [09-lockscreen.md](./09-lockscreen.md) |
| 10 | 취침 모드 — 이어폰 전용 알람 | [10-sleep-mode.md](./10-sleep-mode.md) |
| 11 | 백그라운드 운영 — "항상" 권한 없이 동일 서비스 | [11-background.md](./11-background.md) |
| 12 | 횡단 관심사 — a11y / 개인정보 / 오프라인 / 에너지 / 다국어 / 피드백·운영 | [12-cross-cutting.md](./12-cross-cutting.md) |
| 13 | 운행 안내 — 사고·공사·지연·막차 | [13-service-status.md](./13-service-status.md) |

---

## 도메인 용어 (Ubiquitous Language)

도메인 용어는 **무엇(What)**을 정의한다. 구현 수단(GPS, AsyncStorage 등 How)은 들어가지 않는다.

### 핵심 도메인 용어

| 용어 | 의미 |
|---|---|
| **현재 역 (Current Station)** | 사용자가 지금 있는 것으로 결정된 역. 신호원·결정 방식과 무관하게 정의 |
| **목적지 (Destination)** | 사용자가 명시적으로 설정한 도착할 역 |
| **경로 (Route)** | 출발 ↔ 목적지 사이의 시간표 기반 환승 시퀀스 |
| **Trip** | 사용자가 실제 탑승해서 진행 중인 1회 여정 (탑승 ~ 하차) |
| **Leg** | trip 내 한 노선 구간 (환승 사이) |
| **Hop** | 한 leg 내 한 정거장 이동 단위 |
| **알람 (Alarm)** | **액션 트리거** — 환승/하차 직전 사용자 행동 필요. 소리·진동, 취침 시 이어폰 강제 |
| **알림 (Notice)** | **정보 전달** — 진행 상황 인지용. 무음 가능 |
| **탑승 확정 (Boarding Lock)** | 사용자가 특정 열차에 탑승했음이 확정된 상태 |
| **단조 노선 (Monotonic Line)** | 한 방향이 일관되게 진행되는 노선 (3·4·7·8·9호선, 공항·분당·신분당). 방향 자동 결정 가능 |
| **비단조 노선 (Non-monotonic Line)** | 순환·분기·다중 종착 구조를 가진 노선 (1·2·5·6호선). 별도 결정 로직 필요 |

### 신호 계층 용어 (현재 역 결정 도메인 내부에서만 사용)

| 용어 | 의미 |
|---|---|
| **위치 신호 (Position Signal)** | 현재 역을 결정하기 위한 입력 단서. GPS 좌표, 기압, WiFi 식별자, 가속도 등 |
| **신호 융합 (Signal Fusion)** | 여러 위치 신호를 결합해 단일 현재 역으로 결정하는 과정 |
| **수동 지정 (Manual Pin)** | 사용자가 직접 현재 역을 지정한 상태. 자동 결정보다 우선 |

> 신호 계층 용어는 "현재 역 인식" 도메인 문서 안에서만 등장한다. 다른 도메인(알람·잠금화면·UI 등)은 **현재 역** 추상화만 사용한다.
