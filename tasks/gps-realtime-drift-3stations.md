# 실시간 GPS 위치가 실제 위치 대비 약 3개 역 차이 — 진단 트랙

작성: 2026-05-27. 실기기 회귀 발견 (출퇴근 trip).

## 증상

- 사용자 실제 위치와 앱이 추정한 "현재 역"이 **약 3개 역 차이**
- 예: 실제 군자역 통과 중 → 앱은 "용마산" 표시
- 이동 중에도 갱신이 느려서 사용자가 실제로 도착할 때쯤 비로소 갱신

## 가능한 원인

### A. BG GPS 미동작 + 캐시된 stale 위치 표시
- `useFusedNearestStation`이 BG 시간 동안 캐시 위치 유지
- FG 복귀 시 즉시 fresh fix 요청 (`refreshRef.current()`) 하지만 새 fix까지 수~수십초
- 그 사이 stale 위치로 표시
- 관련: `app/(tabs)/index.tsx:189-201` AppState 'active' 리스너

### B. WhileInUse 권한 환경
- "Always" 권한 없으면 BG GPS 안 돔 → 이동 거리만큼 위치 갱신 지연
- `feedback_location_permission_scope.md` (memory): "Always 전제 금지", 사용자 다수가 WhileInUse

### C. Fusion이 train data로 잘못 단정
- `useFusedNearestStation`의 train fusion 로직이 환승역/병행 노선에서 오인
- service-gap-plan.md §2.7 보류 결정 — trip 없을 때 train fusion 약하게 가도록

### D. expo-location 정확도 설정
- `MAX_ACCURACY_M_DISPLAY=250m`가 운영 환경에서 너무 관대
- #447 (콜드스타트 GPS 신뢰 정책) 트랙과 직결

### E. 지하 구간 무선 끊김
- 터널/지하역에서 GPS/WiFi/cell triangulation 모두 약함
- iOS가 stale 위치 반환 → 앱이 그걸 그대로 사용

## 진단 단계

- [ ] **1. 권한 설정 확인**: 실기기 위치 권한이 "사용 중" vs "Always"
- [ ] **2. DebugModal에서 GPS accuracy + last update time 확인**:
  - trip 중 GPS 응답 freq
  - accuracy 분포 (3역 차이 시점에 accuracy 값)
- [ ] **3. AlarmLog의 위치 fix 시각 추적**
- [ ] **4. 환승역/병행 노선 케이스 vs 단일 노선 케이스 비교**:
  - fusion 영향이면 환승역에서 더 심함

## 진단 결과별 후속 액션

| 원인 | 액션 |
|---|---|
| WhileInUse + BG GPS 부재 | "Always" upgrade UX (trip 시작 시) — service-gap-plan 4. |
| Stale 캐시 표시 | FG 복귀 시 stale 위치 명시적 invalidate |
| MAX_ACCURACY 관대 | #447 트랙에서 임계값 튜닝 |
| Fusion 오인 | trip 활성화 시 train fusion 비활성화 (이미 jump gate 일부 처리) |

## 관련

- #447 (콜드스타트/저정확도 GPS 신뢰 정책 재검토)
- #494 (region monitoring/geofence) — 정확한 wake-up 보완
- service-gap-plan §2.1 (GPS jump gate) — 이미 머지된 PR #528 보강

## 작업

- GitHub Issue 등록 (label: `fix`, `bug`)
- 실기기 alarmLog 1-2주 수집 후 분포 분석 (#447 트랙과 통합)
