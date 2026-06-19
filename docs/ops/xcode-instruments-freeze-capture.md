# Xcode Instruments freeze 캡처 가이드 (S13 #1546)

본 문서는 실기기에서 앱이 "수 초간 응답 없음" 또는 main thread block을 일으킬 때 Instruments로 stack trace를 캡처하는 절차의 SSOT.

대상 사례:
- TestFlight 빌드 15:42 KST UI freeze (evidence 트립)
- BG → FG 복귀 직후 hang
- 알람 fire 직후 main thread block

## 준비

- macOS + Xcode (CLI tools만으로는 부족, full Xcode 필요)
- Apple Developer 계정 (실기기 attach 가능한 provisioning profile)
- 디바이스 USB 연결 + "이 컴퓨터 신뢰" 완료
- 캡처 대상은 **EAS production 또는 development 빌드 설치된 실기기**. 시뮬레이터는 main thread 타이밍이 다르므로 freeze 재현이 불가능한 경우가 많다.

## Hang Tracer (가벼움, 1차 선택)

iOS 16+ 기본 제공. 1초 이상 main thread block을 자동 기록.

1. Xcode → Open Developer Tool → Instruments
2. Template: **Hangs** 선택
3. 상단 target dropdown → 디바이스 + `SubwayNow` 앱 선택
4. 빨간 Record 버튼
5. freeze 재현 시나리오 수행 (예: BG → FG 복귀, 알람 fire 후 탭)
6. freeze 발생 후 5초 대기 → Stop 버튼
7. Hangs track에 표시된 막대 클릭 → 우측 Detail pane에서 main thread stack 확인

## Time Profiler (정밀, 2차)

Hang Tracer가 1초 미만 block을 놓치거나 CPU 분포가 필요할 때.

1. Instruments → Template **Time Profiler**
2. 동일하게 디바이스/앱 선택 → Record
3. 시나리오 수행 → Stop
4. Call Tree pane:
   - Separate by Thread: ON
   - Invert Call Tree: ON
   - Hide System Libraries: ON (앱 코드만)
5. Main Thread row 펼쳐 self time 상위 함수 확인

JS 작업이 main thread를 블록하는 경우 `RCTBridge`, `RCTCxxBridge`, `facebook::react::*` 프레임이 상단에 잡힌다. Native 작업이 원인이면 `subway-now`, `live-activity`, `audio-route` 등 본 프로젝트 native module 프레임이 보인다.

## 캡처 파일 공유

1. Instruments File → Save → `.trace` 파일 (보통 수십 MB)
2. zip으로 압축 후 GitHub Issue 첨부 또는 사용자가 직접 분석
3. `.trace` 파일은 PII(앱 내부 상태) 포함 가능 — public repo에 커밋 금지

## 결과 보고 템플릿

GitHub Issue 또는 RCA 문서에 첨부할 때:

```
## Instruments 캡처 결과
- 디바이스: iPhone <모델> / iOS <버전>
- 빌드: <buildNumber> (EAS <profile>)
- 시나리오: <재현 단계>
- freeze 시각: <KST HH:MM:SS>
- 지속 시간: <초>
- Main thread 상위 프레임 (3~5개):
  1. <함수> — <self time>
  2. ...
- 가설: <JS/Native/IO/lock contention>
```

## 한계

- 백그라운드 freeze는 OS가 Suspend 상태로 만들기 때문에 Instruments로 캡처 불가능 — 별도 로그(`os_log`) 또는 Sentry breadcrumb로 추적.
- TestFlight 빌드는 Release 최적화로 일부 frame이 inline되어 stack이 짧을 수 있다. 가능하면 development profile + `-O0` 빌드로 재현.

## Sentry와의 관계

Sentry는 JS error / unhandled promise는 잡지만, native main thread hang은 직접 잡지 못한다(Sentry React Native 7.x 기준 `enableAppHangTracking`은 native 옵션이지만 iOS-only + 별도 설정 필요). 본 문서의 Instruments 절차는 Sentry breadcrumb로 freeze 직전까지의 trail을 좁힌 후 native stack까지 짚어가기 위한 보완 절차.

[sentry-setup.md](./sentry-setup.md)와 함께 사용.
