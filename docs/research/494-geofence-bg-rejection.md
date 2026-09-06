---
issue: 494
title: "Geofence/Region monitoring — 지하 오프라인 BG 알림 보완 (폐기 결정)"
created: 2026-06-11
status: rejected
related:
  - docs/research/563-region-monitoring-poc.md
  - tasks/region-monitoring-poc-result.md
  - "#563"
  - "#918"
---

# Geofence/Region monitoring — 폐기 결정

> **결론 (TL;DR)** — #494는 iOS Region Monitoring(geofence)으로 지하 구간의 silent push 미도달을 보완하려는 feat 이슈. #563 PoC(`docs/research/563-region-monitoring-poc.md`) 및 2026-05-28 실기기 PoC(`tasks/region-monitoring-poc-result.md`) 결과 iOS Region Monitoring API는 `authorizedAlways` 권한을 SDK/플랫폼 레벨에서 강제하므로 본 앱의 `WhileInUse` 1차 정책과 충돌. **폐기 유지.** 같은 사용 사례(지하 오프라인 BG 알림)는 silent push + #918 OS 사전 예약 매역(BoardingLock + Local Notification) 조합으로 이미 충족.

본 문서는 #494를 정식 close 처리하기 위한 결정 기록이다. #494 본문은 #478 silent push 미도달 보완을 목표로 `startGeofencingAsync`를 검토했으나, 그 전제(권한)부터 본 앱 정책에 위배됨이 확정되었다.

---

## 1. 폐기 결정 요약

| 항목 | 내용 |
| --- | --- |
| 차단 사유 | iOS Region Monitoring API(`CLLocationManager.startMonitoring(for:)`, `CLMonitor.add`, `expo-location.startGeofencingAsync`) 모두 `authorizedAlways` 강제 |
| 정책 충돌 | `feedback_whileinuse_must_work.md` — 1차 시나리오 "사용하는 동안" 권한에서 모든 핵심 기능 정상 동작 필요. Always 미동의 사용자에게 region 채널 = 무의미 |
| PoC 직접 관측 | 실기기에서 `Location.startGeofencingAsync()` 호출이 *"Background location permission is required"* 오류로 즉시 실패 |
| #494 원문 가정 오류 | "'사용 중' 권한으로도 진입 시 1회 wake 보장 (Apple)" — Apple 공식 문서 + PoC 결과 모두 **`WhileInUse`에서는 region monitoring 등록 자체가 거부**됨을 확인 |

#494 원문에 적힌 사전 조건(#478 운영 관찰 1~2주)도 결과적으로 무관 — 권한 요건이 본질적 차단이므로 운영 관찰 결과와 독립적으로 진행 불가.

---

## 2. #563 PoC 결론 참조

본 결정의 1차 근거 문서:

- [docs/research/563-region-monitoring-poc.md](./563-region-monitoring-poc.md) — Apple 공식 문서 + 실기기 PoC를 정리한 결정 보고서
  - §1 권한 요구사항 — `CLLocationManager`/`CLMonitor`/`expo-location` 세 경로 모두 `Always` 강제
  - §2 BG wake 트리거 — `WhileInUse`에서 entry/exit 이벤트 발사 안 됨
  - §3 한계 — region 20개 한도, 100m 미만 false trigger, 활성화 지연 수십초~수분, 지하 신뢰도 급락
  - §4 활용 시나리오 (가정상 Always 허용 시) — trip 경로 N개 region 동적 swap 검토
  - §5 정책 위반 위험 — 최대 위험으로 표시
  - §6 권장 다음 단계 — 폐기 유지 + 대안 명시
- [tasks/region-monitoring-poc-result.md](../../tasks/region-monitoring-poc-result.md) — 2026-05-28 실기기 PoC raw 결과

---

## 3. 대안 — 이미 시행 중

#494의 사용 사례("silent push 못 닿으면 알림 zero"인 지하/오프라인 구간 BG 알림)는 현재 채택된 아래 조합으로 충족된다.

| 채널 | 역할 | 네트워크 의존 | 지하 동작 |
| --- | --- | --- | --- |
| **OS 사전 예약 매역** (#918, BoardingLock + Local Notification) | 메인 발화원 — 트립 시작 시 다음 N개 역 도착 시각을 OS 스케줄러에 사전 예약 | **No** (예약 후 오프라인 동작) | ✅ 지하 약신호/오프라인에서도 정시 발사 |
| **Silent push** (#478) | 정정 채널 — 도달 시 예약 시각 갱신 + reschedule | Yes | 도달 시 정확도 ↑, 미도달 시 예약값으로 fallback |
| **Alert push** | 사후 fallback | Yes | 미도달 허용 |

핵심: 매역 알림이 **OS 스케줄러에 사전 예약된 Local Notification**이므로 silent push가 못 닿는 지하 구간에서도 발사된다 — 이는 #494가 region monitoring으로 달성하려던 "네트워크 불필요한 BG wake"를 권한 비용 없이 제공한다. 부정확성은 silent push 정정으로 보정.

자세한 채널 구조는 `tasks/bg-alarm-multi-channel-plan.md` 및 `project_alarm_sla_architecture.md` 메모리 참조.

---

## 4. 정책 변경 시 재개 acceptance criteria

만약 향후 "지하 알람을 절대 놓치고 싶지 않은 사용자" 전용 opt-in 토글로 Always 권한을 한정 허용하는 정책 변경이 발생한다면, 다음 기준을 만족할 때 본 결정을 뒤집을 수 있다 (#563 §6 acceptance 와 일치).

- [ ] 설정 화면에 **명시적 opt-in 토글** + Always 권한 안내 문구 (기본 OFF)
- [ ] `src/shared/ports/RegionPort.ts` — `register(regions: Region[])` / `unregister(ids: string[])` / `onEnter(handler)` / `onExit(handler)` 인터페이스 정의
- [ ] `src/shared/infra/location/ExpoRegionAdapter.ts` — expo-location wrapper. Always 권한 미보유 시 명시적 `PermissionError` throw + silent degrade (BoardingLock 사전 예약만으로 동작)
- [ ] BoardingLock 활성 시 trip 다음 N개 역 region 동적 swap 로직 + 단위 테스트 (iOS 20개 한계 가드 포함)
- [ ] 실기기 측정 — 지하 구간 entry latency P50/P90, force quit 후 wake 성공률, 환승 swap 공백 시간
- [ ] Always 미동의 사용자에게 silent degrade UX 검증 (토글 OFF 사용자가 차별 없이 매역 알림을 받는지)
- [ ] #918 OS 사전 예약 매역과의 **dedup** — 같은 `alarmKey`로 중복 발화 0건

위 기준은 모두 충족되어야 하며, 부분 충족 시 본 결정 유지.

---

## 출처

- [docs/research/563-region-monitoring-poc.md](./563-region-monitoring-poc.md)
- [tasks/region-monitoring-poc-result.md](../../tasks/region-monitoring-poc-result.md)
- 내부 정책 — `feedback_whileinuse_must_work.md` (1차 권한 시나리오 WhileInUse)
- 관련 이슈 — #478 (silent push 도입), #918 (OS 사전 예약 매역), #584/#585/#586 (BoardingLock + Local Notification 사전 예약 epic)
