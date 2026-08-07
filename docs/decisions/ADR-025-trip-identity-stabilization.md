# ADR-025 — Trip 신원 안정화: token rotation 폐기, route 변경은 in-place state reset

- **Status**: Proposed (2026-08-07)
- **Supersedes**: ADR-022 **B4** ("Backend trip token 재사용 방지 — 새 route 등록 시 새 token 강제")
- **관련 회귀 이력**: #1986 → #2002 → #2019 → #2129 → #2173 → #2174 → #2175 (rotation 단일 주제 7개 PR / `grep rotat` 16 commits)

---

## Context

### 문제 (2026-08-07 실탑승 오전 트립, corrId=tmsi34imn)

한 트립(용마산7 → 건대2 → 성수 → 뚝섬) 동안:

1. route 변경마다 `rotateTripTokenForNewRoute`가 **새 UUID 발급** (`trip_metrics` end_reason=`rotated` 2건: 07:30, 07:36).
2. device는 응답의 UUID를 채택하지 않고 **실 deviceToken으로 계속 `POST /trips`** (설계상, #2174 주석).
3. `POST /trips` rate-limit(`index.ts:567`)이 **`incoming.token`(=deviceToken) 앞 16자 키**로 판정 → 모든 재-POST가 **같은 키에 충돌**. cap=10/10min.
4. 로테이션 재-POST + 재시도 + heal POST가 창을 넘김 → **HTTP 429 × 6 + Aborted(5s) × 2** → **정작 새 route trip이 등록 실패**.
5. 새 trip이 KV에 안 써짐 → cron이 push를 못 쏨 → `silent_push_received=0`, `chain_complete=0` (전 트립).

### 왜 "코드를 특정해도 매번 안 고쳐졌는가"

rotation은 도입 이후 **7번 패치**됐다. 각 패치는 "신원 churn을 견디기 위한 기계장치"를 하나씩 추가한 것이었다:

| PR | 추가한 기계장치 | 무엇을 견디려고 |
|---|---|---|
| #2019 | `POST /trips`에 rotation wire | ADR-022 B4 이행 |
| #2129 | rotation 동시성 race 차단 | 동일 token 동시 register 시 trip 이중 생존 |
| #2173 | `TOKEN_ROTATION_DISABLED` guard (P0 지혈) | UUID가 push 주소 파괴 → 400 즉사 |
| #2174 | `trip.deviceToken` 필드 분리 | push는 실 토큰, 신원만 UUID |
| #2175 | `device-trips:<deviceToken>` 역인덱스 | UUID 교체 후 직접 키 조회 miss 복구 |

그럼에도 오늘 chain이 죽었다. **rotation이 자초한 문제(신원 churn)를 계속 방어하느라, 정작 rate-limit 충돌이라는 상위 실패가 남았다.** 이것은 whack-a-mole의 교과서적 사례다 (`lesson_tactical_fix_whack_a_mole_systemic`).

### rotation의 실질 가치는 하나뿐

코드 주석(`index.ts` rotation 영역, 07-03 evidence)이 명시하듯, rotation이 실제로 해결하는 것은 **단 하나**:

> 구 route의 잔재 `pending:*` push가 계속 발사되는 것을 `cleanupPendingPushesForToken(oldToken)`으로 제거.

즉 목표는 **"route가 바뀌면 이전 route의 stale 상태(pending push / dedup / notification state)를 지운다"** 이고, 현재는 그걸 **신원 자체를 버리는 방식**으로 달성하고 있다. 신원을 버리니 신원을 추적하던 모든 것(push 주소·dedup 키·역인덱스·rate-limit 키)이 sync 대상이 되어 실패 표면이 오히려 늘었다 — ADR-022 A4가 경계한 바로 그 함정("자동 swap이 있으면 backend token, dedup key, notification state 모두 sync 대상")을 B4 자신이 범했다.

---

## Decision

### 옵션 비교 (false binary 금지 — 4개)

| # | 방안 | 신원 churn | 429 chain-death | 재발 클래스 종료 | 비용 |
|---|---|---|---|---|---|
| **1 (채택)** | **rotation 폐기 + 안정 신원(deviceToken 유도) + route 변경 시 in-place state reset** | 제거 | 제거 | rotation 16-commit + A-1 동시 종료 | backend 중간 리팩터 + legacy KV 마이그레이션 |
| 2 | rotation 유지 + rate-limit을 route-sig 인지 키로 | 유지 | 완화 | ✗ (churn 방어 기계장치 존속 → 다음 구멍 대기) | 소 |
| 3 | rotation 유지 + client 디바운스 + Retry-After 존중 | 유지 | 완화(부분) | ✗ | 소 |
| 4 | 현행 유지 + 관측만 강화 | 유지 | ✗ | ✗ (구조적 무해결) | 최소 |

옵션 2·3·4는 "게이트 하나 더 추가" — 지금까지 7번 실패한 그 방식이다. **옵션 1만이 재발 클래스를 종료한다.**

### 채택: 옵션 1

1. **신원 안정화** — trip 식별자는 트립 수명 동안 **불변**. 값은 device의 실 APNs deviceToken(또는 그 안정 해시). route가 바뀌어도 신원은 그대로다. (deviceToken 자체가 OS APNs refresh로 바뀌는 것은 트립-단위가 아닌 드문 이벤트 — #2175 역인덱스가 이미 처리하며, 이 경로는 존치한다.)

2. **route 변경 = in-place mutation** — `rotateTripTokenForNewRoute`를 `resetTripStateForNewRoute`로 대체한다. route sig(`computeRouteSignature`)가 달라지면:
   - `trip:<stableToken>` 레코드를 **그 자리에서 갱신**(waypoints/destination/routeSig 교체). 새 키 생성/구 키 삭제 없음.
   - `cleanupPendingPushesForToken(stableToken)` 호출 — **rotation의 유일한 실질 가치를 그대로 이관**.
   - trip-scoped dedup / notification state를 route 변경 경계에서 reset (SSoT mirror 포함).

3. **rate-limit은 create/update 구분** — 기존 same-device trip의 route 변경 재등록은 **create가 아니라 update**다. update는 create budget(10/10min)에서 **면제**하거나 별도 관대 한도를 둔다. → 429 chain-death 제거.

4. **ADR-022 B4의 목표는 유지** — "route 변경 시 이전 route 상태 이월 금지"는 2·(pending purge + state reset)로 그대로 달성. 폐기하는 것은 **메커니즘(new token)** 뿐, **목표가 아니다.**

---

## Consequences

### 제거/단순화 (신원 안정화가 orphan으로 만드는 것만 — surgical)
- `crypto.randomUUID()` 신원 발급 경로 (`trips.ts`).
- `rotated` end_reason 발생 경로 (`tripStatus.ts:125`, `types.ts`) — 관측 sentinel은 마지막 legacy 소비자 확인 후 정리.
- `TOKEN_ROTATION_DISABLED` guard (#2173) — 존재 이유(UUID가 push 파괴)가 사라짐.
- `device-trips:<deviceToken>` 역인덱스(#2175) — 신원이 이미 deviceToken이면 직접 키 조회가 항상 성공 → 역인덱스는 **APNs refresh 복구 용도로만 축소** 존치(트립-단위 churn 소비자 제거).

### 존치
- `trip.deviceToken`(#2174) — 신원과 push 주소가 값은 같아도 **의미 분리는 유지**(레이어 명확성 + legacy 레코드 호환).
- APNs token refresh 복구 경로 — OS-driven 신원 변경은 여전히 발생하므로.

### 마이그레이션
- 기존 KV의 UUID-신원 legacy trip 레코드: TTL 자연 만료로 흡수(신규 등록부터 안정 신원). 강제 마이그레이션 불필요.
- arch flag `arch:simple-arrival-v1` = 최종 스위치 유지 — 단계적 롤아웃.

---

## Trade-offs (정직하게)

- **ADR-022 B4 "new route = new token" 명시 결정을 폐기**한다. 근거: 목표는 in-place reset이 더 적은 실패 표면으로 달성. (본 ADR이 supersede.)
- **중간 규모 backend 리팩터** — `trips.ts` + `index.ts POST /trips` handler + `tripRegisterRateLimit.ts`. 같은 파일(index.ts)을 여러 이슈가 건드리므로 **직렬 머지** 필요.
- **device 재검증 필수** — 신원/등록 경로 변경은 실기기 트립으로만 최종 확인 가능(CI는 정적 검증만).
- **coverage 100% 게이트** — rotation 경로 테스트 삭제/교체로 커버리지 재정렬 필요.

---

## Acceptance (PR 머지 = close 금지)

1. **red replay fixture 선행** — 2026-08-07 오전 덤프(corrId=tmsi34imn)를 backend 통합 테스트 fixture로: rotation storm → 429 → 등록 실패를 **먼저 재현(red)**, 안정 신원 적용 후 **green**(재-POST가 update로 흡수, 429=0, trip 1건 지속 등록).
2. **field verify** — 실탑승 1주간 `end_reason=rotated` 0건 + `POST /trips` 429 0건 + `chain_complete` 정상.
3. **관측** — `trip_metrics`에서 route 변경이 새 row가 아닌 동일 trip의 update로 관측될 것.
