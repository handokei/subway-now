# BG silent push 알람 미발화 — 실기기 검증 결과

작성: 2026-05-27. 실기기 출퇴근 trip 검증 후.

## 증상

- 실기기 (iPhone 13 mini, iOS 26.3.1) Release 빌드 설치 후 출퇴근 trip
- 앱 trip 활성화 → BG 진입 (잠금/이동)
- **BG에서 환승/도착 알람 미발화**
- 잠금화면 LA는 잘 보임 (PR #535 #534 정상)

## 선행 차단 요인

**[[bg-trip-persistence]] 이슈 — BG에서 trip 사라짐**.

trip이 사라지면 silent push 자체가 발사 조건 미충족. trip 사라짐을 먼저 해결해야 silent push 검증 가능.

## #506 본 이슈 상태

| 항목 | 상태 |
|---|---|
| permission, apnsToken, taskRegistration, apnsEnv | ✅ 정상 (DebugModal 확인) |
| activeTrip 등록 | ✅ 정상 (FG 상태에서 확인) |
| backend 발사 시도 | ❓ wrangler tail 확인 필요 |
| 클라 수신 (lastReceived) | ❌ never |

## 다음 단계 (trip 영속화 후)

1. trip 영속화 fix 머지 후 동일 실기기 검증
2. BG 진입 후에도 activeTrip 유지 확인
3. 위치 변화 발생 시 backend 발사 시도 → wrangler tail에서 푸시 발사 응답 확인
4. APNs 응답 (200 vs BadDeviceToken/410) 분석

## 가능 원인 후순위 (trip 살아있다고 가정 시)

- **silent push 클라 수신 차단**: iOS BG fetch 권한 또는 expo-notifications 콜백 미동작
- **backend가 위치 phase 진행 감지 못함**: 위치 업데이트 freq + APNs 발사 임계값 검토
- **silent push TTL**: 네트워크 일시 끊김 시 큐잉 만료

## 관련

- [[subway-now-506-silent-push-diag]] (이전 메모리)
- [[bg-trip-persistence]] (선행 이슈)
- [[subway-now-bg-alarm-infra]] (BG 알람 인프라 3중 막힘 진단)

## 작업

- GitHub Issue 등록 (label: `fix`)
- "BG trip 사라짐 해결 후 재검증" 의존성 명시
