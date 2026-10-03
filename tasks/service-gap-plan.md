# subway-now 서비스 갭 분석 및 실행 계획

작성일: 2026-05-26
대화 컨텍스트: 21:29 효창공원앞↔신내 GPS 텔레포트 사고 진단 후, "카카오/네이버 수준의 지하철 안내" 목표 대비 현 상태 점검

---

## 0. 목표 — 사용자가 원하는 서비스 (여정 순)

1. 앱 실행 → 현재 위치/현재역 표시 (지상·지하 모두)
2. 출발/도착 입력 → 경로(환승 포함) 탐색
3. "안내 시작" → 트립 활성화
4. FG에서 현재역이 매끄럽게 갱신 (텔레포트 없음)
5. FG 알람: 역 통과 / 환승 안내 / 도착 임박
6. BG(잠금화면, 다른 앱 사용 중)에서 알람 발화
7. BG 실시간 현황 UI — 잠금화면/Dynamic Island Live Activity
8. 강제종료 상태에서도 알람 도달
9. 출처/신뢰도가 화면에 자백 (지하·정지·부정확 시 오인 방지)
10. 막차 알림 등 시간 기반 안내

---

## 1. 현재 상태 평가

| # | 항목 | 동작 | 결함 | 근거 |
|---|---|---|---|---|
| 1 | 현재역 표시 | ⚠️ | jump gate 부재 | `useNearestStation.ts:68-106` accuracy 게이트만 존재 |
| 2 | 경로 탐색 | ✅ | — | `stationRoute.ts` `findRoute` |
| 3 | 트립 활성화 | ✅ | — | activeTrip 토큰 정상 전환 확인 (txt1 → txt2) |
| 4 | FG 현재역 안정화 | ⚠️ | route 없을 때 GPS-only fallback | `useFusedNearestStation.ts:283-287` |
| 5 | FG 알람 | ⚠️ | false-positive (21:29:23 신내) | alarm log |
| 6 | BG 알람 | ⚠️ | GPS-only fusion, train data 미사용 | `backgroundLocationTask.ts` → `stationPipeline.ts` 의 import에 positionApi/arrivalApi 없음 |
| 7 | BG Live Activity | ⚠️ | 인프라 진행 중 | #506, memory `subway_now_bg_alarm_infra.md` |
| 8 | 강제종료 BG 알림 | ❌ | silent push만 의존 | #493, #478 OPEN |
| 9 | uncertainty UI | ❌ | 미구현 | #327, #475 OPEN |
| 10 | 막차 알림 | ❌ | 미구현 | #474 OPEN |

### 21:29 사고가 노출한 3중 갭

1. **#1·#6 GPS jump gate 부재** → 효창공원앞↔신내 25km/8s 텔레포트 좌표 수용
2. **#4 fusion fallback** → trip/route 미설정 시 position-train 비활성, GPS 잡음 그대로 표시
3. **#9 uncertainty UI 부재** → 사용자가 의심할 단서 없이 false-positive 알람을 100% 신뢰

---

## 2. 갭별 실행 계획

### 2.1 GPS jump gate (Phase A · #1·#5·#6 동시 해결)

**무엇**: 이전 fix 대비 거리·시간으로 물리적으로 불가능한 좌표를 drop.

**파일**
- 새 헬퍼: `src/utils/locationGates.ts` 에 `isPlausibleJump(prev, curr): boolean`
- 적용 1: `src/hooks/useNearestStation.ts:68-106` `applyLocation` — accuracy 게이트 다음. 실패 시 `setLocationUncertain(true)` 후 early return
- 적용 2: `src/tasks/backgroundLocationTask.ts:31-43` age/accuracy 게이트 옆
- 적용 3: `src/utils/stationPipeline.ts` 진입부 (BG·silent push 공통 입구 방어)

**임계값**
- 속도: `> 50 m/s` (지하철 최고 ~22 m/s + 안전마진)
- 짧은 Δt 보강: `Δt < 5s && Δ > 500m`
- 첫 fix / prev null 시 통과

**테스트**: `__tests__/locationGates.test.ts` — 정상/25km 점프/정지 노이즈/콜드스타트 4 케이스

**리스크**: 낮음 — 단일 게이트, fallback은 기존 `locationUncertain` UX 재사용

**공수**: 1 PR, 반나절. **ROI 1위.**

---

### 2.2 uncertainty UI (Phase B · #327, #475)

**무엇**: 카카오/네이버 패턴 — 정확도/출처를 FG·BG·잠금화면 모든 표면에 자백.

**현황 (2026-05-26 dev 기준)**
- `useFusedNearestStation`이 이미 `source`/`confidence`/`locationUncertain`/`accuracyMeters` 노출
- 홈은 `__DEV__` 한정 텍스트(`testID="home-fusion-source-badge"`)만 — 프로덕션 사용자 노출 0
- 지도는 react-native-maps 네이티브 전환 완료 (`buildMapConfig.ts`) — Circle 컴포넌트로 1줄 추가 가능
- Live Activity `SubwayActivityAttributes.swift`에 source 필드 없음
- 알람 본문(`stationNotification.ts` `buildAlarmContent`/`sendAlarmNotification`/`sendStationPassedNotification`)에 source 인자 없음
- `silentPushLocationGate.ts`는 이미 `locationSource: GateLocationSource` 추적 중 → 재활용

**i18n 키 (3 PR 공용)**
- `source.positionTrain`: "열차 데이터"
- `source.routeProgress`: "경로 추정"
- `source.gpsOnly`: "GPS 추정"
- `source.uncertain`: "위치 확인 중"

**PR 1 — 홈 source 배지 (#327)**
- 신규 `src/components/SourceBadge.tsx`
- `app/(tabs)/index.tsx:375-385` `__DEV__` 텍스트를 프로덕션 배지로 승격 (디버그 `source·confidence` 텍스트는 `__DEV__` 안에 별도 유지)
- locationUncertain일 때 배지 라벨 "위치 확인 중"으로 오버라이드
- 공수: 반나절

**PR 2 — 지도 사용자 정확도 원 (#327)**
- `src/components/StationMap.tsx`에 `react-native-maps`의 `Circle` import
- props에 `accuracyMeters?`, `locationUncertain?` 추가
- 사용자 좌표 위 Circle radius=accuracyMeters, uncertain 시 회색/투명도↓
- `app/(tabs)/map.tsx`에서 `useFusedNearestStation` 값 전달
- `StationMap.web.tsx`는 props 미러만
- 공수: 반나절 (네이티브 전환 덕)

**PR 3 — BG·잠금화면·푸시 본문 source 라벨 (#475 + 알람 보강)**

LA/위젯:
- `targets/subway-widget/_shared/SubwayActivityAttributes.swift` `source: String` 추가
- `modules/live-activity` start/update payload 확장
- `SubwayLiveActivityWidget.swift` + `SubwayWidget.swift` 라벨 표시
- `src/utils/widgetStorage.ts` App Groups 스키마 확장

알람 본문 (보강 — BG 자백 핵심):
- `stationNotification.ts` 3 함수에 `source?: NotificationSource` 추가 (`'position-train'|'route-progress'|'gps'|'uncertain'`). undefined면 라벨 생략(기존 caller 회귀 최소화)
- body 끝에 `· ${t('source.' + key)}` 부착 (`appendQuickHint` 패턴 재사용)
- `src/utils/stationPipeline.ts` `ProcessLocationInputs`에 `fusionSource?`, `locationUncertain?` 추가 → notificationSource 결정 후 전파
- `src/tasks/backgroundLocationTask.ts`: `fusionSource: 'gps'` 명시 (BG가 GPS-only라는 사실 자백)
- `src/tasks/silentPushTask.ts`: `gate.locationSource` → notificationSource 매핑. payload 경로 = `'position-train'`(서버 train data 기반), GPS gate 경로 = `'gps'`

리스크:
- 알람 본문 길이 증가 → iOS 푸시 잘림. 라벨 최대 6자 유지
- caller 시그니처 변경 — optional이라 점진 적용
- 네이티브 빌드 필요 — dev build 실기기 회귀 1회

공수: 1.5~2일

**총 공수**: 2.5~3일 (원안 3일 유지, 분배만 변경 — 지도 단순화 ↔ 알람 보강 추가)

---

### 2.3 silent push 도달 검증 (Phase A · #506)

**무엇**: 인프라는 memory상 1·2 해결. 남은 건 실제 trip에서 도달 카운트 확인.

**파일**: 코드 변경 0. `src/tasks/silentPushTask.ts:handleSilentPush`의 `lastReceived` 카운터를 다음 trip에서 캡처.

**검증 절차**
1. 실기기에서 trip 시작
2. 한 사이클 후 DebugModal 캡처
3. `Silent Push > lastReceived != (never)` 확인
4. 안 잡히면 #339 통합 검증 트랙으로 escalation

**리스크**: 코드 0, 사용자 수동 검증 필요

**공수**: 다음 출퇴근 1회

---

### 2.4 Region monitoring / Geofence (Phase C · #494)

**무엇**: 강제종료/딥슬립 상태에서도 OS가 역 진입 시 앱을 깨움.

**접근**
- `expo-location.startGeofencingAsync` + `TaskManager.defineTask` 결합
- 트립 시작 시 `route.stations` 중 다음 N개(예: 5개)에 `CLCircularRegion(radius=150m)` 등록
- 진입 task → `stationPipeline.processLocationUpdate({source:'geofence'})`로 라우팅
- 트립 종료/역 통과 시 region 해제 + 다음 N개로 이동창 갱신

**리스크**: 높음
- iOS region 동시 등록 한도 20개
- 권한 "Always" 필요 — memory `feedback_location_permission_scope.md` 룰("Always 전제 금지")과 충돌
- 완화: trip 시작 시점에만 "Always" upgrade 권유, 평소엔 "사용 중" 유지

**공수**: 1주 내외 (권한 UX 포함)

---

### 2.5 silent push → alert push 전환 (Phase C · #493)

**무엇**: 강제종료에서 silent는 OS가 안 깨움 → alert(content-available 0)로 직접 표시.

**파일**
- 서버 측 페이로드: `apns-priority: 10`, `alert` 본문 포함
- 클라: `handleSilentPush`의 `scheduleNotificationAsync` 우회 (OS가 직접 표시). `lastFired` 마킹 경로만 보전

**리스크**: 중간 — trip 외 alert 노출 위험. **반드시 #496(정지 사용자 push 차단)과 함께** 진행

**공수**: 서버 PR 1 + 클라 PR 1

---

### 2.6 정지 사용자 push 차단 (Phase C · #496)

**무엇**: 서버가 progress 인지 → 정지 시 push 발사 skip

**파일**: 백엔드 트랙 (이 레포 밖)

**리스크**: 백엔드 의존, 본 레포 단독 해결 불가

**공수**: 백엔드 1주

---

### 2.7 trip 없이도 fusion 효과 (보류)

**검토 결과: 보류**

- jump gate(2.1)만으로 21:29 사고는 차단됨
- trip 없을 때 train data로 단정 → 환승역/병행 노선에서 새 오인 위험
- 대신 trip 설정 UX를 친절하게 (권유 배너) 해서 자연스럽게 trip 켜도록 유도

---

### 2.8 작은 fix들

| 이슈 | 무엇 | 파일 | 공수 |
|---|---|---|---|
| #517 | Mock arrival 상행/하행 동일 | `src/providers/MockProvider.ts` | 반시간 |
| #447 | 콜드스타트 lastKnown 정책 재검토 | `useNearestStation.ts:144-164` | jump gate 후 재평가 |
| #411 | 사전 예약 stopgap 제거 | — | #506 안정화 후 |
| #410 | PR #402/#407 실기기 회귀 | — | 수동 |

---

### 2.9 큰 트랙 (별도 페이즈)

- **#474 막차 알림** — 시간표 API ETL + 스케줄러. 1~2주
- **#473 전체 시간표 ETL Option B** — 상세 플랜은 §5 참고. #474·#517 동시 해소
- **#79 OAuth** — 다중기기 trip 동기화 필요시

---

## 5. 시간표 ETL 도입 플랜 (#473) — 후속 트랙

작성: 2026-05-26. Phase A·B 완료 후 진행. 연관: #473, #474, #517.

### 5.1 배경

- 실시간 도착 API(`fetchArrivalInfo`)는 정상. 실패 시 `scheduleFallback.buildScheduleArrival`이 헤드웨이만으로 다음 2편 추정
- 상하행 동일값 출력(#517) + 디버그 패널 `(MOCK)` 라벨
- 막차 알림(#474)은 시간표 부재가 근본 원인
- fallback을 헤드웨이 → 실제 시간표로 교체하면 #517·#474 함께 해소

### 5.2 의사결정 (확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 데이터 소스 | **번들 내장** | 지하 오프라인 동작 핵심. CDN 인프라/캐시 복잡도 회피 |
| 데이터 분할 | **노선별 파일** | `await import('./timetables/line-${n}.json')` 동적 로딩 |
| 갱신 주기 | **수동 (분기별)** | 서울교통공사 개정 빈도 낮음. YAGNI |
| ETL 책임자 | **개정 발생 시 PR** | 자동화는 첫 운영 사이클 후 검토 |
| Remote override | **v1 미포함** | 향후 필요 시 추가 |

예상 크기: 528역 × 3요일 × 2방향 × ~250편/일 = ~80만 엔트리 → minify + 노선 분할 + gzip = **5~8 MB**

### 5.3 Phase별 작업

| Phase | 내용 | 산출물 | 공수 |
|---|---|---|---|
| 1 — 소싱·스키마 | 서울 API `SearchSTNTimeTableByFRCodeService` 검증, `stnId` 매핑, 1노선 prefetch로 크기 실측 | API 샘플, 매핑 초안, 크기 측정 | 반나절~1일 |
| 2 — ETL 스크립트 | `scripts/fetch-timetables.js`(rate limit, 재시도, idempotent) + `scripts/validate-timetables.js` | 노선별 JSON, 검증 스크립트 | 1~2일 |
| 3 — fallback 교체 | `buildScheduleArrival` 동적 import 기반 재작성, `isMock:false` / `source:'timetable'`, `ArrivalSourceNotice` 라벨 분기 조정 | 새 fallback, MOCK 라벨 제거 | 1일 |
| 4 — 테스트 | ETL 단위, fallback lookup(평일/토/일·자정 경계·막차 후), 커버리지 100%, 빌드 크기, RN 동적 import 검증 | 테스트, 크기 보고 | 1~2일 |
| 5 — 운영 | 갱신 정책 문서, PR 템플릿 체크리스트, 무결성 CI 게이트 | 운영 문서, CI 워크플로우 | 반나절 |

데이터 형식 예시:
```json
{
  "weekday":  { "up": ["0530", "0535", ...], "down": [...] },
  "saturday": { "up": [...], "down": [...] },
  "sunday":   { "up": [...], "down": [...] }
}
```

### 5.4 리스크

| 리스크 | 완화책 |
|---|---|
| API rate limit (528역) | 분산 호출 + 지수 백오프 |
| 데이터 크기 부풀림 | minify + 노선별 분할 + gzip 측정 |
| 개정 누락 | PR 템플릿 체크리스트 + CI 무결성 게이트 |
| RN 동적 import 호환성 | Phase 1에서 1노선으로 사전 검증 |
| Scope creep | #473 트랙으로 분리. #517은 본 트랙 완료 시 자동 해소 |

### 5.5 #517 단독 처리

ETL 완료 시 #517 자동 해소 → **별도 PR 불필요**. ETL 일정이 길어지면 임시 stopgap(헤드웨이/2 dir 오프셋, 반시간)을 도입 검토 — 단 MOCK 라벨 유지되어 근본 해결은 아님.

### 5.6 공수·트리거

- 총: **5~7 작업일** (외부 의존 변수로 ±2일)
- 시작 트리거: Phase A·B(GPS 사고 차단 / uncertainty UI) 완료 후

---

## 3. 실행 순서

### Phase A — 이번 주 (1~2일)
- [x] 2.1 GPS jump gate ← #527/PR #528 머지 (2026-05-26)
- [x] 2.8 #517 Mock arrival fix ← PR #537 머지 (2026-05-26)
- [ ] 2.3 #506 silent push 도달 검증 ← **#541 (BG trip 사라짐) 선행 차단** (2026-05-27 실기기 검증)

### Phase B — 이번 달 (1주) ← 진행 중
- [x] PR 1: 홈 source 배지 (#327)
- [x] PR 2: 지도 사용자 정확도 원 (#327)
- [x] PR 3: BG/LA/위젯/알람 본문 source 라벨 (#475 + 알람 보강, PR #533)

### Phase C — 다음 사이클 (1~2주)
- [ ] 2.4 Region monitoring (#494)
- [ ] 2.5 alert push 전환 (#493) + 2.6 정지 차단 (#496) 동기

### Phase D — 사이클 외
- [ ] #474 막차
- [ ] #79 OAuth

---

## 3.1 추가 발견 이슈 (2026-05-27 실기기 회귀)

오늘 새벽까지 진행한 ETL Phase 1+2+3(#473) 머지 후 실기기 회귀에서 발견. 모두 BG/실기기 트랙으로 오늘 PR 범위 밖.

- **#541 BG trip 사라짐** ← **최우선** (silent push/알람/LA 모두 의존). 자세히: `tasks/bg-trip-persistence.md`
- **#542 BG silent push 알람 미발화 (#506 후속)** ← #541 해결 후 재검증. 자세히: `tasks/bg-silent-push-real-trip-result.md`
- **#543 실시간 위치 3역 차이** ← #447과 통합 관리 가능. 자세히: `tasks/gps-realtime-drift-3stations.md`

## 3.2 ETL 트랙 (#473) — 오늘 세션 완료

- [x] Phase 1 — 1호선 ETL + 크기 실측 (PR #538)
- [x] Phase 2 — 2~9호선 ETL (PR #539)
- [x] Phase 3 — buildScheduleArrival 시간표 lookup 재작성 (PR #540)
- [ ] Phase 4-5 — 테스트 보강, CI 무결성 게이트, 운영 문서 (별도 트랙)
- [ ] 분당/신분당/경의중앙/공항 시간표 — 다른 API 사용, 향후 별도 트랙

---

## 4. 의사결정 메모

- **Always 권한**은 trip 시작 시에만 upgrade 권유. 기본은 "사용 중" 유지 (memory `feedback_location_permission_scope.md`)
- **jump gate 임계값**은 운영 alarmLog 1~2주 관찰 후 #495에서 튜닝
- **trip 없을 때 fusion 강화**는 보류 — 환승역 오인 위험 > GPS 안정화 이득
- **막차/OAuth**는 핵심 사고 차단(Phase A·B·C) 끝난 뒤 검토
