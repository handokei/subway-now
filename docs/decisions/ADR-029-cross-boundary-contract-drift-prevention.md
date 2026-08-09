# ADR-029 — Cross-boundary push 계약 드리프트를 컴파일/CI 실패로 전환 (SSoT 계약 + exhaustive + 런타임 검증 + liveness 불변식 + de-wire lint)

- **Status**: Proposed. **Phase 0 착수 조건 = PR #2232(#2230) / #2233(#2231) 머지 후** (동일 계약 파일 충돌 방지).
- **관련**: ADR-024(알림≠알람 분리), ADR-026(fire 단일 권위), `lesson_tactical_fix_whack_a_mole_systemic`, `lesson_channel_dual_role_severed_on_redesign`, `lesson_fixture_replay_verification_infrastructure`
- **분석**: 2026-08-09 실기기 dump RCA + 사용자 메타 지적("왜 계속 저런 문제가 발생하나, 코드 수준에서 방지 못 하나")

---

## Context

### 반복되는 것은 개별 버그가 아니라 하나의 class다

2026-08-09 dump에서 터진 4증상 — `unk=5`(집계 스큐), `legacy-station-kind-ignored`(은퇴 채널 오해), `silentPushReach 0/6`(죽은 지표), destination 60s×9h 반복(liveness 미보장) — 은 전부 **동일한 구조적 원인**에서 나온다:

> **backend(Cloudflare Worker, TS)와 device(RN, TS)가 untyped JSON push payload로 통신하는데, 그 계약이 물리적으로 여러 벌 복제돼 있고, 소비는 if-체인이며, 검증은 "과거 사건 replay(example)"뿐이고, 채널 은퇴 시 지표/소비자가 lockstep으로 죽지 않는다.**

### 근거 (file:line — 계약이 이미 3벌 복제·드리프트 중)

- backend `apns.ts:53` → `kind: 'transfer' | 'destination' | 'intermediate'`
- backend `apns.ts:226` → **다른** union `type: 'station-passed' | 'transfer' | 'destination' | 'imminent'`
- backend `apns.ts:931` → `targetKind: 'transfer' | 'destination'`
- device `silentPushTask.ts:99` → 또 따로 `kind?: 'transfer' | 'destination' | 'intermediate'`
- device `silentPushTask.ts:293` → `targetKind: 'transfer' | 'destination'`

세 정의가 **아무 타입 링크 없이** 각자 존재. backend가 `imminent`/`station-passed`를 추가해도 device는 모름 → 수신 시 `silentPushTask.ts:495`에서 조용히 `undefined`로 떨어져 `unk` 집계.

### 왜 지금까지 못 막았나 (4개 갭)

1. **계약 복제** — 위 3벌. SSoT 없음.
2. **비-exhaustive 소비** — `silentPushTask.ts:495/927/947/1050/1066`이 if-체인. 모르는 kind = 컴파일 통과 + 런타임 silent drop.
3. **example-only 테스트** — replay fixture는 "그 trip"만 재현. 새 드리프트/새 liveness 위반 미포착.
4. **de-wire 갭** — wire-completion(연결 확인) 룰은 있으나 채널 **은퇴** 시 지표/소비자 orphan을 잡는 룰은 없음(`silentPushReach`가 은퇴 채널을 계속 measure).

기존 자산(`backend/alarm-worker`가 이미 `../../../src/shared/`를 import — `dijkstraRoute.ts:16`, `sentry.ts:25`)이 있어 **공유 계약 모듈을 만들 새 인프라는 0**이다.

---

## Decision — 5개 메커니즘을 phase로 도입, 드리프트를 "런타임 사고"에서 "빌드/CI 실패"로 전환

### Phase 0 — 계약 SSoT + exhaustive (핵심, class 직결)
- `src/shared/types/pushContract.ts` 신설: 모든 push discriminator(kind/type/targetKind)를 **단일 union + 상수**로 정의. backend/device 둘 다 이 모듈만 import.
- 모든 kind 소비 지점(`silentPushTask.ts` if-체인, backend `apns.ts`/`scheduled.ts` 발신부)을 **exhaustive `switch` + `assertNever(x)`**로 전환.
- **효과**: backend에 새 kind 추가 → device의 exhaustive switch가 `never` 불일치로 **컴파일 에러**. 드리프트가 CI에서 red.

### Phase 1 — 런타임 계약 검증 (경계)
- 수신(device `extractPayload`) / 발신(backend `buildSilentPushData`) 경계에 스키마 검증(zod 등). 불일치 시 **조용한 drop 대신 명시적 skew 로그**(원본 raw kind 보존 — #2231이 이미 raw-kind 가드 도입, 그 위에 SSoT 검증).

### Phase 2 — liveness/property 불변식 (example 아님)
- fast-check property test: "임의의 cron tick 시퀀스에서 **목적지 도달 trip은 T분 내 발사 정지**"(9h desync class), "임의 payload에서 **알 수 없는 kind는 silent drop 없이 skew로 관측**"(unk class).
- 기존 replay fixture는 유지(회귀 앵커), 그 위에 불변식을 얹는다.

### Phase 3 — de-wire lint
- 채널/이벤트 은퇴 시 그에 묶인 지표/소비자 orphan 감지 룰(`scripts/check-orphan-exports.sh` 확장 or 신규). `silentPushReach` 같은 죽은 지표가 lint fail.

### Phase 4 — 계약 변경 프로세스 강제
- push kind 추가/은퇴 PR은 SSoT + exhaustive + 검증 + 테스트를 **한 PR에 동반**(PR 템플릿 + CI 게이트). 분리 금지.

---

## Acceptance (사용자 가치 → acceptance → 코드)

**사용자 가치**: 재설계·채널 변경 때 backend↔device 정합이 깨져 알림이 **조용히 죽는 사고**가 재발하지 않는다.

- **A1 (Phase 0)**: 의도적으로 backend에만 새 kind를 추가한 데모 PR이 **device 컴파일/CI에서 fail** 한다. (drift = 빌드 실패임을 실증)
- **A2 (Phase 1)**: 알 수 없는 kind 수신 시 silent `unk` 대신 **명시적 skew 로그 + 지표**가 남는다.
- **A3 (Phase 2)**: 목적지 도달 후 발사 정지 상한이 **property test로 보장**(특정 trip replay가 아니라 임의 시퀀스).
- **A4 (Phase 3)**: 채널 은퇴 시 죽은 지표/소비자가 **lint fail**.

**Epic close 조건** (PR 머지 ≠ close): A1~A4가 **CI에서 실제로 red를 낼 수 있음을 데모**(의도적 drift/de-wire PR이 fail하는 것 확인) + 이후 1주간 이 class 재발 0건.

---

## Self-check (시니어 5단 시뮬레이션)

1. **이 class가 정말 반복되나?** — Yes. dump 4증상 + memory 3개 lesson이 동일 class. (통과)
2. **가장 싼 방지가 가장 큰 class를 막나?** — Phase 0(공유 계약+exhaustive)이 unk/legacy/드리프트 전체를 컴파일 타임에 봉쇄. 비용 소~중. (통과)
3. **기존 자산 재사용?** — backend가 이미 src/shared import → 신 인프라 0. #2231의 raw-kind 가드가 Phase 1의 씨앗. (통과)
4. **false binary 아닌가?** — "전부 새로 짜기 vs 방치"가 아니라 5단 phase로 점진 도입, Phase 0만으로도 핵심 class 차단. (통과)
5. **acceptance가 field-verify인가?** — A1~A4가 "PR 머지"가 아니라 "의도적 drift가 CI fail함을 실증" + 1주 재발 0. (통과)

→ 5/5. Phase 0부터 tracer-bullet으로 착수(#2232/#2233 머지 후).

## 금지 / 스코프 경계

- 개별 버그 tactical fix를 이 ADR로 대체하지 않는다 — #2232/#2233은 당장의 발사 스팸·지표를 먼저 고친다. 본 ADR은 그 **재발을 구조적으로 막는** 상위 레이어.
- Phase 0는 계약 파일(`apns.ts`/`silentPushTask.ts`)을 건드리므로 #2232/#2233 머지 **전에는 착수 금지**(동일 파일 충돌).
- 다음 phase는 직전 phase가 머지된 뒤 sub-issue를 만든다 (cascade 금지).
