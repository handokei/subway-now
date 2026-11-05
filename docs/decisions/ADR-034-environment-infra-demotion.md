# ADR-034 — 환경(지상/지하) 분류 인프라 강등: decision-driver → observability

- **Status**: **DRAFT** (2026-08-26 작성, 사용자 검토 대기). 구현 착수는 **#2384(position-train-lock BG) 지하 실기기 검증 통과에 gated**.
- **관련**: ADR-028(env surface 고착 → stale-GPS over-accept, 전술 수정), ADR-030(G4 fusion class 통합), #2381/#2384(position-train-lock 환경 독립), `feedback_device_self_contained_fusion`, `lesson_tactical_fix_whack_a_mole_systemic`
- **분석 근거**: 2026-08-26 검증탑승 덤프(텍스트-E05A4F244EEB) + 환경 인프라 소비처 전수 추적

---

## 첫 줄 원칙

**환경(지상/지하)은 iOS+서울 지하철 조건에서 신뢰 가능하게 감지 불가능한 신호다.** 따라서 그것을 *결정 주체(decision-driver)*로 쓰는 모든 분기는 구조적으로 오작동하며, 해법은 "감지를 정확하게 만드는 것"이 아니라 **"결정이 환경 정확도에 의존하지 않게 만드는 것"**이다. (ADR-028 Root C "env 정확도 의존 자체 제거"의 인프라 수준 일반화.)

---

## Context

### 환경 감지는 구조적 두더지잡기 (measured)
- 2026-08-26 덤프: `Environment surface=91% underground=0%` — 명백한 지하 탑승(용마산7→건대2)을 전 구간 지상 오분류.
- 원인이 코드에 이미 문서화됨:
  - barometer subsurface = dP/dt **edge 검출기**(`barometerSubsurface.ts:79-90`), latch 없음 → 지하 정상주행(steady)에서 `subsurface=false` (하강 전이 없음 ≠ 지상).
  - 서울 지하철 **전 구간 NRNSA(5G NSA) 중계**(`cellularTech.ts:19` 주석) → 셀룰러도 지상 투표.
  - `inferEnvironment.ts:87` 우선순위4: `subsurface===false` + SSOT null → `'surface'` (모호 신호에 surface 권위 부여).
- 동일 병리 반복 관측: `useFusedNearestStation.ts:536` 주석 "7/7 trip 로그: subsurface=true 13건인데 최종 environment는 surface 89.9%". **이건 1회성 버그가 아니라 신호 자체의 한계.**

### 그런데 이 신호가 3계층에서 결정을 가른다
1. **FG fusion tier 우선순위** — `pickFusionTier(environment, signals)`. `env==='underground'`일 때만 strict stale-GPS 거부 발동(`pickFusionTier.ts` Tier 7/10). surface 고착 → **loose 게이트가 지하에서 5분 stale GPS를 over-accept → phantom 역 점프**(ADR-028 인과사슬).
2. **후보 진단/필터** — `isCandidateEnvMismatch(environment, cand)`. 덤프의 `candidate-env ×100`은 **진단 카운터**(ADR-028 finding #9: 실제 후보를 버리지 않음). 단 실 필터는 #1950 consensus 게이트가 별도 수행.
3. **Backend 분기** — device가 `environment` vote 업로드(`positionUpload.ts`) → backend `advanceTripPosition.ts:440 mapEvidenceEnvironment` → `consensusGate` → trip 진행/lockAttachable 판정. 오분류가 backend까지 전파.

### 인프라가 치르는 비용 (작동하지도 않으면서)
| 비용 | 실체 |
|---|---|
| 배터리 | barometer + accelerometer 5Hz + cellular tech 상시 샘플링(trip 내내) |
| 네트워크 | env vote backend 업로드 |
| 정확도 | 오분류 → 잘못된 tier, stale-GPS over-accept, backend trip 오판 |
| 복잡도 | inferEnvironment 9분기 + surface/underground consensus + weightedVote + cellularTech (FG 13파일) + backend env 분기(10파일) |
| 관측 노이즈 | 진단 telemetry가 덤프 도배 |

### 패러다임 전환이 이미 시작됨 — #2384가 근거를 제공
`#2384`(position-train-lock BG, 2026-08-26 머지)는 lock trainCode → 열차위치정보 API로 **환경 라벨을 전혀 참조하지 않고** 지하 역을 확정한다. 즉 "환경 독립 감지"가 실제로 구현됨. 이 경로가 실기기에서 검증되면, 환경을 결정 주체로 유지할 근거가 사라진다.

---

## Decision (방향 확정, 구현 gated)

**환경 라벨을 decision-driver에서 observability(또는 약한 힌트)로 강등한다.** 세 계층 각각:

- **L1 (FG tier)**: ADR-028 Root A+C를 채택 — `inferEnvironment` 모호 시 `surface` 대신 `unknown` 반환 + strict 게이트 키를 `env!=='surface'`로. 즉 "모르면 안전측(strict) default". 이후 tier 우선순위가 환경 정확도에 의존하지 않게 됨.
- **L2 (신호 샘플링)**: strict default가 안착하면 barometer/cellular/accel 샘플링을 **환경 판정 목적으로는 중단**(다른 소비처 — 예: accel motion label — 있으면 그 최소만 유지). 배터리 회수.
- **L3 (backend)**: device의 environment vote를 backend `consensusGate`가 **약한 tie-breaker로 강등하거나 무시** — arvlCd 진행/position series 같은 강한 신호가 있으면 env vote는 참조 안 함.

관측용 `environmentDistributionCounter`/DebugModal 라인은 **유지**(진단 가치 있음, 결정력 없음).

---

## Options (검토, false binary 회피)

| # | 옵션 | 성격 | 판정 |
|---|---|---|---|
| A | **환경 강등(본 ADR)** — decision-driver → observability, 결정은 환경 독립 신호로 | 근본, 패러다임 정합 | **채택 후보** — 단 #2384 검증 gated |
| B | **환경 감지 하드닝** — NRNSA 페널티 강화, barometer latch, sticky 개선 | patch-on-patch | 기각 — ADR-028 Root B가 "primary 아님" 명시, 두더지잡기 |
| C | **정확성 게이트 보강 (현재 코드에 없음, 신규)** — 지하 판정에 양성 증거(WiFi SSID / arvlCd 진행 / accel automotive) quorum 요구 후에만 underground 확정 | 신규 게이트 | 부분 채택 — L1의 "양성 surface 증거 요구"(ADR-028 Root A)가 이 방향. 단 underground 쪽도 대칭 적용 검토 |
| D | **현상 유지 + 측정만** — 아무것도 안 바꾸고 오분류 영향 1주 measure | 관망 | 기각 — 이미 measured(89.9% 반복), 관망은 배터리/오작동 지속 |
| E | **전면 삭제(즉시)** — 환경 인프라 rip-out | 과격 | 기각 — lockless가 뭘 잃는지 미검증(N=1), #2384 검증 전 위험 |

---

## Trade-offs
- 지상 dead-zone(터널 인접 지상)에서 strict default → 정상 지상 구간 miss 소폭 증가(ADR-028 §Trade-offs와 동일).
- `#1932` semantic equivalence(tier2 gpsDerivedFastPath가 surface 요구) 회귀 점검 필요.
- L2 샘플링 중단 시, 환경 외 다른 소비처(motion label 등) 의존성 전수 확인 필요 — 잘못 자르면 회귀.
- backend env vote 강등 시 backend consensus 회귀 점검(별도 backend 테스트).

## Sequencing (구현 조건)
1. **#2384 지하 실기기 lock 탑승 검증 먼저.** environment=surface 오판 상태에서도 position-train이 매 역 정확 발사 = 환경 독립이 실제로 됨을 증명. **미통과 시 본 ADR 보류**(환경이 아직 유일 지하 신호일 수 있음).
2. 통과 시: L1(ADR-028 A+C) → red replay fixture(env=surface 고착 + 지하 stale GPS 유령점프 재현) 선행 → green. ADR-028 sequencing 승계.
3. L1 안착 후 L2(샘플링 강등) → L3(backend vote 강등). 각 단계 독립 PR + 회귀 게이트.

## Acceptance (사용자 가치 → acceptance)
- **사용자 가치**: 지하에서 정확한 역 알림(환경 오판과 무관하게). 배터리 소모 감소.
- 지하 구간 5분 stale GPS 채택 0, env 모호 시 strict 발동(ADR-028 승계).
- 환경 라벨 오분류가 발사 정확도에 영향 0 (position-train 또는 strict-default 경로가 커버).
- 실탑승: 지하 phantom 역 점프 0 + position-train 매 역 정확.
- (L2 후) trip 중 barometer/cellular 샘플링 배터리 측정 감소 확인.

## 미해결 / 후속
- lockless(무탭, trainCode 없음) 사용자의 지하 감지 — L1 strict-default가 "안전측"으로 커버하나 **정확한 역**은 못 줌. position-train은 lock 전제. lockless 지하 정확도는 별도 근본(환경 독립 신호 확보) 필요 — 본 ADR 범위 밖, 후속 과제.
