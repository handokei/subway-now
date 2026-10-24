# 02. 현재 역 인식

## 책임
사용자가 지금 어느 역에 있는지 결정하고, 다른 모든 도메인에 단일한 **현재 역** 값을 제공한다.

## 경계
- 결정된 현재 역을 어떻게 표시할지는 UI 책임.
- 현재 역을 기반으로 알람/알림을 트리거하는 건 각 도메인 책임.

---

## 기본 동작

- 사용자는 앱을 열면 자동으로 가장 가까운 역이 현재 역으로 결정될 수 있다.
- 사용자는 GPS 좌표·기압·WiFi 식별자 등 여러 **위치 신호**가 결합된 **신호 융합** 결과로 현재 역을 결정받을 수 있다.
- 사용자는 자동 결정이 잘못된 경우 **수동 지정**으로 현재 역을 덮어쓸 수 있다.
- 사용자는 수동 지정한 현재 역이 자동 결정보다 우선 적용됨을 보장받는다.
- 사용자는 지하/터널 구간에서 GPS가 약해져도 다른 신호로 현재 역이 유지될 수 있다. ⚠️ 미구현 (ADR-008 / Epic #912 진행 중)
- 사용자는 홈 화면에서 **아래로 당기는 제스처(pull-to-refresh)**로 현재 역·도착 정보를 즉시 새로고침할 수 있다. ⚠️ 미구현

## 예외 / 경계 조건

- 사용자는 모든 위치 신호가 끊긴 상태에서는 **마지막으로 결정된 현재 역**을 유지받는다. (stale 표시 없이 — 잠시간은 정상)
- 사용자는 위치 신호가 30초 이상 갱신되지 않으면 **stale 표시**(예: "1분 전")를 받을 수 있다.
- 사용자는 위치 권한을 거부한 경우 자동 결정 없이 **수동 지정 전용 모드**로 진입할 수 있다.
- 사용자는 역 반경 500m 밖에 있으면 현재 역이 결정되지 않고 "역 근처가 아닙니다" 안내를 받는다.
- 사용자는 현재 역이 안정된 후에만 변경됨을 보장받는다. **Sticky Lock**: 정확도 ≤50m·속도 ≤1m/s의 좋은 fix가 동일 역에서 3회 연속(FG 2s 폴링 기준 ~6초) 관측될 때만 lock 진입. 1km 이동/모션 감지/TTL 30분/더 좋은 fix로 unlock. 잦은 깜빡임 방지, 정합성 우선.

---

## 횡단 의존

- **개인정보**: 위치 좌표는 backend로 전송되며 60초 ring buffer 외에는 영속 저장되지 않는다. (→ [12-cross-cutting.md](./12-cross-cutting.md))
- **에너지**: 위치 신호 폴링 주기는 에너지 정책에 따라 동적으로 조절될 수 있다. (→ [11-background.md](./11-background.md))

## 코드 진입점

- 자동 결정 (융합): `src/features/nearest-station/hooks/useFusedNearestStation.ts`
- Sticky Lock 게이트: `src/features/nearest-station/utils/stickyStationGates.ts`
- Sticky Lock 훅: `src/features/nearest-station/hooks/useStickyStation.ts`
- 정적 판정: `src/features/nearest-station/utils/positionStaticDetector.ts`
- 모션 신호 (iOS CMMotionActivity): `src/shared/utils/motionActivity.ts`
- 기압계 (지하 진입 감지): `src/shared/hooks/useBarometer.ts`, `src/shared/utils/barometerSubsurface.ts`
- 가속도 요약 (1초 윈도우): `src/shared/utils/accelMotion.ts`
- 수동 지정: `src/features/destination/store/useDestinationStore.ts:137` `setCustomOrigin()`
- 거리 계산: `src/shared/utils/haversine.ts`
- 역 데이터: `src/data/stations.json` (528개 역)

## 알려진 한계

- ⚠️ 지하 구간 100% 현재 역 유지 — 기압계/Sticky/Phase 3 fusion은 부분 구현. Epic #912에서 통합 진행 중.
- ⚠️ 환승역(여러 노선이 겹치는 좌표)에서 노선별 구분이 명확하지 않음.
- ⚠️ pull-to-refresh 미구현. ScrollView·refetch 함수는 이미 존재(공수 30분~1시간 추정).
