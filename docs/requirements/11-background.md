# 11. 백그라운드 운영

## 책임
앱이 닫혔거나 잠금화면 상태일 때도 trip 진행·알람·잠금화면 갱신이 동일하게 동작하도록 보장한다. **"항상" 위치 권한 없이도** 핵심 기능을 유지한다.

## 경계
- 각 도메인의 FG/BG 동등 동작 요구는 해당 도메인 문서에 명시. 이 도메인은 **인프라**.

---

## 기본 동작

- 사용자는 "사용 중에만 허용" 권한만으로 BG에서 알람·알림·잠금화면 갱신을 받을 수 있다.
- 사용자는 BG 상태에서도 매 역마다 잠금화면이 갱신됨을 보장받는다.
- 사용자는 BG에서 알람을 다음 두 경로 중 하나 이상으로 받을 수 있다:
  - **사전 예약 local notification** (FG 진입 시 시간표·ETA 기반으로 미리 예약. 현재는 정거장당 90초 균등 산수 — 정확도 한계 있음)
  - **Backend silent push** (실시간 도착 정보 기반. 가장 정확하나 네트워크 끊김·iOS throttle 시 도달 보장 X)
- 사용자는 위 두 경로의 **하이브리드**로, 어느 한쪽이 실패해도 다른 쪽으로 알람을 받을 수 있다.
- 사용자는 정지 상태(5분 이상 미이동)가 감지되면 BG 폴링이 자동 슬립되어 배터리를 절약받을 수 있다. **정지 신호는 GPS가 아니라 OS 모션 API(iOS CMMotionActivity, 가속도/모션 코프로세서)** 기반 — 지하에서도 동작.

## 예외 / 경계 조건

- 사용자는 OS가 BG 작업을 종료한 경우에도 다음 위치 변경 trigger에서 작업이 자동 재개됨을 보장받는다.
- 사용자는 silent push가 실패하더라도 사전 예약 local notification으로 최소한의 알람을 받을 수 있다.
- 사용자는 trip이 활성화돼 있지 않으면 BG 작업이 자동 중단됨을 보장받는다. (배터리 절약)
- 사용자는 앱 강제 종료 후에도 사전 예약된 알람이 발사됨을 보장받는다.
- 사용자는 권한 등급("사용 중에만 허용" / "항상 허용")과 무관하게 **동일한 품질의 알람**을 받을 수 있어야 한다. (권한 차이는 내부 경로 차이일 뿐, 사용자 경험에 노출되지 않는다)

---

## 횡단 의존

- **현재 역 인식**: BG에서 위치 신호 수집. → [02-current-station.md](./02-current-station.md)
- **알람/알림**: silent push + 사전 예약 인프라 제공. → [06-alarm.md](./06-alarm.md)
- **에너지**: 폴링 주기·슬립 정책. → [12-cross-cutting.md](./12-cross-cutting.md)

## 코드 진입점

- BG 위치 정책 (30s/20m): `src/features/nearest-station/utils/locationTracking.ts:4-6`
- BG 작업: `src/features/nearest-station/tasks/backgroundLocationTask.ts`
- WhileInUse만으로 BG 등록: `src/features/nearest-station/hooks/useBackgroundLocation.ts:51`
- silent push 실패 시 local notification fallback: `backgroundLocationTask.ts:170-191`
- 모션 신호 (정지 판정 입력만): `src/shared/utils/motionActivity.ts:75` `getCurrentMotionStationary()`
- Position upload payload (mapMatchedLine, nearestStationDistanceM 포함): `src/features/alarm/api/positionUpload.ts:108-170`
- silent push: backend Cloudflare Worker + APNs
- 사전 예약: 이슈 #918

## 알려진 한계

- ✅ WhileInUse 권한만으로 BG location task 등록 가능 — 구현됨.
- ✅ silent push 실패 시 local notification fallback — 구현됨 (`backgroundLocationTask.ts:185-191`).
- ⚠️ "항상" 권한 없이 **100%** 알람 보장은 Epic #912 진행 중.
- ⚠️ #622 backend boardingLock sync 부재 — silent push false positive 회귀.
- ⚠️ 정지 감지 시 BG 슬립 정책 미구현. CMMotionActivity 신호는 수집·payload 첨부되지만 폴링 중단 로직 없음.
- ⚠️ **사전 예약이 정거장당 90초 균등 산수** (`alarmScheduler.ts:14` `ONE_STOP_SECONDS = 90`). 실측 시간표·ETA 변동 미반영.
- ⚠️ Silent push 도달 메트릭 측정 부재 → 신뢰성 평가 불가.

## 개선 후보 (백로그)

### 1. 알람 발사 3계층 fallback 구조 도입
현재 2계층(Silent push + 90초 균등 사전 예약) → **3계층**으로 확장:

- **L1: Silent push** (실시간, 최정확) — backend가 실시간 도착 정보로 발사. 네트워크 끊김 시 0.
- **L2: API 기반 사전 예약** ← 신규. FG 진입 시 시간표 API로 정밀 ETA를 받아 hop별로 예약. 실측 운행 시간(`stationRoute.ts:27-32`) + 환승역별 실측 대기 시간(`getTransferSeconds()`) 활용.
- **L3: 역 초 균등 사전 예약** — 현재 90초 균등(`alarmScheduler.ts:14` `ONE_STOP_SECONDS = 90`). L2가 만들어지지 못한 경우(API 호출 실패) 최후 fallback.

**효과**: 지하 진입 후 silent push가 못 들어와도 L2가 정밀한 시각에 발사. L2조차 만들지 못한 trip(네트워크 시작부터 X)에서는 L3가 최소한 보장.

**중복 방지**: 세 계층 모두 같은 idempotency key `{tripId, stationId, alarmType, phase}` 사용 → 기존 `firedAlarms` Set이 자연스럽게 dedup.

**주의**:
- iOS 사전 예약 슬롯 64개 limit. 환승 많은 trip은 슬롯 사용량 모니터링 필요.
- L2·L3 동시 운영 시 dedup이 정말 보장되는지 통합 테스트 필수.

### 2. Silent push 도달 메트릭
발사·도달·dedup·드롭 카운트를 backend KPI로 수집. 신뢰성 측정 후 L2/L3 의존도 조정 근거.

### 3. 지하 진입 직전 사전 예약 재갱신
지하 진입 감지(`barometerSubsurface.ts`) 직전, 마지막 정확한 ETA로 후속 알람을 reschedule. L2 정확도를 지하 진입 직전 상태로 freeze.
