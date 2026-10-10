# Plan #1852 — Maestro E2E Feasibility Audit + Chain Validation 자동화 확장 방향 결정

작성: 2026-06-26 | 이슈: #1852 | 선행: #1833 (fixture chain runner), #1834 (머지)

---

## §1 사용자 가치

### device-only 회귀 현황

현재 CI 게이트 구성:
| 게이트 | 담당 | 커버 영역 |
| --- | --- | --- |
| Type Check & Test | CI (ubuntu) | 타입 + unit 100% coverage |
| Data Validation | CI (ubuntu) | stations.json / lineTopology.json 정합성 |
| Backend Validation | CI (ubuntu) | alarm-worker type-check + vitest |
| Orphan Export Detection | CI (ubuntu) | ts-prune dead wire |
| fixture chain runner (#1834) | unit (ubuntu) | 6 chain stage: trip-registered/env-classified/boardingPrompt-displayed/lock-attach/silent-push-received/station-passed-fired |
| Maestro nightly (e2e.yml) | nightly (macos-14) | smoke + gps + regression + permission matrix |

**CI 게이트 = 정적 검증만** (#1335). iOS prebuild / 시뮬레이터 / Maestro는 nightly only, PR 게이트 아님.

**사용자 책임 영역** (device-only, 자동화 불가):
- Live Activity (Dynamic Island / 잠금화면) — APNs 실기기 전용
- Silent Push 수신 신뢰성 — 시뮬레이터 미신뢰 (`.maestro/manual/silent_push.md`)
- 오디오 라우트 (이어폰 연결/분리) — 오디오 세션 시뮬레이터 재현 불가 (`.maestro/manual/audio_route.md`)
- 홈 위젯 갱신 — SpringBoard 접근 불가 (`.maestro/manual/widget_refresh.md`)
- BG 도착 알람 발화 (실제 지하철 탑승 필요) — GPS/모션/기압 실측 불가 (`.maestro/manual/bg_alarm.md`)
- Native crash / Pods 충돌 / expo prebuild drift — 빌드 시점 사용자 확인

**Maestro로 이미 커버 중인 영역** (nightly 시뮬레이터):
- HomeScreen 렌더 + 즐겨찾기 추가/삭제 + 탭 네비게이션 + 목적지 설정 + 취침 모드 (smoke 6개)
- GPS 좌표 dispatch + 역 렌더 (gps 4개)
- 알람 회귀 시나리오 (regression 10개, mock backend 연동)
- 권한 매트릭스 (permission-matrix 13개)
- 기타 scenario 5개

**fixture runner (#1834) vs Maestro 추가 커버 가능 영역**:

| 영역 | fixture runner | Maestro 추가 커버 가능 |
| --- | --- | --- |
| chain 6단 논리 검증 | O (unit) | X (UI 검증으로 대체 가능하나 중복) |
| UI 렌더 (홈, 탭, 즐겨찾기) | X | O (smoke, 이미 구현) |
| GPS dispatch → 역 표시 | X | O (gps, 이미 구현) |
| 알람 회귀 (Seam A~G 등) | X (로직만) | O (mock backend, 이미 구현) |
| 권한 매트릭스 dispatch | X | O (permission-matrix, 이미 구현) |
| Live Activity UI | X | X (실기기 전용) |
| Silent Push 신뢰성 | X | X (시뮬레이터 미신뢰) |
| 홈 위젯 갱신 | X | X (SpringBoard 불가) |
| BG 알람 실기기 발화 | X | X (실 GPS/지하철 필요) |

### 결론: Maestro는 이미 광범위하게 도입되어 있다

"도입 여부 결정"이 아니라 **"현재 nightly-only인 Maestro를 PR 게이트로 올릴 것인가"** 와 **"추가 시나리오 어느 방향으로 확장할 것인가"** 결정이 실질적 질문이다.

---

## §2 현재 State 정밀 감사

### `.maestro/` 구조 (감사 기준: 2026-06-26)

```
.maestro/
├── config.yaml              — appId: com.subwaynow.app, flows: "flows/**/*.yaml"
├── flows/
│   ├── smoke/               — 6개 시나리오 (EXPO_PUBLIC_E2E_MOCK=1 빌드 전제)
│   │   ├── 01_app_launch.yaml
│   │   ├── 02_destination_set_clear.yaml
│   │   ├── 03_tab_navigation.yaml
│   │   ├── 04_favorites_add_remove.yaml
│   │   ├── 05_sleep_mode_toggle.yaml
│   │   └── 06_accessibility_mode_route.yaml
│   ├── gps/                 — 4개 시나리오 (실 GPS mock, nightly only)
│   │   ├── 01_near_station.yaml
│   │   ├── 02_station_change.yaml
│   │   ├── 03_jump_rejection.yaml
│   │   └── 04_no_station_nearby.yaml
│   ├── regression/          — 10개 시나리오 (mock backend 연동)
│   │   ├── seam-b-13-19.yaml … seam-la-refresh-heartbeat.yaml
│   │   ├── a1-auto-lock.yaml, a3-preschedule-fire-delta.yaml
│   │   └── README.md
│   ├── permissions/         — 13개 매트릭스 cell
│   │   ├── always-bg-aboveground-normal-ios18.yaml 등
│   │   └── README.md
│   └── scenario/            — 5개 시나리오
│       ├── 01_alarm_foreground_arrival.yaml
│       ├── 02_alarm_overlay_resume.yaml
│       ├── 03_map_set_destination_auto_switch.yaml
│       ├── 04_map_search_dismisses_keyboard.yaml
│       └── 05_dark_mode_persists.yaml
└── manual/                  — 6개 실기기 전용 문서 (자동화 불가)
    ├── audio_route.md
    ├── bg_alarm.md
    ├── silent_push.md
    ├── trip_lockless_hop_window.yaml    ← Maestro yaml이지만 manual 폴더 (실기기 전용)
    ├── trip_sleep_lockless_station_passed.yaml
    ├── trip_sticky_subsurface.yaml
    ├── trip_transfer_autolock.yaml
    ├── trip_transfer_traincode_sync.yaml
    └── widget_refresh.md
```

### `e2e.yml` 상태 (#1335 이후)

- **PR 게이트 아님** — nightly cron(KST 04:00) + workflow_dispatch 전용
- 3개 job: `e2e` (gps+scenario) / `regression` (10개 시나리오 매트릭스) / `permission-matrix` (13개 cell)
- 각 job: iOS prebuild → CocoaPods → xcodebuild → 시뮬레이터 부팅 → 앱 설치 → Maestro 실행
- DerivedData / Pods 캐시 적용 (build key: Podfile.lock + package-lock.json + modules/** 해시)
- gps/scenario는 `continue-on-error: true` 후 최종 집계 → 트랙별 독립 관찰

### CI 게이트 vs nightly 분리 경위

#1335: "CI 범위 = 정적 검증만. iOS Release 빌드/시뮬레이터 실행/Maestro는 CI에 없음". 근거:
1. macOS runner 비용 (ubuntu 대비 10x)
2. iOS 빌드 시간 (캐시 없을 때 15~20분)
3. 시뮬레이터 flakiness (cold start 대비 `MAESTRO_DRIVER_STARTUP_TIMEOUT: 240000`)
4. native 모듈 (audio-route / live-activity / motion-activity) 시뮬레이터 제약

---

## §3 옵션 3+ (false binary 차단)

### 옵션 A: Maestro PR 게이트 격상 (smoke 한정)

- **내용**: `e2e.yml`에서 `smoke` 6개를 분리해 PR 게이트 job으로 추가. macOS runner 사용.
- **비용**: PR당 ~10~20분 추가 (Pods 캐시 hit 시 ~8분). macos-14 runner 비용 증가.
- **커버리지**: HomeScreen 렌더 / 즐겨찾기 / 취침 모드 토글 / 탭 네비게이션 → prebuild drift/native compile 깨짐 PR 게이트에서 차단 가능.
- **한계**: gps/regression/permissions는 여전히 nightly. device-only(LA/silent push/위젯) 여전히 X.
- **조건**: smoke 시나리오가 `EXPO_PUBLIC_E2E_MOCK=1` 빌드 기반 → GPS/권한 mock 단락 → GPS 실측 없어도 동작 확인 가능. 단, 시뮬레이터 flakiness + 빌드 시간 부담.

### 옵션 B: Maestro nightly 강화 (현 nightly 유지 + 시나리오 확장)

- **내용**: 현 PR 게이트(정적 검증)는 유지. nightly에 시나리오만 추가 (manual/ yaml 중 시뮬레이터 가능한 것 이관).
- **비용**: 추가 시나리오 작성 시간. nightly 실패 시 다음날 아침 발견.
- **커버리지**: manual/ 중 `trip_lockless_hop_window.yaml`, `trip_transfer_autolock.yaml` 등은 실기기용이지만 mock GPS로 시뮬레이터에서도 일부 재현 가능. 단, LA/silent push는 여전히 X.
- **한계**: PR 머지 당일 회귀 탐지 X. 사용자 책임 영역 좁히는 효과 미미.

### 옵션 C: fixture runner 확장 (Maestro 추가 없음)

- **내용**: #1834 fixture chain runner에 추가 stage/시나리오 추가. Maestro 확장 안 함.
- **비용**: 신규 dump fixture 확보 필요. device trip 1회 = fixture 1개.
- **커버리지**: chain 논리 + environment classification + 신호 소스 추적. UI 렌더/prebuild drift는 커버 X.
- **한계**: UI 회귀(렌더링 깨짐/TestID 변경) 탐지 불가. device-only 갭 좁히기 효과 없음.
- **적합 시나리오**: Phase 6.x cold start, environment-classified edge case, lockless chain 경로 추가.

### 옵션 D: Detox 도입 검토

- **내용**: Maestro 대신 Detox(Wix)로 전환 또는 병행.
- **비용**: Detox는 Expo 54와 호환성 제약. `expo-detox-hooks` 별도 설정. 러닝 커브 높음.
- **커버리지**: native 이벤트 시뮬레이션 가능 (Maestro보다 세밀). 단, Expo 버전 호환성 및 setup 비용이 Maestro 대비 현저히 높음.
- **결론**: Maestro가 이미 광범위하게 도입된 상태에서 전환 ROI가 없음. **탈락**.

### 옵션 E: 현 상태 유지 (변경 없음)

- **내용**: PR 게이트 변경 없음. nightly 유지. 사용자 책임 영역 현행 유지.
- **비용**: 0.
- **커버리지**: 현행 유지.
- **한계**: device-only 회귀는 계속 사용자 책임. 사용자 릴리스 직전 빌드 시 발견.
- **적합 시나리오**: Phase 6 개발 집중 필요 시 일시적 동결.

---

## §4 트레이드오프 표

| 옵션 | 도입 비용 | PR 게이트 커버리지 추가 | 유지보수 부담 | device-only 갭 보완 | 권장 여부 |
| --- | --- | --- | --- | --- | --- |
| A. smoke PR 게이트 격상 | 중 (macOS runner 비용 + smoke 안정화) | 높음 (prebuild drift, UI 렌더) | 중 (iOS 빌드 캐시 관리) | 낮음 (LA/push 여전히 X) | **조건부 O** |
| B. nightly 시나리오 확장 | 낮음 | 없음 | 낮음 | 낮음 | 보조 O |
| C. fixture runner 확장 | 낮음 | 없음 (unit) | 낮음 | 없음 | 보조 O |
| D. Detox 도입 | 높음 | 높음 | 높음 | 낮음 | X |
| E. 현 상태 유지 | 0 | 없음 | 0 | 없음 | Phase 6 집중 시 일시 O |

---

## §5 시장/문서 Evidence

### Maestro Expo 54 호환성

- Maestro CLI는 Expo Go / development build / 시뮬레이터 모두 지원.
- `EXPO_PUBLIC_E2E_MOCK=1` 환경변수로 mock 빌드 분기 → smoke는 GPS/권한 없이 시뮬레이터에서 결정적 동작.
- 현재 `e2e.yml`의 `smoke` job (존재하지 않음 — smoke는 nightly `e2e` job에 포함되지 않고 별도 추가 필요) 분리 시 `--dry-run` 문법 검증 step 재사용 가능.

### 실제 운영 경험 (#852, #1230, #1335, #949)

- `#852`: cold start XCUI driver startup timeout 240s 확대 (macos-14 CI cold start).
- `#1230`: smoke flow를 text 매처 → testID 매처로 전환 (i18n locale 변경 회귀 차단).
- `#949`: sleep mode flow에서 단발 swipe → `scrollUntilVisible` 전환 (destination 블록 가변 길이).
- `#1117/#1118`: `ios/.xcode.env.local` CI 생성 + touch 선행 처리.

이 fix 이력은 **시뮬레이터 smoke는 이미 안정화 단계**임을 의미한다. PR 게이트로 격상 시 추가 flakiness 위험 낮음 (단, DerivedData 캐시 miss 시 빌드 시간 15~20분).

### Detox 비교

Expo 54 + native modules (audio-route / live-activity / motion-activity) 조합에서 Detox는 별도 `react-native-community/detox` 호환성 매트릭스 검증 필요. Maestro가 이미 해당 스택에서 production-grade로 운영 중이므로 전환 ROI 없음.

---

## §6 결정: 옵션 B (nightly 강화) + 옵션 C (fixture runner 확장) 우선, 옵션 A는 Phase 6 완료 후 재평가

### 근거

**옵션 A (smoke PR 게이트 격상)를 지금 격상하지 않는 이유:**
1. Phase 6.x (cold start #1836, #1841~#1844) 개발 중 — PR당 +10~20분 대기는 병렬 BG agent 워크플로에 friction.
2. smoke 6개 시나리오는 `EXPO_PUBLIC_E2E_MOCK=1` mock 빌드 기반 → prebuild drift는 감지하지만 native 모듈 회귀(LA/push)는 여전히 X.
3. 현재 nightly `e2e + regression + permission-matrix` 가 이미 회귀를 다음날 오전에 잡아주고 있음.
4. **device-only 회귀의 실질적 위험은 LA/silent push/위젯 — 이는 smoke PR 게이트로도 커버 불가.**

**지금 해야 할 것:**
- 옵션 B: nightly에 manual/ 중 시뮬레이터 가능한 `trip_transfer_autolock.yaml` 등 이관 검토 (별 PR)
- 옵션 C: fixture runner에 Phase 6.x cold start 경로 추가 (Phase 6.2 PR에서 포함)

**옵션 A 재평가 조건:**
- Phase 6 완료 + nightly flakiness 0건 1주 달성 시
- smoke 격상의 실질 효과 = prebuild drift 차단 → EAS 릴리스 빌드 직전 로컬 `npm run ios` 사용자 책임과 중복

---

## §7 결정별 산출

### 옵션 B 확장 대상 (별 PR — 지금 아님)

`.maestro/manual/` 중 시뮬레이터 가능 후보:
- `trip_transfer_autolock.yaml` — `setLocation` + GPS dispatch만 있으면 시뮬레이터에서 mock trip 형성 가능. boarding-lock-hop-card 렌더 검증.
- `trip_sticky_subsurface.yaml` — barometer 없이 mock subsurface 환경 fixture로 대체 가능.

**단, 두 파일 모두 현재 `manual/` 폴더 = 실기기 필요 의도** → 이관 전 mock GPS로 재현 가능한지 검증 필요. 별 이슈로 분리.

### 옵션 C 확장 (Phase 6.2 PR에서 포함)

fixture chain runner에 추가 stage 후보:
- `cold-start-candidate-extracted` — #1836 Phase 6.1 cold start 후보 추출 stage
- `cold-start-picker-selected` — #1841/#1842 cold start 가중치 + picker UI

---

## §8 Acceptance + Wire-completion 5단

### Wire-completion 5단

1. **Orphan**: 코드 변경 없음 (doc-only). `npm run lint:orphan` pass — N/A.
2. **V/X dashboard**: 이 PR은 feasibility audit + plan doc. 측정 대상 없음. — N/A.
3. **의존 PR**: #1834 (fixture chain runner) 기반 감사. 독립.
4. **측정 plan**:
   - 옵션 B 채택 시: nightly 시나리오 pass/fail rate 1주 측정 (`e2e.yml` artifact 확인).
   - 옵션 C 채택 시: Phase 6.2 PR의 fixture chain 통과율로 측정.
   - 옵션 A 격상 시: PR 게이트 평균 소요 시간 + false-positive 발생 횟수 1주 측정.
5. **Device verify**: N/A — doc-only PR. 코드 변경 없음.

### Acceptance 체크리스트

- [x] §1 사용자 가치 — device-only 갭 + Maestro 추가 커버 가능 영역 정의
- [x] §2 현재 state — `.maestro/` 전체 감사 (flows 30개+, manual 6개, e2e.yml 3 jobs)
- [x] §3 옵션 A~E 5개 (false binary 차단, Detox 비교 포함)
- [x] §4 트레이드오프 표
- [x] §5 시장/문서 evidence (Expo 54 호환성 + 실제 fix 이력)
- [x] §6 결정 1택 + 이유 (옵션 B+C 우선, A는 Phase 6 완료 후 재평가)
- [x] §7 결정별 산출
- [x] §8 Wire-completion 5단

---

## §9 관련 메모리

- `feedback_phase0_measurement_infra_pattern.md` — Analytics + Sentry + alarmLog forward + dashboard
- `feedback_chain_validation_not_measurement.md` — 실기기 trip 1회 = chain 검증. 측정 부산물
- `feedback_ci_gate_includes_e2e.md` — Type Check & Test + Data Validation + SonarCloud 3개
- `feedback_e2e_local_gate.md` — mock+smoke로 재활성화 진행 중
- `lesson_expo_native_config_drift.md` — app.config.js 변경 시 expo prebuild 필요 → smoke PR 게이트가 이를 차단할 수 있음
- `lesson_worktree_test_env_drift.md` — 격리 worktree "37 fail" 거짓 신호. 메인 dev에서 재확인 필수

---

## 결론 요약

| 항목 | 결론 |
| --- | --- |
| Maestro 도입 상태 | 이미 production-grade. flows 30개+, 3 nightly job, 안정화 완료 |
| PR 게이트 격상 (옵션 A) | Phase 6 완료 후 재평가. 현재는 BG agent workflow friction 과도 |
| 지금 할 일 | 옵션 B: nightly 시나리오 확장 검토 (별 PR) + 옵션 C: Phase 6.2 fixture runner 확장 |
| 결코 해야 할 것 | device-only (LA/push/위젯) 갭은 Maestro로 커버 불가 → 사용자 책임 공식화 + manual/ 문서 유지 |
| Detox | 도입 ROI 없음. Maestro 현행 유지 |
