# Region Monitoring PoC 결과 (#563)

> 다중 채널 BG 알람 아키텍처(`bg-alarm-multi-channel-plan.md`) 채널 3 본구현 전 신뢰도 검증.
> 결론: **WhileInUse 권한으로는 동작 불가 → 채널 3 폐기**.

## 실측 환경

- **디바이스**: iPhone (실기기)
- **앱 빌드**: dev (`chore/#563-region-monitoring-poc` 브랜치 로컬 빌드)
- **시도한 권한 조합**: WhileInUse only (정책상 1차 시나리오)

## 결과

`Location.startGeofencingAsync()` 호출 시 SDK 레벨에서 실패:

```
state: failed
count: 0
error: "Calling the 'startGeofencingAsync' function has failed
        → Caused by: Background location permission is required
          to do this operation"
```

expo-location SDK (= iOS CoreLocation `startMonitoring(for:)`) 가 region 등록 시점에 **Always(Background) location 권한 entitlement를 요구**. WhileInUse에서는 API 진입 자체가 거부됨 — 우회 경로 없음.

## 결론

**채널 3 (Region Monitoring) 폐기.**

근거:
- 프로젝트 정책: WhileInUse 권한이 1차 시나리오 (다수 사용자가 "사용하는 동안" 선택). `Always` 권한 강제는 정책 위반.
- expo-location / iOS CoreLocation이 region monitoring API에 Background 권한을 강제하므로 SDK 레벨 우회 불가.
- 따라서 WhileInUse 기반 사용자에게는 채널 3이 작동할 수 없음 → 측정/도달률 무의미.

## 후속 액션

- PoC 코드(`src/tasks/regionMonitoringPocTask.ts`, DebugModal Region PoC 섹션) 정리는 별도 이슈로 분리.
- BG 알람 메인 채널은 **Local Notification 사전 예약 + Live Activity push update**로 전환 (BoardingLock 아키텍처, `project_alarm_sla_architecture` 메모 참조).
- 채널 1 (Silent push) — reschedule 정정 역할로 재정의.
- 채널 2 (Alert push) — 사후 fallback 그대로 유지.
