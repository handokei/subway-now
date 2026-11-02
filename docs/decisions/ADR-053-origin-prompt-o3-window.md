# ADR-053 — 출발역 탑승 질문: trackingOptIn 근접 실측 필수를 O3 창(등록 앵커 + 걷는 시간)으로 부분 반전

- 상태: Proposed (2026-11-03)
- 관련: #3036, #2997, #2651, #3057/ADR-042 결정 1, ADR-010, ADR-014, ADR-029, `docs/research/494-geofence-bg-rejection.md`, `tasks/plan-2026-11-02-origin-prompt-eta-anchor.md`(v3)

---

## 배경

2026-11-02 아침(token_hash `b00dd879`, 06:27:45 등록, 용마산 -> 건대입구 -> 뚝섬): 사용자는 목적지만 설정(안내 시작 안 함, `trackingOptIn=true`)했고 열차 7035/7039/7043이 차례로 용마산에 도착했지만 **탑승 질문이 0건**이었다. R2 Seoul 캡처 16 cycle 전부에 출발역 arrival 조회가 없다 = `fireBoardingPromptForAnchor` 이전 게이트에서 return(plan §1.3, 확인). 같은 fixture에 `promptOptIn:true`를 주면 06:28:46 7035 / 06:34:46 7039 / 06:40:46 7043이 발사된다(`replay_20261102_origin_prompt_morning.test.ts` 대조군).

침묵 게이트는 #2997(S3 v2)의 "trackingOptIn-only trip은 출발역 **근접 실측**이 있어야만 발사(fail-closed)"이다. 이 게이트는 #2651 "집에서 222m 발사"를 구조적으로 막으려고 만들었지만, 목적지만 설정하고 앱을 닫은 채(BG GPS 없음 — `useBackgroundLocation.ts` 자동 trigger 차단) 역에 도착하는 흔한 흐름에서는 근접 실측이 원리적으로 생길 수 없어 질문이 영구히 침묵한다.

## 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
|---|---|---|
| #2651 "집에서 222m 발사" 구조적 재발 차단 / #2997 S3 v2 trackingOptIn fail-closed | trackingOptIn-only 발사 허용 조건 | **부분 반전(사용자 결정 O3)**: "근접 실측 필수"를 "근접 실측 **OR** O3 창"으로 재배정한다. 집에서 목적지를 설정해도 도보시간(등록 시점 출발역 거리/1.2m/s) 뒤 창이 열리면 최대 2회 묻는다. "집에서 즉시 발사"는 걷는 시간 지연이 막고, 창 안에서는 근접 실측 없이 허용한다. 수용한 FP: 창 안 첫 열차를 탔지만 응답하지 않으면 BG·지하에서는 취소 신호가 없어 다음 열차 도착 확정 때 2번째 질문이 간다(K=2의 비용) |
| #3036 (근접 파생 series가 스냅샷에 종속되지 않음) | 근접 파생 입력 | **유지**. series는 근접 인정(기존) + 창 **떠남 취소**(신규) 양쪽 입력 |
| #3057 / ADR-042 결정 1 (도착 확정 시에만, 새 열차마다 1회) | 발사 순간 | **불변** — 창은 "발사해도 되는가(permission)"만 연다. `decideBoardingPromptFire`는 무변경이라 발사 트리거는 여전히 도착 확정 |
| #2653 anchor freshness (`ORIGIN_PROXIMITY_RENEWAL_MS`) | `originProximityAt` 의미 | **불변**. 창 시작은 별도 개념(등록 시각 기반)이라 혼용하지 않는다 |
| #2844 (15분 신선도 은퇴) | 창 상한 | 창 상한 15분은 은퇴한 신선도 게이트의 부활이 **아니라** 신규 파라미터다(계획 §17.3 `2 x 배차 + 3분`의 보수적 기본값, U7 미결) |
| #494/#563 geofence (Region Monitoring) 기각 | BG 근접 확보 | **기각 유지** — `authorizedAlways` 강제라 WhileInUse 1차 정책과 충돌(`docs/research/494-geofence-bg-rejection.md`). 이 ADR은 geofence를 재제안하지 않으며 BG에서 근접을 새로 얻는 안은 코드에 없다 |
| 안내 시작(promptOptIn) 트립 동작 | 명시 의향 경로 | **불변(U4: 적용 안 함)**. 창은 `trackingOptIn`-only에만 적용, 대조군 replay로 불변 고정 |
| ADR-010 첫 줄(FP=miss 동급) | 판정 원칙 | 근접 필수(miss 편향)도 창 없는 fail-open(FP 편향)도 아닌 중간안(O3)을 택한 근거로 인용 |
| ADR-029 경계 계약 | device/backend 상수 복제 | `WALKING_SPEED_M_PER_S` backend 사본 + device `eta.ts` 일치 테스트(`walkingSpeed.deviceParity.test.ts`)로 강제 |
| ADR-023 (취침은 backend 발사 결정 입력 아님) | 취침 게이트 | 무관 — 프롬프트는 취침 값과 독립 |

사용자 결정 원문(2026-11-02 KST):

- 설계 수정 지시: "이거는 설계로 수정하자"
- O3 선택(O1~O4 표에 대한 답): "03으로 진행해"
- (참고, 후속 PR 대상) 조회 스케줄링: "역에서 진행하면 어떻게 할건데 내 생각에는 34분 37분이면, 34분 이후에 35분~까지는 하지 않는거 아니면 그전 다음 열차가 몇 분 후에 오는거 이미 알고 있으니까 그 1분 전부터 다시 받아오는거"

사용자가 고른 표의 O4(geofence) 행은 기각 이력 표기 전 버전이었다. 선택이 O3이므로 영향 없다.

## 결정

trackingOptIn-only 트립의 출발역 질문 허용 창을 등록 시 backend가 계산해 `trip.originPromptWindow`에 저장한다.

- **창 시작** = 등록 시각(server clock) + 걷는 시간 - 60s. 걷는 시간 = `max(0, originDistanceM - originAccuracyM) / 1.2 m/s`(15분 상한). **fix가 `gps-live`이고 나이 <= 5분일 때만** 반영하고, 필드 부재(구 클라)/오래됨/`gps-last-known`/fix 없음(지하)은 지연 0(창 즉시 개시 — miss 방향 차단). 거리는 지상 GPS의 **타이밍 전용** 입력이며 identity 결정이 아니다. 같은 세션 재등록은 "더 가깝다는 live 증거"일 때만 창을 앞으로 당긴다(`min`).
- **창 종료** = 창 안 발사 2회(`boardingPromptState.fireCount >= 2`, 추가 KV write 0) 또는 시작 + 15분(보수적 기본값) 또는 **창 시작 후 신선 원거리 위치**(떠남, `closedAt` 영속 — 한 번 닫히면 series가 낡아도 재개하지 않음).
- 창이 열린 trackingOptIn-only 트립은 근접 실측 없이 `fireBoardingPromptForAnchor`로 진행한다. 발사 순간은 #3057 그대로.
- 관측: D1 `leg-boarding-prompt` origin outcome에 `window-not-started` / `window-closed:train-cap|expired|left-origin`, `fired` 행에 `viaWindow`.

## 대안 (기각)

| 옵션 | 기각 이유 |
|---|---|
| O1 근접 1회 앵커 + ETA 창 | 11/02에는 앵커가 생길 수 없다(FG 동안 근접 fix 부재) -> 같은 miss 지속 |
| O2 등록 앵커 즉시 창(거리 지연 없음) | 집에서 설정 직후 최대 2회 조기 질문(#2651 계열). O3가 걷는 시간 지연으로 이를 줄인다 |
| O4 geofence | 기각 이력(위 표) |
| O5 현상 유지 + 계측만 | 11/02형 miss 지속 |
| O6 목적지 설정 시 BG GPS 자동 시작 | "자동 trigger 차단" 패러다임·V8 배터리 결정 위반 |
| O7 trackingOptIn fail-open(창 없음) | 7043(이미 탑승 후) 오발사, #2997 S3 정면 반전 |
| 정확성 게이트 보강(BG 근접 신호 신규 확보) | 현재 코드에 경로 없음(신규 작업 수주) — 별도 검토 대상으로 남김 |

## 결과

- 11/02 아침 replay(실제 APNs 요청): 등록 거리 dEff별 질문 (0~145m: 7035,7039 / 145~576m: 7039,7043 / >576m: 7043). 현행 코드는 전 구간 0건.
- 구 backend에 등록된 트립(`originPromptWindow` 없음)과 안내 시작 트립은 동작 불변.
- 알려진 한계: (1) 창 안에 도착 확정된 첫 열차가 폴링 창 게이트(`alarmAt - now > 5분`, scheduled.ts)에 가려질 수 있다(U8 미결 — trackingOptIn 폴링 게이트를 창 시작과 정렬할지). (2) 스냅샷이 근접이고 series가 신선하면 기존 근접 경로(#2653)가 발사를 허용하므로 신선 원거리 위치가 그 경로의 발사를 막지는 않는다(창 경로의 영속 닫힘에만 영향). (3) 취소 신호 C4(sync 현재역 != 출발역)는 미구현 — C1(상한)·C2(발사 2회)·C3(신선 원거리)·기존 C5~C7만.

## 리스크

- 창 상한 15분은 노선 배차와 무관한 고정값(U7 미결). 배차가 긴 노선/시간대에서는 K=2 열차가 도착하기 전에 창이 닫혀 miss할 수 있다.
- 집에서 설정한 뒤 live fix가 멀리서 등록돼도 사용자가 1.2 m/s보다 느리게 걸으면 첫 열차를 놓친다(K=2가 다음 열차를 덮는다).
- 수용한 FP: 위 표 첫 행 참조.
