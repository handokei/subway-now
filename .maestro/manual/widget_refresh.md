# Manual — iOS 홈 위젯 갱신

SpringBoard 접근이 필요해 Maestro로 자동화 불가.

## 사전 준비
- 실기기 + 홈 화면에 subway-now 위젯 추가.
- App Groups 설정이 적용된 빌드.

## 시나리오
1. 앱 실행 → 강남역 부근에서 현재 역 감지.
2. 홈 화면으로 이동.
3. 위젯에 강남역 정보가 표시되는지 확인.
4. 실제로 잠실역까지 이동 → 위젯이 잠실로 갱신되는지 확인 (Background 갱신 주기 고려, 최대 수 분 대기 가능).

## 합격 기준
- 위젯이 widgetStorage에 저장된 현재 역을 표시.
- 역 변경이 위젯에 반영 (BG refresh 정책 한계 내).

## 참고
- targets/subway-widget/, src/utils/widgetStorage.ts.
