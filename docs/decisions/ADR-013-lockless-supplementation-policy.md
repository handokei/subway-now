# ADR-013: Lockless 보완 정책 (B+C 통합)

## 상태

Accepted (2026-06-11)

관련 ADR: ADR-010 (sensor fusion policy)
관련 epic: #1008

> **번호 메모**: 본 ADR은 작성 요청 시점에 "ADR-011"로 지칭됐으나, ADR-011(boarding-prompt context wireup)과 ADR-012(alarm dedup idempotency key)가 이미 점유 중이라 다음 가용 번호 ADR-013으로 정착. 의도(B1 결정 SSOT)는 동일.

## 배경

ADR-010이 B 흐름(boardingPrompt 자동 push)과 C 흐름(전체역 보기 토글)을 정의했으나, 두 흐름은 독립 결정이었고 lockless trip(사용자가 trip을 시작했으나 BoardingLock을 생성하지 않은 상태)의 보완 경로 정합성이 부재했다.

- B 흐름은 9단 AND 게이트 통과 시에만 자동 prompt 발사 → 게이트 미통과 trip은 침묵
- C 흐름은 사용자 명시 opt-in 정보 토글 → OFF 사용자는 lockless 사각지대 그대로
- 두 흐름의 우선순위와 충돌 정책이 명시 안 됨 → 동시 발사 / cleanup 누락 위험

2026-06-11 사용자 B1 결정으로 두 흐름의 통합 정책을 본 ADR이 SSOT로 정착한다.

## 결정

### 1. lockless 정의

`lockless` = **trip 활성(`trip.status === 'active'`) AND BoardingLock 미생성(`boardingLock === null`)** 상태.

trip 시작 직후·열차 미선택·lock cleanup 직후 모두 동일 상태로 취급.

### 2. 보완 경로 우선순위

| 순위 | 경로 | 진입 | 결과 |
|---|---|---|---|
| 1 | **B 흐름 — boardingPrompt push** | 9단 AND 게이트 통과 (ADR-010 §B 표) | [탑승] 응답 → arvlCd 우선순위로 autoLock → 매역 알림 SLA 진입 |
| 2 | **사용자 manual lock** | BoardingTrainList 직접 탭 (B4 결정 — 낙관적 UI) | 즉시 lock 생성 → 매역 알림 SLA 진입 |
| 3 | **C 토글 정보 표시** | `locklessStationPassed=true` AND lockless 유지 | lockless station-passed 푸시 (사용자 명시 의향) |

순위 1 → 2 → 3 순서로 동작. 순위 1이 발사되면 사용자 응답으로 lock 생성 → lockless 종료 → 순위 3 자연 비활성화.

### 3. 토글 OFF 시 cleanup 트리거

C 토글을 OFF로 전환할 때 활성 BoardingLock이 있으면 **즉시 cleanup** (`tripBoundCleanups` 활용).

근거: 토글의 의미가 "전체역 보기 (정보 표시용)"로 재정의됐으므로(ADR-010 §C amended), OFF = "정보 표시 모드 종료" = lock 정리. 토글 ON/OFF가 lock 상태와 일관되게 동작해야 사용자 mental model 단순.

## #912 acceptance 재해석 (B3 확정)

| 시나리오 | acceptance | 근거 |
|---|---|---|
| lock 활성 trip | ✅ 매역 알림 100% | 기존 ADR-008 SLA 그대로 |
| lockless trip — boardingPrompt 게이트 통과 + [탑승] 응답 | ✅ 100% (autoLock 직후 100%) | 순위 1 정상 동작 |
| lockless trip — 게이트 미통과 | acceptance 위반 아님 | 9단 AND 보호망 — 사용자 선택 영역 |
| lockless trip — 사용자 무응답 ([탑승] 미탭) | acceptance 위반 아님 | 사용자 선택 영역 |
| lockless trip — C 토글 OFF | acceptance 위반 아님 | 토글 = 명시 opt-in, OFF 사용자는 sub-시각지대 수용 |

핵심: **"매역 알림 100%"는 lock 활성 trip 또는 사용자 명시 의향 trip에 한정**. 게이트/사용자 응답을 우회한 강제 100%는 false positive 폭발과 직교 — 추구하지 않는다.

## D 흐름 부재 사유

D 흐름 신설(별도 자동 lock 생성 경로)은 불필요. B의 게이트 통과 + autoLock 흐름과 C의 정보 표시 흐름이 직교 결합으로 동일 효과를 낸다. D를 추가하면:

- 게이트 정의가 분산 → SSOT 와해
- B와 D 중복 발사 가능 → dedup 책임 모호
- 사용자 mental model 복잡화 (자동 lock 경로가 둘)

B(자동 진입로) + 사용자 manual(2순위) + C(opt-in 정보) 3순위로 충분.

## References

- Epic #1008 SSOT (`tasks/epic-lockless-overfire-guard.md` §4 B1/B3)
- ADR-010 §결정 (B+C 흐름 — 본 ADR이 amend 트리거)
- ADR-011 (boarding-prompt context wireup — B 흐름 9단 게이트 필드 와이어업)
- ADR-008 (boarding progress estimator — lock 생성 이후 SLA)
