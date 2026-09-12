# ADR-012: Alarm Dedup Idempotency Key 설계

## 상태

Proposed (2026-06-10)

관련 이슈: #1059 (본 ADR), #462 (destinationId 스코프), #580 (suppressed dedup 관찰), #699 (destId 추적 ref), #754 (in-flight dedup)
참조 ADR: ADR-006 (silent push telemetry), ADR-007 (Channel 3 deprecated), ADR-010 (sensor fusion policy)
참조 메모: `project_alarm_sla_architecture`, `project_alarm_misfire_queue`, `project_2026_06_10_requirements_complete`

## 배경 — 현재 dedup 메커니즘과 사각지대

본 앱의 알람 발화는 두 출처에서 들어온다:

1. **Foreground 훅** `useStationAlarm` (`src/features/alarm/hooks/useStationAlarm.ts`) — GPS 폴링 → `evaluateAlarmPhase` 평가
2. **Background task** `backgroundLocationTask` + silent push 수신 (`scheduledAlarmReceiver.ts`)

두 출처가 같은 trip의 같은 phase를 중복 발화하지 않도록 하나의 dedup state를 공유한다.

### 현재 구현 (2026-06-10 기준)

- **저장소**: AsyncStorage 키 `FIRED_ALARMS_KEY` — 즉, **이미 cold start를 살아남는다** (`src/features/alarm/utils/notificationState.ts:54-97`)
- **저장 포맷**: `{ destinationId: string, alarms: string[] }` envelope (#462)
- **읽기 시 스코프**: 호출자가 현재 `destinationId`를 넘기고, 저장된 record의 destinationId가 다르면 빈 set 반환 → cross-trip leak 차단
- **In-memory 미러**: `useStationAlarm`의 `firedAlarmsRef: Set<string>` + `firedAlarmsRefDestIdRef` (#699 — ref 내용이 어느 destinationId에 속하는지 추적)
- **키 shape**: `${phase.id}:${target.name}` (`src/features/alarm/utils/stationAlarm.ts:127`)
- **In-flight dedup**: 알람 발사 직전 ref에 즉시 add (#754) — `await` 동안 다음 tick effect가 같은 키로 재발화 차단

### 사각지대

| # | 사각지대 | 원인 |
|---|---|---|
| 1 | 환승역 이름 중복 (예: "왕십리" 1·2·5·수인분당선) | 키가 `target.name`만 포함 → 같은 이름 다른 leg가 1회로 합쳐질 위험 |
| 2 | Silent push (backend) vs Local pre-scheduled (`scheduledAlarmReceiver.ts`) cross-source | 동일 trip의 같은 알람이 두 채널에서 나란히 fire되면 한쪽이 다른쪽을 silence할 수 있는지 불확실. 현재 destination + phase + name match에 의존 |
| 3 | BoardingLock swap | 환승 hop에서 lock 객체가 바뀔 때 trip의 "user-perceived continuity"를 키가 보존하지 못함 — destinationId가 다음 leg의 lock id로 갱신되면 envelope check가 stale로 판정해 dedup state가 reset됨 |
| 4 | Phase enum과 alarmType이 키에 명시되지 않음 | `phase.id`는 들어있지만 `target.alarmType` (transfer/destination)이 키에 없어 같은 station을 두 alarmType이 가리킬 때 ambiguity. 현재 `target.name`이 둘을 구분하긴 하나 명시적이지 않다 |

이 사각지대를 잠재적으로 해소하기 위해 **명시적 idempotency key 재설계**를 제안한다. 구현은 별도 follow-up.

## 결정 — Idempotency key shape 재설계 (Proposed)

다음 형태의 key를 채택한다:

```
${tripId}:${stationId}:${alarmType}:${phase}
```

| 필드 | 정의 | SSOT | 비고 |
|---|---|---|---|
| `tripId` | trip lifecycle 안정 식별자. user-perceived "한 번의 외출" 단위 | createdAt + token 해시 (예: `${createdAt}-${token.slice(-8)}`) | BoardingLock swap이 발생해도 동일 trip의 다음 leg에서 같은 tripId를 유지하려면 createdAt 보존 정책 필요 — Follow-up 1 |
| `stationId` | 역의 data id (NOT 이름) | `stations.json`의 `id` | 환승역 동명 이형 문제 해소 (사각지대 #1) |
| `alarmType` | 알람 종류 enum | `src/shared/constants/labels.ts` 또는 alarm types | `'transfer'` / `'destination'` / `'boarding-prompt'` 등 |
| `phase` | preview/pre vs actual fire 구분 | `src/features/alarm/utils/alarmPhases.ts` | 기존 `phase.id` 그대로 (`'early'` / `'imminent'` / `'arrived'` 등) — 단, phase 의미를 "pre" vs "fire"로 명시화 검토 |

### 저장소

- **유지**: AsyncStorage `FIRED_ALARMS_KEY` (이미 cold start 생존)
- **변경**:
  - record envelope을 `destinationId` 단일 스코프 → `tripId` 스코프로 전환
  - 24h TTL prune (`{ tripId, alarms, expiresAt }`) — trip 종료 신호 누락 시에도 storage 무한 누적 차단
  - in-memory 캐시 + write-through 패턴 유지 (alarm decision은 critical path → AsyncStorage read latency 회피)

### Cross-source dedup

Silent push (backend) → `scheduledAlarmReceiver.ts`도 같은 key shape를 사용해 동일 storage에 write. backend 응답 payload에 `{tripId, stationId, alarmType, phase}` 4-tuple을 명시적으로 포함시켜 클라이언트가 그대로 key를 구성하게 한다 (이름 정규화 mismatch 차단).

## 트레이드오프

| 장점 | 단점 |
|---|---|
| 환승역 동명 이형 문제 해소 (stationId 사용) | 키 길이 증가 → storage 미세 비용 |
| Cross-source (backend silent push + local) dedup 동일 키 shape | backend도 같은 key shape를 emit하도록 protocol 변경 필요 |
| Phase의 pre/fire 의미 명시 → 두 phase 중복 발화 방지 | 기존 in-flight `firedAlarms`와 마이그레이션 호환 모드 필요 |
| 24h TTL로 storage 무한 누적 차단 | 24h 초과 장기 trip은 dedup 상실 (현실적으로 비현실 시나리오) |
| 디버그 가능한 구조화된 키 | opaque hash보다 키 길이 김 |

## Alternatives Considered

| 대안 | 거부 이유 |
|---|---|
| (A) 현행 유지 (`${phase.id}:${target.name}`) | 환승역 동명 이형(#1) + cross-source 명시성 부족(#2) 그대로. memory `project_2026_06_10_requirements_complete` 가 본 ADR 작성을 명시 요청 |
| (B) Backend-only dedup (서버가 모든 fire를 게이트, 클라는 무조건 발화) | 로컬 L3 90s fallback과 같이 backend 없이 발사되는 경로 존재 — 단일 출처 불가 |
| (C) 해시 기반 opaque key (`sha256(tripId+stationId+...)`) | 디버그/관찰성 손실. 현재 `alarmLog`의 dedup 엔트리(#580)가 키를 직접 노출하므로 구조화된 키가 운영상 유리 |
| (D) tripId 대신 destinationId 유지 | BoardingLock swap 시 destinationId 갱신되며 dedup state reset되는 사각지대 #3 미해소 |

## Relation to other ADRs

| ADR | 본 ADR과의 경계 |
|---|---|
| ADR-006 (silent push telemetry) | dedup 적중/누락 카운터는 ADR-006 KV stats 패턴에 위임. 본 ADR은 키 정의 + storage 정책만 |
| ADR-007 (Channel 3 deprecated) | Channel 3 제거 결정과 무관 — Channel 1(정정) + Local pre-scheduled + silent push 세 출처 모두 본 ADR의 키 shape를 공유 |
| ADR-010 (sensor fusion / boarding prompt) | boarding-prompt도 `alarmType` enum의 한 값. 본 ADR이 정의하는 키 shape로 dedup |

## Follow-ups

1. **tripId 정의 SSOT** — BoardingLock swap 시 user-perceived "같은 trip" 보존을 위해 createdAt 기반 canonical id 도입. 현재 `BoardingLock.createdAt` + token 조합 검토.
2. **마이그레이션 정책** — 기존 `{destinationId, alarms[]}` record와 신규 `{tripId, alarms[], expiresAt}` 호환 모드. 구버전 envelope 감지 시 in-memory fallback + 다음 trip부터 신 포맷.
3. **Backend protocol 변경** — silent push payload에 `{tripId, stationId, alarmType, phase}` 4-tuple 포함. APNs payload 스키마 버전 bump.
4. **`alarmLog` 'dedup-alarm' 엔트리 키 호환성** — 기존 `${phase.id}:${target.name}` 패턴 매칭 코드(#580)의 분석 대시보드 마이그레이션.
5. **구현 PR 분할** — (a) tripId 도입 (b) key shape 변경 (c) backend protocol (d) 마이그레이션 호환 모드. Stacked PR 패턴.

## References

**현행 코드 (worktree `dev` 기준)**:
- `src/features/alarm/utils/notificationState.ts:54-97` — `FIRED_ALARMS_KEY` envelope (destinationId 스코프, #462)
- `src/features/alarm/utils/stationAlarm.ts:104-152` — `evaluateAlarmPhase` 키 생성 (`${phase.id}:${target.name}`)
- `src/features/alarm/hooks/useStationAlarm.ts:248-358` — in-memory `firedAlarmsRef` + destId tracking ref (#699) + in-flight dedup (#754)
- `src/features/alarm/utils/scheduledAlarmReceiver.ts` — silent push 측 firedAlarms 갱신 (#462)
- `src/features/alarm/utils/alarmLog.ts:51, 239-249` — `dedup-alarm` 엔트리 (#580)
- `src/shared/constants/storageKeys.ts` — `FIRED_ALARMS_KEY`

**메모**: `project_2026_06_10_requirements_complete`(본 ADR 작성 요청 출처), `project_alarm_sla_architecture`(SLA 아키텍처), `project_alarm_misfire_queue`(과거 misfire 회귀)
