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

## 라이드 매트릭스 (N≥5, 이상적 8)
| 조건 | 목적 |
|---|---|
| 지하 노선(7호선) | 지하 무GPS 핵심 |
| 지상/고가(2호선 지상 구간) | GPS ground-truth 대조 |
| 환승 라이드(7→2) | leg 경계 검출 |
| 급행+완행(9호선) | 급행 skip 패턴(W2 참고데이터) |
| 거치: 주머니/손/가방 각 ≥2 | H3 |

> N≥5는 `lesson_n1_root_cause_bias` 최소선. 조건별 최소 1, 지하는 ≥2.

## 빌드 범위 (최소·throwaway)
- DebugModal에 **"SPIKE 로깅 시작/종료" + "MARK 도착/출발"** 버튼. DeviceMotion@20Hz + 기존 snapshot을 in-memory ring에 적재 → 종료 시 `/signals/dump`(RAW_SIGNALS) 또는 파일 export. 기존 `rawSignalBuffer`/observability 덤프 경로 재사용.
- **오프라인 분석 스크립트**(JS 또는 Python notebook): export 로그 → C1/C2/C3 실행 → 지표 산출.
- 프로덕션 배선 X, coverage 테스트 X (spike 브랜치, dev 미머지).

## 산출물
- 조건별 recall/precision/latency 표 + go/no-go 판정 + (GO 시) 확정 검출 알고리즘 파라미터(θ, T, window).

## 페어 spike (#0b, 별개 실패모드)
**#0는 "신호가 존재하나"(FG). "iOS가 도착 순간 BG로 앱을 깨워 그 신호를 잡나"(숙제1)는 별도 #0b**: BG location task cadence 로깅 → 정차 순간 tick 발생률 측정. #0 GO여도 #0b 실패면 발사 못 함 → 둘 다 통과해야 척추 확정. #0 먼저(더 쌈), GO면 #0b.

## 효과 추정
로거 ~0.5d + N회 라이드(실통근 passive) + 분석 ~0.5d.
