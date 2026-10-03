# Manual — Silent Push 수신

APNs Silent Push 수신 동작은 시뮬레이터에서 신뢰할 수 없어 실기기 검증.

## 사전 준비
- 실기기 + Production/Development 빌드.
- BG 위치 권한 거부 상태(BG 알람을 silent push fallback으로 대체 검증).

## 시나리오
1. 앱 실행 → 목적지 설정 → 취침 모드 ON → BG 진입.
2. Silent push 발송 트리거 (서버 측 또는 디버그 도구).
3. 디바이스가 백그라운드에서 useStationAlarm 사이클을 한 번 더 돌리는지 로그/알람 발화로 확인.

## 합격 기준
- silent push 수신 후 BG fetch가 트리거되어 알람 발화 또는 위치 갱신.
- 사용자 UI 노이즈 없음(silent push 본래 동작).

## 참고
- 관련 로드맵: project_bg_alarm_no_always_roadmap.md (#334~#341).
