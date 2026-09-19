# alarmLog.ts reason/source sprawl 감사 — 2026-09-19

감사 범위: `src/features/alarm/utils/alarmLog.ts`(3243줄)의 `AlarmLogSource`/`AlarmLogReason` union 멤버 중, 8/22~9/18 덤프 20개(`~/.claude/uploads/*/*.txt`)에서 관측되지 않은 79개 리터럴. 코드 변경 없음 — 분류표만 작성.

## 1. 요약

| 분류 | 개수 |
| --- | --- |
| (a) 도달 불가 | 15 |
| (b) 희귀 조건 | 39 |
| (c) 판정 불가 | 24 |
| 계 | 78 (+1 제외, §5 참고) |

원본 79개 중 `fused`는 방법론 오류로 확인 — `AlarmLogSource`/`AlarmLogReason` 멤버가 아니라 `FusionPickerTier`(`pickFusionTier.ts`)의 별도 union 멤버다. 재생성 스크립트의 정규식(`^\s*\|\s*'...'`)이 다른 파일 타입 union까지 같이 잡아낸 오탐 — alarmLog 감사 대상에서 제외한다(§5 측정 한계에도 기록).

## 2. (a) 도달 불가 — 15개 전체 목록

| 리터럴 | 도달 불가 근거 (file:line) | 관련 이슈/ADR |
| --- | --- | --- |
| `alert-fallback-fired` | 전용 writer `logAlertFallbackFired`(`alarmLog.ts:1517`)를 호출하는 production 코드가 0건. `grep -rn "logAlertFallbackFired("` 결과 `alarmLog.ts` 정의부와 `__tests__/alarmLog.test.ts`(2339~4116행) 외 참조 없음. | #564 (comment `alarmLog.ts:51`) |
| `gate-line-mismatch` | `AlarmLogReason` union 멤버 선언(`alarmLog.ts:192`)만 존재 — `reason: 'gate-line-mismatch'` 또는 `source: 'gate-line-mismatch'` 대입이 `alarmLog.ts` 자신을 포함해 저장소 전체에 0건. 전용 writer 함수 자체가 없다(다른 gate reason들과 달리 `logSuppressed*` 매핑도 없음). | #1365 (의도만 comment `alarmLog.ts:190-191`에 남음, 구현 없음) |
| `gate-no-location` | 동일 — union 멤버 선언(`alarmLog.ts:187`)뿐. `recallMetrics.ts:72`/`backend/.../recallTelemetry.ts:40`/`telemetry.ts:36`는 reason을 분류하는 reader-side 상수 배열이지 writer가 아니다. 대입 0건. | #478 (legacy — comment `alarmLog.ts:167-168`: "구 실버시 게이트") |
| `gate-stale-location` | 동일 패턴 — union 멤버(`alarmLog.ts:188`) + reader 배열(recallMetrics.ts:73 등)뿐, 대입 0건. | #478 (legacy) |
| `gate-out-of-range` | 동일 패턴 — union 멤버(`alarmLog.ts:189`) + reader 배열(recallMetrics.ts:74 등)뿐, 대입 0건. | #478 (legacy) |
| `gate-unknown-station` | 동일 패턴 — union 멤버(`alarmLog.ts:186`) + reader 배열(recallMetrics.ts:71 등)뿐, 대입 0건. | #478 (legacy) |
| `lock-line-mismatch` | union 멤버 선언(`alarmLog.ts:193`) + reader 배열(recallMetrics.ts:75, recallTelemetry.ts:43)뿐. `#707` 의도 comment(`alarmLog.ts:170-171`)는 있으나 실제 writer 없음. | #707 (의도만, 미구현) |
| `lockless-non-intermediate` | union 멤버(`alarmLog.ts:219`) + reader 배열(recallMetrics.ts:85 등)뿐, writer 없음. | #816 C (의도만, 미구현) |
| `lockless-opt-out` | union 멤버(`alarmLog.ts:220`) + reader 배열(recallMetrics.ts:86 등)뿐, writer 없음. | #816 C (의도만, 미구현) |
| `gate-stale-alarm-blocked` | union 멤버(`alarmLog.ts:316`)만 존재. comment(`alarmLog.ts:314`)가 조건("mirror.lastAdvanceAt 5분+ stale에서 fire 시도")을 서술하지만 그 가드 자체가 코드에 없다. | 미상 (comment에 이슈번호 없음) |
| `gate-stale-notify-blocked` | union 멤버(`alarmLog.ts:317`)만 존재. comment(`alarmLog.ts:315`)가 조건("30분+ stale에서 notify 시도")을 서술하지만 가드 미구현. | 미상 |
| `trip-token-mismatch` | union 멤버(`alarmLog.ts:312`)만 존재. 실제로 쓰이는 것은 별도 리터럴 `revalidate-trip-token-mismatch`(`alarmLog.ts:2382`, `scheduledAlarmReceiver.ts:249,314`)이며, comment(`alarmLog.ts:262`)가 "trip-token-mismatch와 원인이 다름"이라고 명시적으로 구분한다 — 즉 자매 리터럴이 살아있는데 이것만 선언 후 미사용. | #2089 (comment에서 대체 경위 서술) |
| `gate-origin-hop-lockless` | 전용 writer `logSuppressedOriginHopLockless`(`alarmLog.ts:2216`)가 정의돼 있으나 production 호출부 0건 — 유일한 참조는 `alarmLog.test.ts:1234`. | #1514 |
| `schedule-skipped-motion-stationary` | 전용 writer `logScheduleSkipped`(`alarmLog.ts:2423`, `motion-stationary` reason 하드코딩)의 production 호출부 0건 — 유일한 참조는 `alarmLog.test.ts:3443,3457`. | #1357 (S1) |
| `silent-push-fired` | **코드 자체가 구조적 no-op을 문서화**: `alarmLog.ts:1817-1821` — "`#2064`(Phase 1-device)로 device 로컬 발사(`silent-push-fired` source)가 구조적으로 no-op(`legacy-station-kind-ignored`)". 현 아키텍처(#2063/#2092)는 backend visible push + `silent-push-received`로 대체됐다. Writer 없음 — union 멤버(`alarmLog.ts:59`)와 lookup 테이블(1641/1712행)만 참조. 덤프 교차검증: `silent-push-fired` 0/20파일, 살아있는 형제 `silent-push-received` 36건·`silent-push-skipped` 23건 관측 — 대비가 뚜렷하다. | #2064, #2063, #2092 (ADR-037과 동형의 "part 아닌 whole" 확정 사례) |

**신뢰도 순위(가장 확실한 5개)**: `silent-push-fired`(코드 자체 self-doc) > `trip-token-mismatch`(자매 리터럴이 대체 증명) > `gate-line-mismatch`/`lock-line-mismatch`/`lockless-non-intermediate`/`lockless-opt-out`(수미상관 legacy comment만 있고 구현 자체 부재, 4건 동형) > `gate-origin-hop-lockless`/`schedule-skipped-motion-stationary`(함수는 존재하나 호출부 0, 회귀 테스트만 존속).

## 3. (b) 희귀 조건 — 39개

| 리터럴 | 도달 조건 |
| --- | --- |
| `autolock-ambiguity` | boardingPrompt 자동락 판정에서 후보 열차가 다중이라 확정 불가(`useBoardingPromptResponder.ts:463`). 정상 성공 시엔 기록 안 됨. |
| `autolock-arrivals-empty` | 자동락 시점 arrivals API가 빈 배열(`:399,462`). |
| `autolock-fallback-pending` | 자동락 fallback 대기 상태(`:628`). |
| `autolock-lock-failed` | 자동락 lock 생성 자체가 실패(`:517,631`). |
| `autolock-no-trip` | 자동락 트리거 시점에 활성 trip 없음(`:391`). |
| `autolock-station-lookup` | 자동락 역 조회 실패(`:492,594,600`). |
| `category-registration-failed` | OS `setNotificationCategoryAsync`가 reject/throw(`notificationCategory.ts:92,132,170,200`) — 정상 환경에서는 발생하지 않음. |
| `companion` | 취침모드 ON + backend `sleep-alarm-companion` silent push 수신(`silentPushTask.ts:1619`) — 취침모드 사용자에게만. |
| `cross-trip-mirror-mismatch` | backend SSoT mirror 채택이 device trip과 mismatch(`silentPushTask.ts:1036`) — race 조건. |
| `dedup-simple-arch-fire-once` | `isSimpleArchEnabled()`(env `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` 또는 backend KV) ON일 때만 호출부 진입(`alarmLog.ts:801`, `useStationAlarm.ts:1087`) — flag OFF면 dead. |
| `fg-ref-mismatch` | destinationId vs 캐시된 refDestId race mismatch(`alarmLog.ts:907`, `useStationAlarm.ts` 4곳). |
| `fired-alarms-trip-boundary-reset` | 같은 destinationId로 trip 재시작 감지 시점(`useStationAlarm.ts:836`) — 드문 재-네비게이션. |
| `last-train-alarm` | 막차 임박 알람(`lastTrainAlarm.ts:178`) — 심야 시간대 한정 기능. |
| `lockless-forward-only-block` | lockless trip + route 활성 + backward GPS jump 발생(`useFusedNearestStation.ts:885`). |
| `movement-implausible-speed-spike` | 단일 샘플에서 비현실적 속도 스파이크 관측(`movementGate.ts:154`) — GPS 노이즈 특이 케이스. |
| `movement-motion-warmup` | fg-hydrate 직후 warmup window(짧은 시간창)에서만(`movementGate.ts:153`). |
| `payload-missing-kind` | backend payload에 `kind` 필드 누락(`silentPushTask.ts:1360`) — malformed/구버전 payload에서만. |
| `push-contract-skew` | source 필드 — 아래 4개 skew 함수가 공유(`silentPushTask.ts` 다건) — 정상 배포에서는 device/backend 계약 일치. |
| `push-contract-skew-control-fail-closed` | control-shaped payload skew(`silentPushTask.ts:992`). |
| `push-contract-skew-station-fallback-fired` | station-shaped payload skew(`silentPushTask.ts:1349`). |
| `push-contract-skew-value-drift` | 필드 값 drift(`silentPushTask.ts:606,610`). |
| `push-contract-skew-version-old` | payload 버전 구버전(`silentPushTask.ts:1288`). |
| `revalidate-no-trip` | 예약 알람 fire 시점에 tripStart 없음(`scheduledAlarmReceiver.ts:240,309`) — 이미 종료된 trip 잔여 발화. |
| `revalidate-position-mismatch` | 재검증 시점 위치 mismatch(`:278`). |
| `revalidate-route-missing` | 재검증 시점 route 정보 없음(`:258`). |
| `revalidate-sleep-mode-on` | 취침모드 ON 상태에서 예약 알람 재검증(`:306`) — 취침모드 전용. |
| `revalidate-trip-token-mismatch` | tripToken 불일치(`:249,314`). |
| `revalidate-waypoint-mismatch` | waypoint mismatch(`:268`). |
| `sleep-first-station-passed` | 취침모드 게이트, station-passed 카테고리(`stationPipeline.ts`) — 취침모드 전용. |
| `sleep-first-transfer` | 취침모드 게이트, transfer 카테고리(`stationPipeline.ts:528`, `useStationAlarm.ts:903`) — 취침모드 전용. |
| `trip-dead-pull-detected` | dead-pull backstop 감지(`tripDeathPullBackstop.ts:140`) — 정상 경로면 미발생. |
| `trip-device-self-end-arc-completion` | backend가 trip 종료를 확정 못했을 때 device가 arc 완주로 self-end(`useDeviceSelfEnd.ts`) — backstop edge case. |
| `trip-device-self-end-eta-backstop` | 동일 self-end, ETA backstop 트리거. |
| `trip-device-self-end-fusion-destination` | 동일 self-end, fusion 목적지 도달 트리거. |
| `trip-ended-corr-mismatch` | trip-ended push의 corrId 불일치(`silentPushTask.ts:1144`) — race. |
| `trip-lifecycle-force-ended` | 앱 재시작 시 이전 trip 강제 종료 감지(`useStateRehydration.ts:214`) — 특정 kill/재시작 시점. |
| `trip-lifecycle-silence` | 앱 재시작 시 이전 trip lifecycle 침묵 감지(`:203`). |
| `trip-paused-auto-ended` | 일시정지된 trip 자동 종료(`:259`). |
| `trip-sentinel-stale-discarded` | stale sentinel 폐기(`:94`). |

## 4. (c) 판정 불가 — 24개

| 리터럴 | 왜 판정 불가인지 |
| --- | --- |
| `bg-scheduled` | writer(`logScheduledAlarm` 등, `alarmLog.ts:675,2387,2408,2435`)는 production에서 흔히 도달할 스케줄 경로인데 덤프 미관측 — 추출 스크립트가 `source=` 필드 패턴을 온전히 못 잡았을 가능성(측정 한계, §5) 아니면 정말 200-cap ring buffer에서 밀려났을 가능성 둘 다 배제 못함. |
| `boardable-lookup` | route 계산 시 매 leg 호출되는 흔한 경로(`computeBoardableWaitsForRoute.ts:88,113`)인데 미관측 — 조건 자체는 희귀하지 않음. |
| `dedup-phase-to-phase` | 일반 알람 dedup 경로(`stationPipeline.ts:574`, `useStationAlarm.ts:965`)로 흔할 것으로 예상되나 미관측. |
| `dismiss-silence` | 사용자가 알람을 dismiss하는 흔한 행동에서 트리거(`stationPipeline.ts:483,624`, `useStationAlarm.ts` 3곳)인데 미관측. |
| `gate-alarm-already-decided` | `ssotFireGate.ts:121` — 일반 흐름에서 재발사를 막는 흔한 gate로 보이나 덤프에 없음. |
| `gate-station-already-passed` | 동일 gate 계열(`ssotFireGate.ts:137,145`). |
| `gate-motion-stationary` | BG 위치 태스크의 정지 게이트(`backgroundLocationTask.ts:407`) — 주머니 정지 등 흔할 것으로 보이나 미관측. |
| `ground-truth-response` | trip 종료마다 prompt가 뜨는 흔한 트리거(`useTripGroundTruthStore.ts:139,152`)이나, 사용자가 실제로 응답해야 기록됨 — 응답률이 낮아서인지 버퍼 소실인지 구분 불가. |
| `leg-transition` | 환승 있는 trip마다 발생할 것으로 예상(`useBoardingLockAutoRelease.ts:160`)이나 미관측. |
| `lifecycle-backstop` | 여러 backstop 경로가 공유하는 source(`tripDeathPullBackstop.ts:138`, `useDeviceSelfEnd.ts:205`, `useStateRehydration.ts` 4곳) — 조건이 다양해 개별 희귀도 판정 불가. |
| `movement-no-location` | GPS 신호 완전 부재(`movementGate.ts:147`) — 지하 진입 시 흔할 것으로 예상되나 미관측. |
| `movement-stale-timestamp` | GPS 타임스탬프 stale(`movementGate.ts:148`) — 동일하게 흔할 것으로 예상. |
| `response-dismissed` | boardingPrompt dismiss라는 흔한 사용자 행동(`useBoardingPromptResponder.ts:263,333`)인데 미관측 — 사용자가 대부분 탑승 확정을 택했을 가능성. |
| `skip-bad-destination` | BG 발사 진단 skip 카운터(`bgWaypointArvlcdFire.ts`, `bgPositionTrainFire.ts`) — 매 폴링 사이클 평가되는 경로라 조건 자체 빈도 추정 불가. |
| `skip-empty-arc` | 동일 계열(`bgPositionTrainFire.ts:114`). |
| `skip-locked-gate` | 동일 계열(`:158`). |
| `skip-no-destination` | 동일 계열(`bgWaypointArvlcdFire.ts:88`, `bgPositionTrainFire.ts:70`). |
| `skip-no-next-target` | 동일 계열(`bgWaypointArvlcdFire.ts:122`). |
| `skip-no-origin` | 동일 계열(`bgPositionTrainFire.ts:107`). |
| `skip-no-target-station` | 동일 계열(`bgWaypointArvlcdFire.ts:134`). |
| `skip-no-train-progress` | 동일 계열(`bgPositionTrainFire.ts:149`). |
| `skip-not-imminent` | 동일 계열(`bgWaypointArvlcdFire.ts:128`). |
| `skip-pending-traincode` | 동일 계열(`bgWaypointArvlcdFire.ts:80`, `bgPositionTrainFire.ts:62`). |
| `skip-poll-null` | 동일 계열(`bgPositionTrainFire.ts:133`). |

## 5. 측정 방법의 한계

- **Ring buffer 절단**: alarmLog는 200-cap, 일부 섹션은 1시간 창 — 희귀 조건이 아니어도 활성 trip 중 다른 이벤트가 폭주하면 밀려날 수 있다((c) 상당수가 이 케이스일 가능성).
- **덤프 20개 = 표본 편향**: 8/22~9/18 기간에 취침모드를 켜지 않았거나, 에러/cold start를 겪지 않았거나, Android 기기를 쓰지 않았으면 그 조건 전용 리터럴은 통계적으로 0이 나온다. (b) 분류 대부분이 이 케이스.
- **추출 정규식의 한계**: 재생성 스크립트는 `key=value`, `reason=`, 파이프 구분 패턴만 잡는다. `source=` 필드가 다른 포맷(JSON 중첩, 콤마 구분 등)으로 찍혔다면 실제로는 흔한데도 "미관측"으로 잘못 집계될 수 있다 — `bg-scheduled`가 유력한 예시.
- **`fused` 오탐**: 이번 감사에서 실제로 겪은 사례. 서로 다른 파일의 서로 다른 union(`AlarmLogSource` vs `FusionPickerTier`)이 같은 정규식 패턴에 걸려 섞였다 — 이 저장소처럼 `'literal'` 형태 union 정의가 여러 곳에 있으면 재생성 스크립트를 파일 스코프로 한정해야 한다.
- **(a)의 신뢰 범위**: "production 호출부 0건"은 grep 기반 정적 검증이며 동적 문자열 조합(`` `${prefix}-${suffix}` ``)으로 리터럴이 조립되는 경우는 놓칠 수 있다. 다만 alarmLog.ts 전체를 훑은 결과 이런 동적 조립 패턴은 발견되지 않았다 — 모든 writer가 정적 리터럴 또는 고정 lookup 테이블을 사용한다.
- **(b)/(c) 구분은 (a)만큼 검증되지 않음**: (a) 15개는 "호출부 0건"이라는 이진 사실로 확정했지만, (b)/(c) 64개(+제외 1)의 구분은 조건의 "희귀함"에 대한 정성적 판단이다. 예를 들어 `skip-*` 11종은 모두 같은 BG 발사 진단 함수 계열인데, 실제 운영에서 어느 게이트가 자주 걸리는지는 계측 없이는 알 수 없어 전부 (c)로 묶었다 — 개별적으로는 (b)일 수도 있다.
- **fusion source 14종 주장과 실제 코드 불일치**: 브리핑에서 언급된 "fusion source 14종"을 코드에서 확인한 결과, `FusionSource`(`src/shared/types/fusion.ts:50-59`)는 실제로 9개 멤버(`backend-ssot`/`boarding-lock`/`boarding-lock-interp`/`position-train`/`position`/`arrival`/`route-progress`/`gps`/`wifi-ssid`)뿐이다. 14라는 숫자의 출처를 찾지 못했다 — 다른 이름의 taxonomy(예: `pickFusionTier.ts`의 10-tier 목록)와 혼동됐을 가능성이 있다. 아래 §6은 실제 9개 멤버 기준 측정이다.

## 6. `alarmLog.ts` 외 sprawl 측정 (분류 없음, 측정만)

### FusionSource 9종 — 덤프 내 문자열 등장 횟수(참고용, "관측=사용"을 의미하지 않음 — 흔한 단어라 다른 맥락에서도 매칭될 수 있음)

| source | 등장 횟수 |
| --- | --- |
| `gps` | 13455 |
| `position` | 4000 |
| `arrival` | 3161 |
| `route-progress` | 2236 |
| `backend-ssot` | 1317 |
| `boarding-lock` | 727 |
| `position-train` | 398 |
| `boarding-lock-interp` | 0 |
| `wifi-ssid` | 0 |

`boarding-lock-interp`/`wifi-ssid` 0건은 alarmLog 감사와 별개 신호지만 같은 패턴("정의는 있고 관측은 없음")이라 참고로 남긴다 — 이번 감사 분류표에는 포함하지 않았다(요청 범위가 alarmLog reason/source였음).

### 발사 평가 경로 4종 상대 빈도 (`fg`/`bg`/`fg-evaluated`/`silent-push*`)

| 경로 | 등장 횟수 |
| --- | --- |
| `fg` | 1697 |
| `bg` | 1213 |
| `fg-evaluated` | 576 |
| `silent-push-received` | 36 |
| `silent-push-skipped` | 23 |
| `silent-push-fired` | 0 |

`silent-push-fired` 0건은 §2의 (a) 판정과 정확히 교차 확인된다 — 코드 근거(구조적 no-op 문서화)와 덤프 근거(형제 리터럴은 관측되는데 이것만 0)가 일치.

## 7. (a) 삭제 시 예상 감소 줄 수 (추정)

전용 함수/type 분기만 제거한다고 가정한 러프 추정 — 실제 PR에서는 테스트 파일 정리량이 더 클 수 있다.

| 리터럴 | production 코드 추정 감소 |
| --- | --- |
| `alert-fallback-fired` | 함수 `logAlertFallbackFired` 전체(~20줄, comment 포함) + union 멤버 1줄 + lookup 2줄 ≈ 23줄 |
| `gate-origin-hop-lockless` | 함수 `logSuppressedOriginHopLockless` 전체(~20줄) + union 멤버 1줄 + comment 3줄 ≈ 24줄 |
| `schedule-skipped-motion-stationary` | 함수 `logScheduleSkipped` 전체(~18줄) + union 멤버 1줄 ≈ 19줄 |
| `silent-push-fired` | union 멤버 1줄 + lookup 3줄. **주의**: `computeSilentPushReach`(alarmLog.ts:1837~) 등 소비 함수는 이 값이 항상 0임을 전제로 로직이 짜여 있어, 단순 삭제보다 "왜 0인지" 아키텍처 문서를 남기는 편이 안전 — #2064 comment가 이미 그 역할을 하고 있다. |
| `gate-line-mismatch`/`gate-no-location`/`gate-stale-location`/`gate-out-of-range`/`gate-unknown-station`/`lock-line-mismatch`/`lockless-non-intermediate`/`lockless-opt-out`/`gate-stale-alarm-blocked`/`gate-stale-notify-blocked`/`trip-token-mismatch` (11개) | 각 union 멤버 1줄 + comment 0~3줄. 다만 `recallMetrics.ts`/`backend/recallTelemetry.ts`/`telemetry.ts`의 reader 배열에서도 해당 항목을 같이 빼야 완전 정리 — 이 3개 파일에서 각 리터럴당 최대 3곳(FE recallMetrics, BE recallTelemetry, BE telemetry) 참조 삭제 필요. 11개 × (union 1줄 + reader 최대 3줄) ≈ 최대 44줄, 최소(reader 미등재 항목 제외) ≈ 15줄 |

**총합 추정**: production 코드 기준 대략 80~130줄 감소(테스트 파일 제외). 정확한 숫자는 실제 삭제 PR에서 IDE 참조 검색으로 재확인 필요 — 이 표는 근사치다.
