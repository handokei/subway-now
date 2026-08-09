# ADR-030 — G4 fusion/환경/추론 신호품질 class 단일 활성화 (umbrella 통합)

- **Status**: Accepted (활성화). 계약 epic #2234와 **병렬 트랙**. 단 특정 fix는 §가드레일에 gated.
- **관련**: ADR-015(다중신호 합의/Env SSOT, ancestor), ADR-028(env 고착→stale-GPS, **Decision 코어**), ADR-026(fire 단일권위), ADR-027(boarding line authority)
- **오너 통합**: umbrella=**#1927**. 참조 오너=#1432, #2093, ADR-028.
- **공동 요건(co-requisite)**: **#2239(G5 replay harness/CI 게이트)** — "실탑승만이 안전망" → "실탑승은 발견, replay가 재발 방지"로 전환하는 backbone. G4 회귀 위험을 실탑승 전 CI로 내리는 전제. §Replay harness backbone 참조.
- **분석**: 2026-08-09 dump G4 증상 + 4개 오너 통합 RCA(read-only)

---

## Context — 왜 통합인가

사용자가 G4(계약과 무관한 fusion/추론 신호품질 class)를 un-defer해 병렬 트랙으로 승격 결정. 그런데 이 class는 오너 4개(#1927/#1432/#2093/ADR-028)에 흩어져 다수 deferred였고, **tactical fix 반복 실패(whack-a-mole) 이력**(ADR-026: dedup 177 / false-fire 14 / arc 34 commits)이 있어 통합 설계가 선행돼야 한다.

**핵심 결론**: 이 class의 진짜 root는 **ADR-028이 이미 정확히 좁혀 놓았다**. #1927 G3의 원래 전제("candidate env-mismatch reject")는 ADR-028 finding #9로 폐기됨 — `isCandidateEnvMismatch`(`pickFusionTier.ts:385`)는 필터가 아니라 진단 카운터라 후보를 하나도 안 버린다. umbrella는 "candidate reject 강화"가 아니라 **ADR-028 A+C(모호 신호를 안전측=strict로 default)**를 코어로 재정렬한다.

## 통합 map (오너 처분)
- **umbrella 승격**: **#1927**(Epic G, `pickFusionTier`/`inferEnvironment` 정조준). ADR-028을 Decision 본문으로 인라인.
- **superseded 명시**: #1432 E1(stations.json environment 필드 — 이미 존재), #1927 G3의 "reject" 서브(ADR-028 finding #9로 무효).
- **keep 독립(class 밖)**: #2093 A/B/G(발열·busy-loop·로그 rate-limit), #1432 E5/E6(backend fire/lock-release).
- **흡수(RCA 입력)**: #2093 E(baro vs cellular 환경분열)·F(지하 GPS)·C(arc)의 *환경/추론* 부분.

## 증상→오너 매핑 (2026-08-09 dump)
| 증상 | root | 상태 |
|---|---|---|
| 1. env surface 94.2% 고착 | ADR-028 Root A (`inferEnvironment.ts:87` 모호신호에 surface 권위) | 커버 |
| 2. arc 적분 freeze(11480/3403 동결) | #2093 C + ADR-026 (freeze≠overshoot, 재확인) | 커버 |
| 3. `subsurface=false` 지하 오판 | ADR-028 Root A/B (`barometerSubsurface.ts:79-90` edge, latch 부재) | 커버 |
| 4. no-route인데 auto-lock 후보(7131) | `inferAutoLockCandidate.ts:132-141` departure-strong-stability(#1526) | **⚠ GAP** |
| 5. 지하 stale GPS over-accept → 유령 점프 | ADR-028 Root C (`pickFusionTier.ts:299`) | 커버(gated) |

## Decision — 단계 설계 (tracer-bullet, blind fix 금지)

- **Phase 0 — RCA/측정 + replay harness backbone (런타임 fusion 로직 0줄 변경)**: 아래 §Replay harness backbone을 **재사용 harness로** 구축(일회성 fixture 금지). 세부:
  - **P0-1 계측 확대**: DebugModal/Sentry에 env label + 채택 tier + counter 노출 **+ barometer 원시 hPa 시계열 + GPS 수신 타임스탬프**를 rawSignalBuffer/dump에 추가(현재 미기록 → replay 커버리지 확대의 전제).
  - **P0-2 dump→fixture 파서 + replay 드라이버**: dump "Raw Signal" → `FusionCycleInput[]` 파서, 시퀀스를 실제 `inferEnvironment`→`pickFusionTier`→nearest에 흘려 출력 시퀀스 대조. 증상 1·3·5를 "env 고착+지하 stale GPS→유령 점프" 하나로 **red 재현**, 2·4 별도.
  - **P0-2b positive fixture**: 지상 dead-zone 정상 trip fixture(loose 게이트가 옳았던)를 함께 보관 → Phase 1 A+C의 miss 트레이드오프를 CI에서 측정.
  - **P0-3 N≥3 evidence** 수집. **P0-4 ADR-026 ① route-progress 실기기 검증 gate 판정.**
  - Acceptance = harness가 phantom fixture를 red 재현 + positive fixture green + N≥3 근거표 + tier 채택 분포 live.
- **Phase 1 — 환경 안전측 default (ADR-028 A+C, G2+G4 병합, 1 PR)**: `inferEnvironment.ts:87` 모호→`'unknown'`(surface 권위 제거) + `pickFusionTier.ts:258/:299` strict 키 `env==='underground'`→`env!=='surface'`. **A+C 함께여야 durable**. Acceptance = P0 fixture green(지하 stale GPS 채택 0) + #1932 semantic-equiv 회귀 통과.
- **Phase 2 — env vote를 strict-gate 입력으로 (G3 재정의)**: "reject" 폐기, vote는 신뢰도 보강만. 후보 집합은 안 버림.
- **Phase 3 — Root B follow-up(낮은 우선순위)**: NRNSA 페널티/180s sticky를 surfaceSSOT 양성까지 latch. Phase 1이 env 의존을 이미 줄여 opportunistic.
- **Phase 4 — Gap(증상 4)**: auto-lock no-route 예외를 P0 baseline 기반 판정(ADR-027 cross-ref). 별 sub-issue.

시퀀싱: Phase 0 → 1(gate 통과 시 직렬) → 2 → 3/4(병렬). **Phase 1이 사용자 가치 tracer-bullet(유령 점프 종료).**

## 가드레일 (필수)
- **(a) N=1 root-cause 금지** — 단일 샘플(속도 1개/arvlCd 1샘플/subsurface edge 1관측)에 결정 권위 금지. Phase 0 baseline 없으면 Phase 1 착수 불가.
- **(b) 지하/lockless GPS 좌표 결정 금지** — Phase 1-C가 `env!=='surface'`에서 stale GPS를 strict(15s)로 강등해 구조적 강제.
- **(c) ADR-028 A+C fix는 precondition 유지** — un-defer해도 **ADR-026 ①(route-progress) 실기기 검증 후 phantom 잔존 시에만** 착수. Phase 0 P0-4가 이 gate를 판정. route-progress 수정만으로 phantom이 죽으면 Phase 1은 hardening으로 우선순위↓.
- **(d) 계약 epic #2234와 파일 교집합 0 (grep 확인)** — G4=`pickFusionTier`/`inferEnvironment`/`barometer*`/`useFusedNearestStation`; 계약=`apns.ts`/`silentPushTask.ts`/`pushContract.ts`. 유일 접점 DebugModal(필드 추가만). **병렬 안전.**

## Replay harness backbone (G5 #2239 co-requisite) — 회귀를 실탑승 전 CI로

**원리**: fusion 코어는 "기록된 신호 시퀀스에 대한 결정론적 함수". dump의 "Raw Signal(300)"이 입력, "Fusion log/Tier/alarm"이 기대출력. 이미 존재하는 자산 위에 얹는다:
- backend: `evidence_2026*_replay.test.ts`, `replay_20260807_storm.test.ts` (패턴 검증됨).
- device: `rawSignalBuffer.ts`(입력 버퍼) + `useFusedNearestStation.*.test.ts` 수십 개(signal-driven 시나리오).

**신규 조각(작음)**: dump→fixture 파서 + 시퀀스 replay 드라이버 + 표준 fixture 스키마. backend/device 공유.

**동작 (4단)**: ① dump 캡처(있음) → ② 파서로 `FusionCycleInput[]` fixture → ③ 실제 파이프라인에 사이클별 흘림(fake timer) → ④ **불변식 단언**(정확한 정답 불요): 지하 구간 `env==='surface'` 금지 / 한 사이클 route-라인 밖 >500m 점프 금지 / 지하 5분 stale GPS 채택 금지.

**해결 방식**:
- **red→green**: 현 코드로 fixture red(버그 재현) → Phase 1 A+C 적용 → green. **버그 낸 실신호로 CI에서 검증, 실탑승 불요.**
- **회귀 ratchet**: 과거 사건 전부(07-03/08-04/08-07/08-09)가 fixture 라이브러리 → 이후 어떤 fusion 변경이 하나라도 재파손하면 CI red로 PR 차단. **알려진 실패모드 재유입 불가.**
- **트레이드오프 계측**: phantom fixture(green 돼야) + 지상 dead-zone positive fixture(green 유지돼야)를 동시 재생 → A+C의 miss 증가가 서프라이즈가 아니라 **CI 측정값**.
- **실탑승 축소**: "검증"이 아니라 **새 입력분포 발견**으로만. dump 1건 = fixture 승격(ratchet).

**replay로 안 되는 잔여(정직)**: (1) barometer 검출기 자체 — 원시 hPa 미기록이라 P0-1 계측 추가 전까지 불가, (2) iOS BG 실행·LA/푸시 실제 전달 등 device-only 통합층(mock). 이 둘만 실탑승 잔류, 범위 작음.

## 트레이드오프 (수용)
- Phase 1-C가 지상 dead-zone에서 miss 소폭 증가 가능(strict 강등) → Phase 0에서 계측, 수용/롤백 판단.
- 두 systemic 트랙 병렬 → 실탑승 검증 attribution 흐려짐 → **런타임 변경은 탑승당 1개 스태거**(계약 Phase 0는 타입이라 무런타임, 자유).
