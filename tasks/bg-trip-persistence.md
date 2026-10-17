# BG에서 trip 사라짐 — 진단 트랙

작성: 2026-05-27. 실기기 회귀 발견 (출퇴근 trip).

## 증상

- 앱에서 출발/도착 설정 → trip 활성화
- 백그라운드 진입 (홈 / 잠금 / 다른 앱)
- 일정 시간 후 앱 복귀 → **trip이 사라져 있음** (destination=null, route 초기화)
- 결과: silent push 조건 미충족, 알람 미발화, Live Activity 종료

## 영향

**가장 큰 단일 회귀**. trip이 살아있어야:
- silent push 발사 조건 (#506)
- BG 알람 (#506, #494)
- Live Activity 유지 (#534)
- 정확한 도착시각 추적

모두 trip 의존이라 본 이슈가 우선.

## 가능한 원인 (코드 동선)

### A. iOS BG task 종료
- iOS는 BG 앱을 메모리 압박 시 종료. trip 상태가 메모리에만 있다면 손실.
- 대응: trip을 AsyncStorage로 persist + FG 복귀 시 복원

### B. Zustand store 휘발성
- `src/store/useAppStore.ts`의 `destination` 필드가 persist 설정 누락?
- `destinationPersist` middleware가 있다면 검증 필요

### C. 도착 감지 false positive로 자동 해제
- `app/(tabs)/index.tsx`의 arrivedBanner 로직이 BG에서 잘못 발화 →
  `setDestination(null)` 호출 → trip 해제
- 위치가 destination 근처 0.5km 안 들어왔는데 발화하는지 확인

### D. AppState 'background' 핸들러에서 cleanup
- AppState 리스너 어딘가에서 trip 정리하는 코드가 있을 가능성
- grep으로 destination=null 설정 위치 전부 확인 필요

### E. useApnsTripRegistration 또는 silentPushTask에서 trip 만료 로직
- 백엔드 trip 등록이 만료되면 클라가 자동 해제하는지 검토

## 진단 단계

- [ ] **1. Zustand persist 확인**: `useAppStore`의 destination이 AsyncStorage로 영속화되는지
- [ ] **2. setDestination(null) 호출처 그렙**: 어디서 trip 해제하는지 전수 조사
- [ ] **3. AppState 'background' 리스너 확인**: BG 진입 시 cleanup 로직 있는지
- [ ] **4. DebugModal로 BG 진입 전후 비교**:
  - trip 시작 직후 dump (activeTrip 등록 확인)
  - BG 진입 후 1분, 5분, 10분 시점 dump
  - FG 복귀 후 dump
- [ ] **5. 알람로그에서 trip 해제 시각 추적**: setDestination 호출 로그 추가 필요할 수도

## 진단 결과별 후속 액션

| 원인 | 액션 |
|---|---|
| Zustand persist 누락 | `persist` middleware 추가 |
| 도착 false positive | arrivedBanner 발화 조건 강화 (GPS accuracy + 시간 필터) |
| AppState 핸들러 cleanup | 의도된 동작인지 확인 후 제거 |
| iOS BG 종료 | persist 추가 + FG 복귀 시 복원 |

## 관련

- #506 silent push 검증 — 본 이슈 해결 후 가능
- #494 region monitoring — BG 알람 보강
- subway_now_506_silent_push_diag.md (이전 진단 메모리)

## 작업

1. 본 이슈를 GitHub Issue로 등록 (label: `fix`, `bug`)
2. 진단 1~4 단계 결과 → 이슈 코멘트
3. fix PR 별도 브랜치 (`fix/#<번호>-bg-trip-persistence`)
