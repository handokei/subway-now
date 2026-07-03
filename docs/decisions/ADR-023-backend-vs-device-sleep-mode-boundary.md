# ADR-023 — 취침모드 역할 경계: Backend Silent Push vs Device UI Decision

## 상태

Accepted — 이슈 #2033, 2026-07-04. Stage G/H audit 결과 현재 아키텍처가 이미 원칙 정합. 코드 변경 없음, 문서화 + code comment 보강만.

## 배경

취침모드(sleepMode) 알림 억제 로직이 backend와 device 어느 쪽에 위치해야 하는지에 대한 의문:

- **Backend** (`backend/alarm-worker/src/scheduled.ts`): Seoul TOPIS API `arvlCd` (0=진입, 1=도착) 신호를 관측해 silent push를 발사한다.
- **Device** (`src/features/alarm/utils/shouldSuppressBySleepRule.ts`): silent push 수신 후 취침모드 규칙에 따라 UI 발사(alert/haptic) 여부를 결정한다.
- 의문: "Backend가 취침모드 상태를 이미 알고 있다면(#2032, Issue D), 아예 silent push를 보내지 않는 편이 낫지 않은가?"

Issue D(#2032)로 backend `Trip.sleepModeEnabled` 저장이 완료되면 backend에서 취침 상태 참조 가능. 그럼에도 device 단일 gate 정책을 유지할지 결정 필요.

## 결정

**Backend + Device 분담 유지** — 현재 방식(현재 아키텍처가 이미 원칙 정합).

1. **Backend는 arvlCd 신호 기반 silent push를 무조건 발사** (취침모드 무관). `scheduled.ts` 5개 발사 경로 모두 sleep 참조 없음.
2. **Device가 `shouldSuppressBySleepRule` 단일 gate에서 필터링** — FG/BG/Scheduler 3개 호출처 모두 동일 함수 위임.
3. **Exception: destination kind는 device도 차단하지 않음** — 도착 알림 누락 → 최종 하차역 놓침(critical). transfer/station-passed 첫 hop만 suppress.

Issue D(#2032)의 `Trip.sleepModeEnabled`는 저장/monitoring 전용. Backend 발사 gate에 사용하지 않는다.

## 이유

### "Backend 안 보냄" 대안을 채택하지 않는 이유

| 측면 | 현재 (Backend 발사 + Device 차단) | 대안 (Backend 발사 안 함) | Winner |
|---|---|---|---|
| 네트워크 비용 | silent push 1회 | push 0회 | 대안 |
| 배터리 비용 | wake + parse | sleep 유지 | 대안 |
| Monitoring | backend signal 자동 수집 (skip 원인 분류 가능) | device only | **현재** |
| Fallback safety | device logic bug 시 silent push는 도달 → recovery 가능 | backend에서 skip되면 device 못 복구 | **현재** |
| Debug 용이성 | backend log + device log 양쪽 대조 | device log만 | **현재** |
| Separation of concerns | Backend = 신호 관측, Device = 정책 판정 (clean) | Backend가 정책 state machine 소유 (coupling) | **현재** |

정확도(false positive / miss 동급, ADR-010 첫 줄 원칙)를 위한 fallback safety + observability 우위가 미미한 네트워크/배터리 비용을 압도.

### "Backend 무조건 발사"의 3가지 근거

1. **Clean separation of concerns** — Backend는 Seoul TOPIS 신호 관측기, Device는 사용자 UI 정책 결정자. Backend가 취침 상태 state machine을 소유하면 device sleep 토글 시점과 backend KV 동기화 race window가 정확성 리스크로 전환된다.
2. **Fallback safety** — Device의 `shouldSuppressBySleepRule` 로직에 버그가 있어도 silent push 자체는 backend에서 도달하므로 device 측 log/monitoring으로 감지 가능. Backend에서 skip하면 device는 아예 신호를 못 받아 침묵 회귀(2026-06-17 군자/용마산 유형)를 재현할 위험.
3. **Observability** — silent push 발사 통계(`scheduled.ts` stats.silentPushFiredByKind)와 device suppress log(`alarmLog.ts:143` `logSuppressedSleepFirstTransfer`)를 backend + device 양쪽에서 수집. 회귀 발생 시 backend 발사 여부와 device 차단 여부를 독립 확인 가능.

## Exception: Destination Kind

Device의 `shouldSuppressBySleepRule.ts` 정책 (line 55–59):

```ts
// transfer / station-passed 첫 hop → suppress (취침 중 환승 침묵)
// destination → 항상 fire (도착 놓칠 위험 방지)
```

이유:
- 취침 중 도착 알림을 놓치면 최종 하차역을 지나쳐 overshoot 발생 → 사용자 실질적 손해(재탑승 시간/비용).
- 반면 transfer 침묵은 최악의 경우 다음 hop에서 다시 안내 (recovery 가능).
- 도착 후 취침 알람 재개 로직은 별도 device layer (Issue I: 취침모드 환승 알람).

## 구현 지점

### Backend 발사 경로 5개 (모두 sleep 무관)

| 경로 | 파일:라인 | Waypoint Kind | Sleep 참조 |
|---|---|---|---|
| `fireArvlCdStationPush` 함수 | `scheduled.ts:1675` | all (intermediate/transfer/destination) | 없음 |
| ARV 단일 진입 → 위임 호출 | `scheduled.ts:2036` | all | 없음 |
| Vanish fallback fire | `scheduled.ts:2426` | all | 없음 |
| Vanish release fire | `scheduled.ts:2469` | all | 없음 |
| `runLocklessIntermediate` 함수 | `scheduled.ts:3227` | intermediate only | 없음 |

라인 번호는 audit 시점(2026-07-04) 기준. 리팩터링으로 이동 가능하므로 관계 확인은 grep으로.

### Device 필터 3경로 (`shouldSuppressBySleepRule` 단일화)

| 호출처 | 파일:라인 | Kind 필터 | Sleep 차단 대상 |
|---|---|---|---|
| FG GPS/ARV `useStationAlarm` | `src/features/alarm/hooks/useStationAlarm.ts:831` | transfer, station-passed | 첫 hop 전용 |
| BG station pipeline | `src/features/alarm/utils/stationPipeline.ts:305`, `:413` | transfer, station-passed | 첫 hop 전용 |
| Scheduler 사전 예약 wrapper | `src/features/alarm/utils/boardingLockScheduler.ts:239` | transfer, station-passed | 첫 hop 전용 |

정책 소스: `src/features/alarm/utils/shouldSuppressBySleepRule.ts:55-59`. 3개 호출처 모두 동일 함수 위임 — 정책 drift 원천 차단.

## 관련

- **ADR-010** — Sensor fusion 정책 (false positive / miss 동급 원칙 첫 줄).
- **ADR-017** — Trip Position SSoT 설계.
- **ADR-022** — Arrival API SSOT 재설계 (arvlCd 단일 신호 근거).
- **Issue #2032 (Issue D)** — Backend `Trip.sleepModeEnabled` 저장. 본 ADR의 결정에 따라 monitoring 전용, 발사 gate 미사용.
- **Issue #2033 (본 이슈)** — Stage G/H audit 결과 문서화.
- **Issue I** — 취침모드 환승 알람 (transfer wake-up logic, device-only layer).
