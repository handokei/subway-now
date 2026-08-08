# ADR-028 — Environment surface 고착 → 지하 stale-GPS over-accept (phantom 교차)

- **Status**: Proposed — **구현 보류(deferred)**. ADR-026 ①(route-progress) 실기기 검증 후, phantom이 잔존할 때만 구현 착수.
- **관련**: ADR-026(fire 단일 권위, phantom과 교차), 원래 RCA finding #9(오진 정정)
- **분석**: 2026-08-08 적대적 분석(read-only) 결과

---

## Context

### finding #9는 오진이었다
`reject:candidate-env` 로그는 **필터가 아니라 진단 카운터** — 후보를 하나도 버리지 않는다 (`useFusedNearestStation.ts:1589`, `pickFusionTier.ts:377` 주석 명시, `isCandidateEnvMismatch`의 유일 호출자 = L1598 카운터). "over-reject" 프레이밍 폐기.

### 그 카운터가 드러낸 진짜 결함
피해는 정반대 방향 — **environment가 surface로 고착(덤프 92.1%) → 지하 strict 게이트 미발동 → loose 게이트가 지하에서 stale GPS를 over-accept → drift/phantom**. ①phantom과 교차하는 **별개 메커니즘**.

**인과 사슬 (file:line):**
1. barometer subsurface = dP/dt **edge 검출기**(`barometerSubsurface.ts:79-90`, `+0.3hPa/30s`), latch 없음. 지하 정상주행(steady)에서 dP≈0 → `subsurface=false`(덤프 `readings=41`이 이 상태 — "지상"이 아니라 "지금 하강 전이 없음").
2. `inferEnvironment` 우선순위 4(`inferEnvironment.ts:85-87`): `subsurface===false` + 두 SSOT null → **`'surface'` 반환** ← 핵심 병리: 모호 신호에 surface 권위 부여.
3. surface를 뒤집을 undergroundSSOT quorum 막힘(`undergroundSSotConsensus.ts:147-224`): NRNSA `-0.5` 페널티(`:191-193` — 서울 지하철 전 구간이 NRNSA인데 감산), sticky는 180s 타이머(`barometer.ts:159`)뿐.
4. env=surface 고착 → Tier 7 `fusedPasses`(loose), Tier 10 `gps-fallback`이 strict(15s) 대신 **5분 stale GPS**를 지하에서 채택(`pickFusionTier.ts:296-307`) → 유령 역 점프.

### 세션 공통 병리 (3번째 사례)
"단일/고착 신호에 권위 부여" — rotation(신원 churn), route-progress(단일 속도 스파이크), 그리고 여기(barometer edge=false를 surface 증거로).

---

## Decision (구현 보류 — 근본만 확정)

- **Root A** — `inferEnvironment.ts:85-87`: `subsurface===false` + SSOT null → `'surface'` 대신 **`'unknown'`** 반환(양성 surface 증거 요구).
- **Root C (최고 레버리지)** — `pickFusionTier.ts:258,299`: strict 게이트 키를 `env==='underground'` → **`env!=='surface'`**(underground OR unknown). 모호성을 안전측(strict)으로 default → env 정확도 의존 자체 제거.
- **A+C 함께여야 durable**: A 단독은 `unknown`도 loose라 샘, C 단독은 env 고착 잔존.
- **Root B (follow-up)** — NRNSA 페널티/180s sticky(`undergroundSSotConsensus.ts:191`, `barometer.ts:159`)는 patch-on-patch. primary 아님. sticky를 타이머 대신 surfaceSSOT 양성 관측까지 latch하는 방향은 별도 검토.

---

## Trade-offs
- 지상 dead-zone(터널 인접 지상)에서 strict가 엄격 → 정상 지상 구간 miss 소폭 증가. (A+C가 env를 "모르면 지하 취급"하므로)
- `#1932` semantic equivalence(tier2 gpsDerivedFastPath가 surface 요구) 회귀 점검 필요.

## Sequencing (구현 조건)
1. **ADR-026 ① 실기기 검증 먼저.** route-progress 수정만으로 현장 phantom이 죽으면 본 ADR은 잠재 hardening으로 우선순위↓.
2. phantom이 잔존/재관측되면: red replay fixture(env=surface 고착 + 지하 5분 stale GPS → 유령 점프 재현) 선행 → A+C → green. 다른 클러스터와 동일 규율.

## Acceptance (구현 시)
- 지하 구간에서 5분 stale GPS 채택 0, env 모호 시 strict 게이트 발동.
- 실탑승: 지하 phantom 역 점프 0.
