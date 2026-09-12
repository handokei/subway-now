---
issue: 563
title: "Region Monitoring PoC — WhileInUse + BG 진입 wake 검증"
created: 2026-06-11
status: concluded-rejected
related:
  - tasks/region-monitoring-poc-result.md
  - tasks/bg-alarm-multi-channel-plan.md
  - "#582"
---

# Region Monitoring PoC — WhileInUse + BG 진입 wake 검증

> **결론 (TL;DR)** — iOS Region Monitoring(geofence)은 **`authorizedAlways` 권한을 SDK/플랫폼 레벨에서 강제**한다. 본 앱의 1차 권한 시나리오는 `WhileInUse`이므로 채널 3은 작동 불가. 실기기 PoC(#563/#582)에서 `Location.startGeofencingAsync()`가 *"Background location permission is required"* 오류로 즉시 실패함을 확인. 채널 3은 폐기되었고 그 자리는 BoardingLock 사전 예약(Local Notification) + Live Activity push update가 대체한다. 본 문서는 그 결정 근거를 Apple 공식 문서 + 1차 자료로 정착한다.

본 문서는 사용자 요청(코드 변경 없는 research only)에 따라 작성된 보고서이며, 기존 PoC 결과 파일(`tasks/region-monitoring-poc-result.md`)을 docs/research 형식으로 격상하고 Apple 문서 인용을 보강한 것이다.

---

## 1. iOS Region Monitoring 권한 요구사항

### 1.1 API 표면

| API | 사용 시점 | 요구 권한 |
| --- | --- | --- |
| `CLLocationManager.startMonitoring(for: CLCircularRegion)` | 레거시 (iOS 4+) | `authorizedAlways` |
| `CLMonitor.add(_:)` (iOS 17+) | 신규 (모던 async API) | `authorizedAlways` |
| `expo-location.startGeofencingAsync()` | RN 래퍼 (위 둘 중 하나로 매핑) | `authorizedAlways` |

### 1.2 WhileInUse vs Always 동작 차이

Apple 공식 문서("Monitoring the user's proximity to geographic regions", developer.apple.com)와 Region Monitoring 가이드(library/archive) 일치 사실:

- **`authorizedWhenInUse`** — region monitoring API 등록 자체가 거부되거나, 등록되더라도 **앱이 foreground 일 때만 entry/exit 이벤트가 발사**된다. 화면 잠금 / 다른 앱 사용 / 강제 종료 후에는 **wake 불가**.
- **`authorizedAlways`** — 시스템이 백그라운드/종료 상태에서도 region boundary cross 시 앱을 깨운다(약 10초 windows). 강제 종료(force quit) 후에도 *재시작* 후 1회는 등록된 region이 유지된다(아래 1.4 참고).

iOS 권한 모델에서 `WhileInUse → Always 업그레이드` 프롬프트가 따로 있지만, **region monitoring API 진입 시점에 동의 상태가 `authorizedAlways`가 아니면 SDK가 즉시 거부**한다 — 이는 본 PoC에서 직접 관측한 동작이다(§4).

### 1.3 iOS 버전 변화

| iOS | 변화 |
| --- | --- |
| 13 | `requestAlwaysAuthorization`에 사용자가 거부 가능한 "While Using" 단계가 끼어 들어옴. UX적으로 Always 동의를 얻기가 어려워짐 |
| 14 | "Approximate location" 옵션 추가. region monitoring은 precise location 필수 |
| 15 | BG entitlement + Background App Refresh 의존성 강화. BG App Refresh OFF면 wake 안 됨 |
| 17 | `CLMonitor` 도입 (async API, condition 객체 기반). 권한 요건은 동일하게 `Always` |

### 1.4 강제 종료(force quit) 후 동작

Apple 개발자 포럼 staff 답변(thread/79465) 요지:
> *"In most cases, the system does not relaunch apps after they are force quit by the user. One exception is location apps, which in iOS 8 and later are relaunched after being force quit by the user."*

즉 Always 권한 + region monitoring 등록이 살아 있는 앱은 force quit 후에도 region cross 시 백그라운드로 깨어난다. 단 이 동작 자체가 **Always 권한 전제**이므로 본 앱에는 무관하다.

---

## 2. BG wake 트리거 보장 여부

### 2.1 entry/exit가 WhileInUse에서 작동하는가?

**No.** Apple 공식 가이드 + expo-location 구현이 일치한다:

- expo-location의 `startGeofencingAsync()`는 iOS 네이티브에서 `CLLocationManager.startMonitoring(for:)`로 매핑된다.
- 이 호출은 권한 상태가 `authorizedAlways`가 아니면 `CLError.denied` 또는 별도 entitlement 오류로 거부된다.
- 시뮬레이터에서는 region 진입 이벤트 자체가 트리거되지 않음(Apple 명시) — PoC는 실기기 필수.

### 2.2 백그라운드 entitlement 요구사항

Always 권한을 받는다 해도 **추가로** 다음이 필요:
- `Info.plist`의 `UIBackgroundModes`에 `location` 포함
- `NSLocationAlwaysAndWhenInUseUsageDescription` 문구
- iOS 설정에서 **Background App Refresh ON** (사용자가 OFF 하면 wake 자체가 안 됨, Apple 명시)
- iOS 설정에서 **저전력 모드 OFF 권장** (저전력 모드에서는 BG fetch / region wake 빈도가 크게 떨어짐)

본 앱은 §1 정책상 `Always` 동의를 강제하지 않으므로 이 entitlement 체인을 통과할 길이 없다.

---

## 3. 한계 + 트레이드오프 (가정상 Always를 얻었다고 했을 때)

| 항목 | 값 / 비고 |
| --- | --- |
| 동시 monitor region 개수 | **앱당 최대 20개** (Apple hard limit) |
| 최소 region 반경 | 권장 **100 m 이상** (그 이하는 GPS 노이즈로 false trigger) |
| 활성화 지연 | 등록 후 첫 evaluation까지 **수십 초 ~ 수 분**. 재부팅 직후 약 3분 latency 보고 사례 있음 |
| 정확도 | iOS WiFi/cell 기반 추정 — 지하/실내에서는 신뢰도 급락. KRRI 등 자체 핑거프린팅 연구가 별도 존재할 정도로 표준 API 한계 명확 |
| 강제 종료 후 wake | iOS 8+ 한정으로 1회는 가능 (위 §1.4) — 단 Always 전제 |
| BG App Refresh OFF | wake 자체 불가 |
| 저전력 모드 | wake 빈도 감소, 신뢰도 하락 |

---

## 4. 우리 앱 활용 시나리오 (이론 검토)

> 본 절은 *만약 정책을 바꿔 Always를 허용한다면*의 가정 시나리오. 현재 정책상 채택 불가지만 참고용 기록.

### 4.1 528개 역 중 어떤 subset을 동적으로 monitor 할 것인가?

- 528개 전체는 20개 region 한계로 불가.
- BoardingLock 활성 시 trip 경로상의 **다음 N개 역만** monitor → trip 진행에 따라 swap.
  - 후보 N = 5~10 (환승 직전 후/후행 역 우선)
  - swap 정책: 사용자가 region 진입 → 다음 N+1번째 region 추가, 가장 멀어진 region 해제
- 환승역에서는 환승 이후 노선 첫 역 region을 한 사이클 일찍 등록해 entry latency 흡수.

### 4.2 silent push 대체 가능성

- Silent push 미도달 환경(지하 깊은 곳, 비행기 모드)에서도 **iOS 내장 WiFi 위치 추정**이 도달하면 region entry 발사 가능 → 매력적.
- 그러나 한국 지하철 지하 구간의 Apple WiFi BSSID DB 커버리지가 미지수 (#563 본 측정 항목 중 하나였으나 PoC 진입 자체가 거부되어 실측 불가).
- 보조 채널로 좋았겠으나 *권한 비용*이 메인 채널보다 비싸서 채널 1/2 동등 비중 격상은 부적합.

---

## 5. 구현 비용 + 위험

| 항목 | 비용/위험 |
| --- | --- |
| 새 Adapter (`RegionPort`) | iOS only, expo-location SDK 호출 wrapper. 인터페이스 자체는 가볍지만 **Always 권한 prompt UX**가 필수로 따라오며 거부 시 silent degrade 처리 필요 |
| 기존 expo-location BG tracking과 공존 | 가능. CoreLocation은 동일 매니저로 region/significant-location/standard 세 가지 동시 운용 OK. 단 Always 권한이 동시에 만족되어야 함 |
| 배터리 영향 | region monitoring 자체는 매우 저전력 (WiFi/cell 기반). 표준 BG location tracking과 비교하면 1/10 이하. 단 region swap이 빈번하면 cell radio wake 증가 |
| 정책 위반 위험 | **최대 위험.** Always 권한 강제 = 본 앱 권한 정책(`feedback_whileinuse_must_work.md`) 위반. 다수 사용자가 "사용하는 동안"을 선택하므로 Always 미동의 사용자에게는 채널 3 = 무의미 |

---

## 6. 권장 다음 단계

**채널 3 (Region Monitoring) 폐기 유지.** 사유는 §2 + §5의 권한 비용. 본 PoC는 종결 처리.

대안 (이미 시행 중):
- **BoardingLock + Local Notification 사전 예약** (#584/#585/#586) — OS 스케줄러에 직접 알람을 예약해 네트워크/푸시 채널 도달과 무관하게 발사. WhileInUse + 저전력 + 지하 약신호까지 커버.
- **채널 1 (Silent push)** — reschedule 정정 역할로 재정의. 도달 시 BoardingLock의 예약 시각을 갱신.
- **채널 2 (Alert push)** — 사후 fallback 유지.

만약 향후 정책이 Always 허용으로 바뀐다면(예: "지하 알람을 절대 놓치고 싶지 않은 사용자" 전용 opt-in 토글) 다음 acceptance criteria로 sub-issue를 재개한다:

- [ ] `src/shared/ports/RegionPort.ts` — `register(regions: Region[])` / `unregister(ids: string[])` / `onEnter(handler)` / `onExit(handler)` 인터페이스 정의
- [ ] `src/shared/infra/location/ExpoRegionAdapter.ts` — expo-location wrapper, Always 권한 미보유 시 명시적 `PermissionError` throw
- [ ] BoardingLock 활성 시 trip 다음 N개 역 region 동적 swap 로직 + 단위 테스트 (20개 한계 가드 포함)
- [ ] 실기기 측정: 지하 구간 entry latency P50/P90, force quit 후 wake 성공률, 환승 swap 공백 시간
- [ ] Always 미동의 사용자에게 silent degrade(채널 3 비활성, BoardingLock 사전 예약만으로 동작) UX 검증
- [ ] 설정 화면 opt-in 토글 + 권한 안내 문구

옵션이 다시 열릴 때까지는 **본 문서를 결정 기록으로 보존**.

---

## 출처

- Apple Developer — [Monitoring the user's proximity to geographic regions](https://developer.apple.com/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions)
- Apple Developer — [Handling location updates in the background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)
- Apple Developer Library (archived) — [Region Monitoring and iBeacon](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/LocationAwarenessPG/RegionMonitoring/RegionMonitoring.html)
- Apple Developer Forums — [Does region monitoring still work after force quit?](https://developer.apple.com/forums/thread/79465)
- Twocanoes Software — [iOS Region Monitoring after iPhone Restart](https://twocanoes.com/ios-region-monitoring-after-iphone-restart/)
- 내부 1차 PoC 결과 — `tasks/region-monitoring-poc-result.md` (#563 실기기 측정)
- 내부 계획 — `tasks/bg-alarm-multi-channel-plan.md` §"채널 3 폐기 (2026-05-28)"
