# SPIKE #0 — 가속도계 train-fingerprint 신뢰성 검증

- 작성: 2026-08-10
- 상위: ADR-032 / `tasks/plan-2026-08-10-device-boarding-emitter.md` §8 #0
- 성격: **throwaway 실험** (dev 미머지 feature 아님). 설계 단일 급소 de-risk 후 폐기/흡수.

---

## 왜 이 spike (급소)
ADR-032의 두 transport 잔여(연결 창 / 지연 drift) 해결이 전부 **"motion-gated 발사"**(시계 blind 금지, 가속도계 감속-정차로 발사)에 수렴한다. 즉 **가속도계가 지하서 역별 정차/출발을 신뢰성 있게 잡느냐**가 설계 전체의 단일 실패점. 메모리 `lesson_motion_activity_intermittent_signal`(CMMotionActivity 5~10분 flip)가 정통으로 걸림 → 7개 이슈 짓기 전에 실기기로 찌른다.

**기존 인프라 한계(spike가 넘어야 할 것)**: `accelerometerFingerprint.ts`는 60s window @5Hz + RMS 3분류(`stationary/walking/automotive`). ~15s 정차/출발 이벤트엔 너무 거칠고, cruise vs 감속을 RMS만으로 구분 불가(방향축 적분 필요).

---

## 가설 (go/no-go 대상)
- **H1 검출성** — raw userAcceleration(중력제거)에서 역별 **지속 감속(제동=도착)** 과 **지속 가속(출발)** 이 cruise 진동과 구분되게 잡힌다.
- **H2 지연** — 정차 이벤트를 실제 정지 후 **≤8s** 내 검출.
- **H3 거치 위치 robust** — 주머니/손/가방 모두서 검출(고정축 X → 수평면 주성분/magnitude).
- **H4 CMMotionActivity 불충분** — automotive/stationary 전환이 >30s 지연 or flip → raw accel 필요 확증(거친 3분류로는 불가).

## 측정 신호 (FG, 화면 ON 허용 — 신호 검출성 먼저)
타임스탬프 동기화해 로깅:
- **expo-sensors DeviceMotion @~20Hz**: userAcceleration(x,y,z) + rotationRate + gravity. (spike는 native 안 건드리고 JS 스트림으로 충분)
- 기존 `getLatestAccelerometerSnapshot()`(rmsMagnitude, patternClass) 매 cycle.
- CMMotionActivity(`modules/motion-activity`) activity + confidence.
- Barometer(hPa) — subsurface + 승강장 압력 시그니처 교차검증.
- GPS(잡힐 때) — 지상 구간 ground-truth 앵커.

## Ground truth (역별 실제 도착/출발)
- 라이더가 **실제 문열림(도착) / 문닫힘·출발 순간에 "MARK" 버튼 탭** → 타임스탬프 적재. 이벤트당 1탭, 저부하.
- 폴백: 지상/고가 구간은 GPS + 시간표로 재구성.

## 검출 후보 (오프라인, 로깅 raw에 적용)
- **C1 주성분 적분** — 수평면 PCA로 진행축 추출 → |지속 진행축 가속| > θ, > T초 = 출발 / 지속 감속 = 도착.
- **C2 RMS floor 브라케팅** — RMS가 dwell floor로 떨어짐(정차) 을 앞뒤 RMS burst로 감쌈 = 정차 사이클. (단순·거치 robust)
- **C3 CMMotionActivity 전환** — automotive→stationary(baseline, 이길 대상).
- C1/C2/C3를 ground truth와 대조.

## 지표 + go/no-go 임계
| 지표 | GO 임계 |
|---|---|
| 정차(도착) recall | ≥ 90% (10역 중 miss ≤1) |
| 정차 precision | ≥ 85% (false stop 적음) |
| 검출 지연 median | ≤ 8s |
| 출발 검출 recall(프롬프트 앵커) | ≥ 90% |
| CMMotionActivity 지연 | 측정(>30s 예상 → H4 확증) |

- **GO**: C1 or C2가 임계 충족 → 그 알고리즘을 #E/#J 기반으로 확정, 본구현 진행.
- **PIVOT**: 무거운 튜닝/거치위치 한정으로만 충족 → barometer+accel consensus 추가, 지연 완화, 거치 가이드 등 조정 후 재spike.
- **KILL**: 어떤 후보도 recall 90% 미달 → motion-gate 불신뢰 → ADR-032가 **backend plan ETA + arvlCd에 더 의존**(drift 일부 수용)하도록 재설계, 또는 device-fire 방향 재검토.

## 실탑승 최소화 — 캡처 1회 → fixture → CI replay (재설계 2026-08-10)

**원칙**: raw accel 신호 품질(물리)과 iOS BG 웨이크(OS)는 실기기서만 관측된다 → **실탑승 0은 불가능**. 하지만 **한 번 캡처하면 fixture가 되어 이후 전부 CI replay**(`lesson_fixture_replay_verification_infrastructure` 패러다임). 그래서 "N≥5 반복 탑승"이 아니라 **"대표 캡처 1~2회 → fixture 심고 → 나머지는 CI"**.

### CI/시나리오가 대체 가능 ✅ (탑승 불필요)
- **검출 알고리즘 정확도** — 캡처한 fixture를 C1/C2/C3에 replay → recall/precision/latency. 반복·회귀·파라미터 스윕 전부 CI.
- **로직·배선** — 탑승이벤트→프롬프트→forward(#C~#F) 결정 로직은 mock/시나리오로 검증.
- **파라미터 튜닝** — θ/T/window 그리드 스윕을 fixture 위에서 자동 탐색(analyzer `--sweep`).

### CI가 대체 **불가** ❌ (실기기 캡처 불가결, 최초 1회)
1. 실제 지하철 accel이 **검출 가능한 패턴을 담고 있나**(물리) — 합성 selftest 통과 ≠ 실신호 보장.
2. **iOS BG 웨이크(#0b)** — 시뮬레이터가 BG 스케줄링/신호상실/모션웨이크 재현 못 함.

### 캡처 계획 (최소)
| 캡처 | 조건 | 목적 | 방식 |
|---|---|---|---|
| **1 (필수)** | 지하 노선 + 환승 1회(예: 7→2), 거치 주머니 | 핵심 신호 존재 + leg 경계 | 실탑승 로거+MARK |
| 2 (권장) | 급행 포함 노선, 거치 손/가방 | 급행 skip + 거치 robust 대조 | 실탑승 로거+MARK |
| CI (탑승 X) | 위 fixture로 조건 파생(노이즈 주입/리샘플/거치각 회전) + 파라미터 스윕 | H1·H2·H3 커버리지 확장 | replay |

> 즉 **실탑승은 1~2회로 축소**. N≥5 커버리지는 fixture augmentation + CI로 확보. 원래 `lesson_n1_root_cause_bias`의 N≥5는 "실탑승 5회"가 아니라 "검증 조건 5개" — CI replay로 충족 가능.

## 빌드 범위
- **[캡처 도구] DebugModal SPIKE 로거** — DeviceMotion@20Hz + 기존 snapshot + MARK 버튼 → JSONL export. (BG-B에서 구현, PR #2272)
- **[replay 하네스] 분석 스크립트** `tools/spike/analyzeAccelFingerprint.mjs` — fixture → C1/C2/C3 지표 + go/no-go. `--selftest` + **`--sweep`(파라미터 그리드)** 추가. (BG-C 기반, PR #2271)
- **[CI 회귀] fixture replay 테스트** — 캡처 fixture를 리포에 커밋(정제·익명화) → 분석기가 임계(recall≥90% 등)를 assert하는 CI job. 이후 알고리즘 변경 회귀 방어. ← **캡처 후 추가**.
- 프로덕션 배선 X (로거/분석은 spike 성격, dev 미머지). CI replay 테스트만 dev 머지 대상.

## 산출물
- fixture(캡처 JSONL) + 조건별 recall/precision/latency 표 + go/no-go 판정 + (GO 시) 스윕으로 확정한 파라미터(θ, T, window) + CI replay job.

## 페어 spike (#0b, 별개 실패모드 — 유일하게 CI 불가)
**#0는 "신호가 존재하나". #0b는 "iOS가 도착 순간 BG로 앱을 깨우나"(숙제1)** — BG location task cadence 로깅 → 정차 순간 tick 발생률. **CI로 절대 대체 불가**(OS 런타임) → 실기기 필수. #0 GO 후 진행(캡처 1과 함께 묶어 라이드 1회로 병합 가능하면 병합).

## 효과 추정
로거✅ + 분석기✅(스윕 추가 ~0.3d) + **실탑승 1~2회**(원래 N≥5 → 축소) + CI replay job ~0.3d. 실탑승 부담이 핵심 감소분.
