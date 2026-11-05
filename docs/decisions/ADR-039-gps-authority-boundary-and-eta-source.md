# ADR-039 — GPS 표시 전용화 · 신호별 권한 매트릭스 · ETA 출처 단일화

- 상태: Proposed (2026-09-18)
- 결정: **A + D + E** (사용자 확정, 2026-09-18)
- 관련: [[decision_ARCHITECTURE_COMMITTED_server_track_visible_push]], [[feedback_no_gps_for_decision]], [[feedback_device_self_contained_fusion]], ADR-010(두 실패 모드 동급), ADR-038(다중 권위 fork 소멸), #444, #1612, #1016
- 검증 상태 표기: **confirmed**(2026-09-18 라이드 덤프 + R2 원본 + 코드로 확인) / **assumed**(추론, 미검증)

---

## 1. Context — 사용자가 목적지를 지나쳤고, 필요한 데이터는 전부 있었다

2026-09-18 저녁 라이드(건대입구 → 용마산, 7호선). **도착 알림 0건, 사용자가 용마산을 지나쳐 사가정까지 감** (confirmed, 덤프 `ed3e62ef-918-2.txt` 최종 GPS = 사가정 47m).

### 모든 입력이 정확했다 (confirmed)

R2 `seoul-capture/2026-09-18/` 15개 cycle 전수 조회 — 잠긴 열차 7256의 실제 궤적:

```
17:40:29  건대입구      용마산 arvlCd=99 "8분 후"
17:42:29  어린이대공원   용마산 "6분 후"
17:44:29  군자(능동)     용마산 "4분 후"
17:46:29  군자(능동) 출발 용마산 "3분 후"
17:47:29  중곡
17:49:29  용마산        ← 도착
17:51:29  사가정
```

device estimator(`reanchored-hop`)도 거의 일치했다: 17:43:37 어린이대공원 → 17:44:57 군자 → 17:46:16 중곡.

**Seoul 피드에 잠긴 열차의 목적지 ETA가 매 사이클 정확히 있었고, device 추적도 정확했다. 그런데 알림은 한 건도 나가지 않았다.**

### 무엇이 막았나 (confirmed)

GPS fix가 **17:40:13에 얼어붙어 7분 이상 갱신되지 않았다** (Raw Signal `fix=17:40:13` 반복). accuracy 는 74m 로 "정상"처럼 보였다.

그 결과 `fusionDistanceGate.ts:65`:
```ts
if (candidate.distanceKm > maxAbsoluteKm) return false;
```
가 정확한 열차 신호를 거부했다:
```
17:47:21 | reject:candidate-distance | 7256 중곡(7) d=3030m ×12
17:47:29 | reject:candidate-distance | 7256 중곡(7) d=3030m ×14
```
3030m = 얼어붙은 GPS(건대입구) ↔ 중곡 실거리.

**역설**: 열차가 실제로 멀리 갈수록 신호가 더 확실하게 거부된다.

이어서 fusion 이 건대입구에 고정되고, estimator(중곡)와 mismatch 가 나면서 `gate-phase-time-integration` 이 도착 알람을 **39회** 억제했다. BG 채널은 `gate-accuracy` 21회로 별도 차단됐다.

### 왜 GPS 가 알람 발사의 최종 심판인가 (confirmed)

`useStationAlarm.ts:1128`:
> 알람 경로는 표시 경로보다 엄격한 정확도 게이트를 적용한다. **Phase 알람은 ETA 거리 계산이 필요해 GPS 게이트가 통과한 경우에만 평가한다.**

**ETA 를 GPS 거리로 계산하기 때문에** GPS 게이트가 알람의 전제 조건이 됐다. 이미 Seoul 이 더 정확한 ETA 를 주고 있는데도.

### 같은 플래그가 정반대로 쓰인다 (confirmed)

`fusionDistanceGate.ts`:
```ts
if (accuracyMeters == null) return lockActive === true;      // #1612: lock → 면제
if (!lockActive && accuracyMeters > MAX_ACCURACY_M) return false;
// lock 활성 trip은 strict 거리 검사로 진행 (#1016 hole b)  ← lock → 더 엄격
```

`lockActive` 가 #1612 에선 "보호를 위한 면제", #1016 에선 "더 엄격히"로 쓰인다. 두 이슈가 같은 스위치를 반대 방향으로 조작했고 둘 다 남아 있다.

결과: **GPS 가 완전히 죽으면(`accuracy=null`) 살았을 trip 이, 죽은 좌표를 그럴듯한 accuracy(74m)와 함께 보고했기 때문에 죽었다.** 지상에서는 GPS 가 따라오므로 재현되지 않는다 — 그래서 오래 드러나지 않았다 (assumed: 미발견 기간의 길이는 추정).

---

## 2. Decision — A + D + E (사용자 확정 2026-09-18)

### A — GPS 는 표시 전용. 판정·발사에서 권한 없음

GPS 좌표는 **화면에 무엇을 보여줄지**에만 권한을 갖는다. "지금 어느 역인가"(판정)와 "알림을 쏠까"(발사)의 **결정권자가 아니다.**

이 결정은 [[decision_ARCHITECTURE_COMMITTED_server_track_visible_push]] 와 [[feedback_no_gps_for_decision]] 의 명시 원칙을 코드에 실제로 반영하는 것이다 — 새 원칙이 아니라 **미이행 원칙의 집행**이다.

#### A 가 발사 축에 미치는 영향: 없음 (confirmed)

`#1816`(paradigm shift Phase 1):
> lockless trip + 사용자 명시 의향 없음 시 FG device fire 차단. lock=null + boardingPrompt 미응답 + BoardingTrainList 미탭 = 사용자가 열차 선택 의향을 밝히지 않은 상태.

이번 라이드에도 `lockless-no-user-intent=10` 으로 관측됐다.

- **명시 의향 없는 lockless** → 애초에 알림을 쏘지 않는다. GPS 발사 권한 제거로 잃는 것이 없다.
- **명시 의향 있음** → lock 이 생기므로 lockless 가 아니다.

즉 **발사 축에서 A 는 이미 사실상의 현재 상태**이며, 이 ADR 은 그것을 명문화하고 GPS 가 뒤늦게 거부권을 행사하는 경로(`gate-phase-accuracy`, `reject:candidate-distance`)를 제거한다.

#### lockless trip 은 알림도 LA 도 제공하지 않는다 (사용자 확정 2026-09-18)

> "lockless 는 LA 도 안 떠도 되고, 아무것도 없어도 돼 — 알림이 말야."

lockless trip(= 열차 선택 의향 미표명)은 **알림·LA 어느 것도 제공 대상이 아니다.** `#1816` 이 이미 발사를 차단하고 있었고, 이 결정으로 LA/표시 정체 우려도 제거된다.

따라서 A 에 lockless 예외 단서를 두지 않는다. **GPS 는 예외 없이 판정·발사 권한이 없다.**

lockless trip 의 backend advance 보고는 계속 보내되 **"표시용 추정"으로만 취급**한다 — backend 는 그 값으로 알림을 발사하지 않으며, 그 값이 정체돼도 사용자에게 제공할 것이 애초에 없으므로 피해가 없다.

### D — 신호 × 결정 권한 매트릭스

어느 신호가 어느 결정에 권한을 갖는지 표로 고정한다. 코드는 이 표를 따른다.

| 신호 \ 결정 | 표시 | 판정(어느 역) | 발사(알림) |
| --- | --- | --- | --- |
| 열차 피드 (trainCode 매칭 position/arrival) | 보조 | **권한** | **권한** |
| backend SSoT | 보조 | **권한** | **권한** |
| estimator (시간적분) | **권한** | 보조 | 없음 |
| WiFi SSID | 보조 | 보조 | 없음 |
| 기압계 | 없음 | 보조 | 없음 |
| **GPS** | **권한** | **없음** | **없음** |

**핵심 3가지:**
1. **GPS 는 판정·발사 어느 쪽에도 권한이 없다.** sanity 참고는 가능하나 **단독 거부권을 갖지 않는다.**
2. **열차 피드 신호는 GPS 와의 거리로 거부되지 않는다.** trainCode 가 일치하는 실측 위치는 GPS 보다 상위 권위다.
3. **같은 플래그가 두 방향으로 쓰이는 것을 금지한다.** 현재 `lockActive` 는 #1612 에서 "면제", #1016 에서 "더 엄격"으로 쓰인다 — 매트릭스가 SSoT 가 되면 이런 모순이 구조적으로 불가능해진다.

### E — ETA 출처를 열차 피드로 단일화

**lock 활성 trip 의 목적지/환승 ETA 는 Seoul 열차 피드의 해당 trainCode ETA 를 1순위로 쓴다.** GPS 거리 기반 ETA 계산은 fallback 으로 강등한다(삭제하지 않는다).

`gate-phase-accuracy` 는 "ETA 계산에 GPS 가 필요하다"(`useStationAlarm.ts:1128`)는 전제 위에 있다. 전제가 사라지면 **게이트를 완화하는 게 아니라 필요 없게 만든다** — lock 활성 경로 한정.

### 불변 (바꾸지 않는 것)

- `#444` 의 원래 목적(엉뚱한 역 채택 방지)은 유효하다. 검증 기준을 **GPS 거리 → 경로(arc) 정합성**으로 옮긴다.
- ADR-010: 두 실패 모드 동급. miss 를 고치되 false positive 를 늘리지 않아야 한다.
- `#1816` lockless-no-user-intent 차단은 유지한다.

## 3. Consequences

### 얻는 것
- 지하에서 GPS 상태와 무관하게 도착/환승 알림이 동작한다 (lock 활성 trip).
- ETA 정확도 향상 — Seoul 의 열차별 ETA 가 GPS 직선거리 추정보다 정확하다.
- `lockActive` 가 두 방향으로 쓰이는 모순이 제거된다.
- "GPS 결정권한 X" 원칙이 문서가 아니라 코드로 집행된다 — 같은 클래스의 회귀가 새로 생길 여지가 줄어든다.

### 감수하는 것
- Seoul 피드 장애 시 lock 활성 trip 의 ETA 출처가 끊긴다 → GPS fallback 경로를 **삭제하지 않고 강등**으로 유지한다.
- lockless trip 은 발사 개선을 받지 못한다(원래 발사 대상이 아니다). 표시는 현행 유지.
- 매트릭스를 코드에 반영하는 과정에서 기존 게이트 다수를 건드린다 → **단계적 적용 + 각 단계 red 확인 필수.** 한 PR 로 몰지 않는다.
- GPS 가 판정에서 빠지면 기존에 GPS 가 우연히 막아주던 false positive 가 드러날 수 있다 → 매 단계 측정으로 확인한다.

### 측정 (close 조건)
1. 지하 구간 실주행에서 lock 활성 trip 의 도착 알림 발사 **≥ 1건**
2. 같은 trip 에서 `reject:candidate-distance` 로 **trainCode 일치 신호가 거부된 건수 0**
3. `gate-phase-accuracy` / `gate-phase-time-integration` 이 lock 활성 trip 의 destination 을 억제한 건수 **0**
4. 목적지 통과(overshoot) **0건**

**PR 머지는 진행 척도일 뿐이다.** 위 4개는 실주행 D1/덤프 교차로만 판정한다.

---

## 4. 후속 확인 결과 (2026-09-18, 전부 confirmed)

ADR 초안에서 미확정으로 남겼던 3건을 코드로 확정했다.

### 4-1. GPS fix 신선도 임계값 — **이미 존재한다. 배선이 빠졌다.**

`shared/constants/gpsQualityGate.ts`:
```ts
export const GPS_QUALITY_GATE_MAX_AGE_MS = 15_000;   // 15초
```
`gpsQualityGate.ts` doc(#2070):
> fusion **결정 tier 입력** 품질 게이트. accuracy < 100m AND fix age < 15s 모두 충족해야 통과.
> **미달 좌표는 결정 tier(useFusedNearestStation cascade) 입력에서 제외한다.**

그런데 `useFusedNearestStation.ts:938-943` 의 `positionTrainResult` 는 `gps.userLocation` 을 **age 검사 없이** 거리 계산에 쓴다.

**즉 "임계값 미정"이 아니라 "정의된 게이트가 정작 거리 계산 경로에 안 걸린 것"이다.** 17:40:13 fix 가 7분 넘게 결정에 쓰인 이유. 임계값을 새로 정할 필요 없이 **기존 게이트를 그 경로에 배선**하면 된다.

### 4-2. lockless 에서도 같은 실패 — **그렇다. 오히려 더 나쁘다.**

`fusionDistanceGate.ts:58-65`:
```ts
if (accuracyMeters == null) return lockActive === true;            // lockless → 거부
if (!lockActive && accuracyMeters > MAX_ACCURACY_M) return false;  // lockless → 거부
if (candidate.distanceKm > maxAbsoluteKm) return false;            // 조건 없이 전부 적용
```
거리 검사는 lock 유무와 무관하게 적용된다. lockless 는 accuracy 부재/저조로 **추가 거부**까지 받는다. 얼어붙은 fix 실패 모드는 lockless 에 그대로, 더 강하게 적용된다.

### 4-3. `movement-*` 게이트군 — **같은 클래스이며, GPS 실패를 자기강화한다.**

`movementGate.ts` 는 "모든 알람 발사 경로의 SSOT"인 정적 misfire 가드다. `#1401` 이 열차 진행 신호로 일부 우회를 열었으나:
> `trainProgressing=true` 면 정적 reason 3종(motion-stationary / static-speed / static-position)을 우회한다.
> **유지되는 reason: no-location / stale-timestamp / low-accuracy / motion-warmup**

**열차 진행이 확인돼도 `low-accuracy` 는 우회되지 않는다.**

#### 운영 기여도 실측 (2026-09-18 라이드, 19건 전수)

| 시각 | reason | 대상 | 판정 |
| --- | --- | --- | --- |
| 17:26:13, 17:26:18 | static-speed | 뚝섬 | **정당** — trip 시작 직후, 승차 전 |
| 17:32:05, 17:33:17, 17:33:24 | static-speed | 건대입구 | **정당** — 환승 도보 중 |
| 17:42:17, 17:45:59, 17:47:22, 17:53:00 | **static-position** | 건대입구 | **허위** — 열차 주행 중 |
| 17:53:09~17:53:42 | static-speed | 사가정 | 정당 — 하차 후 |
| 17:29~17:30 | low-accuracy | 성수 | 보류 — lock 혼란 구간 |

**19건 전부 `station-passed` 만 억제했다. destination/transfer 는 한 건도 막지 않았다.**

`static-position` 4건은 **얼어붙은 GPS fix 가 만든 허위**다 — 좌표가 안 변한 이유는 사용자가 정지해서가 아니라 fix 가 갱신되지 않아서다. **GPS 가 죽을수록 게이트가 "정지"를 더 확신하는 자기강화 오류**다.

**결론: 게이트는 유지한다(정당 억제가 실재한다). 단 stale GPS 입력으로는 발동하지 않아야 한다** — 4-1 의 신선도 배선이 이 게이트군도 함께 고친다. `low-accuracy` 는 D 매트릭스에 따라 lock 활성 경로의 발사 차단 권한에서 제외한다.

---

## 5. 구현 단계 (각 단계 독립 PR + red 확인)

1. **신선도 배선** — 기존 `isGpsQualityGateAcceptable`(15s)을 `positionTrainResult` 등 결정 tier 거리 계산 입력에 적용. 가장 좁고 위험 낮음
2. **trainCode 일치 신호의 거리 거부 제거** — `passesFusionDistanceGate` 에서 열차 피드 실측을 GPS 거리로 거부하지 않도록. 검증 기준을 arc 정합성으로 교체
3. **ETA 출처 교체(E)** — lock 활성 trip 의 destination/transfer ETA 를 Seoul trainCode ETA 1순위로. GPS 계산은 fallback 강등
4. **발사 게이트에서 GPS 권한 제거(A/D)** — `gate-phase-accuracy`, `movement-low-accuracy` 를 lock 활성 경로에서 제외
5. **`lockActive` 이중 의미 해소** — #1612(면제) vs #1016(엄격) 모순 제거

**순서를 지킨다.** 4를 1~3 없이 먼저 하면 얼어붙은 GPS 대신 아무 검증 없는 신호가 발사에 도달한다.
