# ADR-007: BG 알람 Channel 3 (Region Monitoring) 공식 폐기

- 상태: Accepted
- 일자: 2026-05-28
- 관련 이슈: #563 (PoC 트랙), #582 (본 결정)
- 관련 메모리: `feedback_whileinuse_must_work`, `project_alarm_sla_architecture`

## 컨텍스트

`bg-alarm-multi-channel-plan.md`(2026-04-x)에서 BG 알람 도달 보장을 위해 4채널 아키텍처를 채택했다. 그 중 **채널 3 (Region Monitoring)** 은 push 채널을 우회해 iOS Location Services의 WiFi/cellular 기반 region 진입 감지를 활용하는 트랙이었다.

#563은 이 채널의 본구현 전 신뢰도 검증 PoC였다.

- 등록 API: `Location.startGeofencingAsync(taskName, regions[])`
- 사용 권한: WhileInUse (프로젝트 1차 시나리오)
- 검증 항목: 진입 wake 안정성, 지하 감지율, 환승 재등록 매끄러움

## 실측 결과

`Location.startGeofencingAsync()` 호출 시 SDK 레벨에서 즉시 실패:

```
state: failed
count: 0
error: "Calling the 'startGeofencingAsync' function has failed
        → Caused by: Background location permission is required
          to do this operation"
```

expo-location SDK (= iOS CoreLocation `startMonitoring(for:)`) 가 region 등록 시점에 **Background(Always) location 권한 entitlement를 요구한다.** WhileInUse 권한에서는 API 진입 자체가 거부되며 우회 경로 없음.

진입 wake / 지하 감지율 / 환승 재등록 등 후속 측정 자체가 불가능.

## 결정

**채널 3 (Region Monitoring) 공식 폐기.**

근거:
1. 프로젝트 정책상 WhileInUse가 1차 시나리오 (메모리 `feedback_whileinuse_must_work`). 다수 사용자가 "사용하는 동안"을 선택하며 Always 권한 강제는 정책 위반.
2. expo-location / iOS CoreLocation이 region monitoring API에 Background 권한을 강제 → SDK 레벨 우회 불가.
3. 따라서 WhileInUse 사용자에게 채널 3은 작동할 수 없음 → 본구현 시 도달률 0%.

## 대안 — Channel 3 자리에 들어갈 메인 BG 채널

`project_alarm_sla_architecture` 메모(2026-05-28 결정)에 정합:

| 트랙 | 역할 |
|---|---|
| **Local Notification 사전 예약 (BoardingLock + Per-Hop Adaptive Scheduling)** | 메인 BG 채널. OS 스케줄러가 예약 시각에 발사 — 네트워크/푸시 채널과 무관. WhileInUse + 저전력 + 지하 약신호 시나리오까지 커버. |
| **Live Activity push update** | 보조 — 잠금화면/Dynamic Island 표시 갱신. |
| 채널 1 (Silent push) | Reschedule 정정 역할로 재정의. |
| 채널 2 (Alert push fallback) | 사후 fallback 그대로 유지. |
| 채널 4 (BG GPS task) | Always 사용자 자동 활성, 그대로 유지. |

관련 후속 이슈: #584 (BoardingLock 통합), #585 (Backend per-hop), #586 (Live Activity).

## 영향

- `tasks/bg-alarm-multi-channel-plan.md` 채널 3 섹션 strike-through + Phase 3 폐기 명시 (로컬 워킹 노트, 본 ADR이 최종 SoT).
- `tasks/region-monitoring-poc-result.md` 본 결정의 원본 실측 데이터 (로컬).
- PoC 코드(`src/tasks/regionMonitoringPocTask.ts`, `DebugModal` Region PoC 섹션) 정리는 별도 chore 이슈로 분리. 현재 상태에선 dead code이지만, 추후 채널 신뢰도 비교 측정이 필요해질 경우 참고가 될 수 있어 일괄 삭제는 보류.

## Limitations

본 결정은 **현 시점 iOS / expo-location SDK 동작에 기반**한다. Apple이 향후 WhileInUse에서 region monitoring을 허용하도록 정책을 변경하면 재검토 여지가 있다. 그러나 위 1번(WhileInUse 1차 시민 정책)은 외부 변화와 무관하게 유지된다.
