/**
 * D1 trip_events append-only 로그 helper (#2283).
 *
 * 배경: `/boarding-lock/sync`(index.ts) · `/position`(index.ts)은 KV trip 객체를 in-place
 * mutate만 한다. trip이 user-delete(HTTP DELETE /trips/:token)되면 KV 객체 + position series까지
 * 삭제되어, "환승 swap sync가 도달했는지 / advance가 발생했는지"를 사후 재구성할 방법이 없었다
 * (2026-08-11 RCA blind spot — 08-11 A′ 검증 판정 불가의 직접 원인).
 *
 * 본 모듈은 kind 최소 집합(sync-received / advance / hydrate-issued / trip-end)을 D1
 * `trip_events`에 append-only로 기록한다. trip 삭제와 독립 — token_hash만으로 타임라인을
 * wrangler d1 SELECT로 재구성할 수 있다(진단 용도가 acceptance).
 *
 * Free plan quota 보호: KV write는 하지 않는다(#2073 lesson — cron이 사용자 0명에도 KV quota
 * 소진). D1 write만 사용하며 이벤트당 정확히 1 insert. `cleanupTripEvents`가 보존 기간(7일)
 * 초과분을 주기적으로 삭제한다.
 *
 * `env.DB` 미바인딩 시 graceful no-op. 적재 실패는 호출 흐름을 차단하지 않는다(swallow) —
 * d1ErrorLog.ts / d1TripMetrics.ts와 동일 패턴.
 *
 * #2283 리뷰 P2-1 — write/cleanup 실패는 console.warn만으로 무음 처리하지 않고
 * `captureXEvent('D1-write-failure', ...)`(sentry.ts, d1ErrorLog.ts와 동일 기존 이벤트 재사용,
 * 신규 유니온 추가 없음)로 관측 승격한다.
 */

import { captureXEvent, hashTripToken } from './sentry';

/**
 * trip_events.kind 최소 집합. 데이터 주도 확장 시 이 유니온에 추가한다.
 *
 * `consensus-confirm` / `consensus-demote` / `consensus-suppress` (#2327, consensus-A) —
 * `transferLegConsensus.ts` 상태기계가 산출하는 `LegConsensusEvent`를 D1에 append할 때 쓰는
 * kind. 실제 insert 호출(엔진 이벤트 → 본 kind로 write하는 wire)은 #2329(consensus-C) 범위 —
 * 본 파일은 kind 유니온만 선반영한다.
 *
 * `cron-fire-attempt` (#2343) — cron 자율 fire path(`tryAdvanceAndFireArvlcd` /
 * `fireArvlCdStationPush`, scheduled.ts)가 destination/transfer/station-passed(intermediate)
 * push를 실제로 발사 시도한 시점에만 append. 매 tick이 아니라 발사 시도(성공/실패/trip 삭제
 * race skip) 시점 1건만 write — Free plan D1 quota 보호(#2073 lesson). `meta`에
 * `{ waypointKind, phase, outcome, reason? }`을 싣는다 — 새 kind를 추가하지 않고 기존
 * trip_events 스키마를 재사용(quota 증분 최소화).
 *
 * `consensus-tick` / `intermediate-route` (ADR-037 D2, #2533) — 진단 계측 전용. leg-2 침묵
 * root를 D1만으로 격리하기 위해 legConsensus 상태기계 진행/조기 반환 사유와 intermediate
 * waypoint 라우팅 분기를 관측한다. fire/advance 동작에는 관여하지 않는다.
 *
 * - `consensus-tick` — `applyLegConsensusTick`(advanceTripPosition.ts)의 legConsensus.status
 *   전이(confirm/demote/suppress 이벤트가 별도로 남는 전이는 중복 제외)만 append(#2073 quota
 *   보호). #2766 (결정 D1) — 구 `tryFireConsensusTrainLeg`(scheduled.ts)의 candidate 관측 전
 *   조기 반환 사유(`ConsensusNeverRanPhase`) 전이 writer는 fire 진입점 제거와 함께 삭제됐다.
 *   **writer 0 (#2766)** — `applyLegConsensusTick` 자체도 유일 production 호출자가
 *   `tryFireConsensusTrainLeg`였고 그 제거로 프로덕션 caller가 0건이 됐다(함수 자체는 존치,
 *   존폐는 #2754/#2761/#2760 트랙 결정 범위 — PR #2776 참고). D1 `trip_events`를 `kind=
 *   'consensus-tick'`으로 조회해 0행이 나와도 "전이가 없었다"가 아니라 "이 kind를 쓰는 코드가
 *   현재 아예 실행되지 않는다"로 해석해야 한다 — 오독 방지.
 * - `intermediate-route` — intermediate waypoint에서 `lockless`(C 토글 ON,
 *   `runLocklessIntermediate`)/`consensus`(C 토글 OFF, #2766에서 fire 시도가 제거돼 현재는
 *   완전 침묵) 중 어느 분기로 dispatch됐는지. 직전 분기와 다를 때만 append.
 *
 * `boarding-confirm-result` / `transfer-advance` / `leg2-estimate` (ADR-037 D2b, #2535) — 진단
 * 계측 전용. #2533(D2)이 커버하지 못한 3개 조건부 stall 지점(boarding-confirm 탭 처리 결과,
 * 환승 waypoint advance 성공/실패, leg-2 estimateBoardingLockArrival trainCode 매칭)을 관측한다.
 * fire/advance 동작에는 관여하지 않는다.
 *
 * - `boarding-confirm-result` — `POST /trips/:token/boarding-confirm`(index.ts) 탭 처리 1건당
 *   정확히 1회 append(HTTP 요청 단위라 throttle 불필요 — 매 tick 반복 호출이 아니다). `meta`에
 *   `{ lockState, outcome? }` — `lockState`는 항상 존재('none'/'leg1'/'leg2'/'released'),
 *   `outcome`은 `action==='boarded'`이고 신규 resolve를 실제로 시도했을 때만 존재
 *   (`BoardingResolveOutcome`, `boardingAnchorResolver.ts`).
 * - `transfer-advance` — 환승(transfer) waypoint를 실제로 통과했는지(`lockless`=
 *   `runLocklessTransfer`, `lock-active`=`runTrainCodeTracking`의 lock 활성 경로) 관측한다.
 *   SSoT 마커(`transferAdvanceState`)와 비교해 다를 때만 append(#2073 quota 보호).
 * - `leg2-estimate` — leg-2(환승 후, `trip.currentLegAnchor` 활성) lock의
 *   `estimateBoardingLockArrival`이 locked trainCode를 Seoul arrivals/positions에서 찾았는지
 *   (matched=`estimate!==null`). SSoT 마커(`leg2EstimateMatched`)와 비교해 다를 때만 append.
 *
 * `leg-boarding-prompt` / `hop-end-prompt` (ADR-037 D2c, #2537) — 진단 계측 전용. 사용자 ground
 * truth(7→2 환승 시 leg-2에서 탑승 프롬프트도 하차 프롬프트도 뜨지 않음)에 따라 root를 lock/fire
 * (#2535 D2b)보다 한 단계 위 — 프롬프트 fire 시도 자체가 안 됐는지를 관측한다. fire/advance/lock
 * 동작에는 관여하지 않는다.
 *
 * - `leg-boarding-prompt` — `maybeFireLegBoardingPrompt`(scheduled.ts)의 fire 여부/skip 사유
 *   (`LegBoardingPromptOutcome`). SSoT 마커(`legBoardingPromptOutcome`)와 비교해 다를 때만 append.
 * - `hop-end-prompt` — `maybeFireHopEndPrompt`(scheduled.ts)의 fire 여부/skip 사유
 *   (`HopEndPromptOutcome`). SSoT 마커(`hopEndPromptOutcome`)와 비교해 다를 때만 append.
 *
 * `fallback-alert-fired` (#2610, RCA-A) — `runFallbackPushes`(fallback.ts)가 pending silent
 * push의 60s ACK 임계 초과로 alert fallback을 실제로 발사 시도한 시점에 1건 append. KV
 * pending entry는 발사 직후 삭제되어 사후 추적이 불가능했다 — 반복 발사(pile) 재발 여부를
 * D1만으로 즉시 확정하기 위한 계측 전용 kind. fire/advance 동작에는 관여하지 않는다.
 * `meta`에 `{ pushId, ageMs }`를 싣는다.
 *
 * `leg-anchor-observed` (#2700) — `maybeStampLegAnchorFromObservation`(scheduled.ts)이 환승
 * waypoint advance가 `no-arvlcd`로 실패했음에도 `trip.transferObservedAt`(device sync 관측)이
 * 유효해 `currentLegAnchor`/`legBoardingEligibleAt`을 stamp한 시점에 1건 append. 같은 anchor의
 * 창-밖 재-stamp(시각 보정)는 재기록하지 않는다(#2073 quota 보호). `transfer-advance`(outcome=
 * 'advanced', advance 성공 경로)와 `leg-boarding-prompt`(anchor 소비 결과)와는 별개 kind라
 * D1에서 "관측이 anchor를 살렸는지"를 독립적으로 조회할 수 있다. `meta`에 `{ observedAtMs }`를
 * 싣는다. fire/advance/도보 게이트 판정에는 관여하지 않는다.
 *
 * `route-signature-mismatch` (#2723, 진단 계측 전용) — `resetTripStateForNewRoute`(trips.ts)가
 * `computeRouteSignature(existing) !== computeRouteSignature(incoming)`를 감지한 시점마다
 * 1건 append(self-progress로 판정돼 reset하지 않는 경우 포함 — throttle 없음, POST /trips
 * 호출 단위라 매 tick 반복이 아니다). 2026-09-18 라이딩 중 KV 직접 조회로만 발견된 상태
 * 소실(currentLegAnchor/legBoardingEligibleAt/passedStations/lockEverAttached 등 `#2547`
 * 보존 목록 전체 소실)의 원인이, backend가 진행할 때마다 자기 waypoints를 shift해 device가
 * 재등록한 route와 signature가 갈라지는 것이었다 — 그 갈림이 실제로 얼마나/언제 발생하는지
 * 로그가 전혀 없었다(#2723 요구사항 1). `meta`에 `{ existingSig, incomingSig, selfProgress }`를
 * 싣는다 — `selfProgress`(`isRouteProgressOnly`)가 true면 backend 자기 진행으로 판정돼
 * reset하지 않은 것, false면 진짜 route 변경으로 in-place reset된 것. fire/advance 동작에는
 * 관여하지 않는다(계측 전용).
 *
 * `boarding-prompt-leg-mismatch` (#2708, 방어선 계측 only) — #2844로 은퇴(생산 중단, 과거 D1
 * row 조회 참고용으로만 남김). leg-1 전용(당시)
 * `evaluateAndMaybeFireBoardingPrompt`(scheduled.ts, 삭제됨)가 `trip.currentLegAnchor` 활성(leg-2 진입
 * 후) 중에 진입해 stale `trip.promptDisplay`(이전 leg 기준)로 발사를 시도할 뻔한 지점을 skip한
 * 시점에 1건 append. 정상 경로에서는 `stampCurrentLegAnchor`가 anchor stamp와 동시에
 * `promptDisplay`를 지워(#2708 요구사항 1) 이 분기 도달 자체가 없다 — 도달했다면 그 자체가
 * 회귀 신호(레거시 KV 레코드 등). SSoT 마커(`originPromptSkippedForLegAnchor`)와 비교해 최초
 * 전이 시에만 append한다(#2073 quota 보호). `meta`에 `{ staleDisplayLine }`을 싣는다.
 * 발사/advance/lock 판정에는 관여하지 않는다.
 *
 * `leg-resolve-attempt` (#2754, 요구사항 1) — leg-2 cron 자동 resolve(`evaluateLegBoardingTransition`,
 * `boardingAnchorResolver.ts`)가 매 cron tick 시도한 결과를 승격/보류/거부/무후보 **전부**
 * append한다(throttle 없음 — 이슈가 "승격/보류 양쪽 다 기록"을 명시했고, 이 평가는 walk-gate
 * 통과 이후 lock이 확정될 때까지의 짧은 창에서만 발생해 D1 quota 위험이 낮다). 사용자가 실제로
 * 탄 열차가 아닌 다른 열차가 왜/어떻게 선택되는지(streak 값, 경과 시간, 후보 목록)를 사후에
 * D1만으로 재구성하지 못했던 것이 #2754 진단 과정의 병목이었다 — 이 kind가 그 gap을 메운다.
 * `meta`에 `{ elapsedSinceAnchorMs, candidates, streakCount, outcome, selectedTrainCode? }`를
 * 싣는다. `station`/`line`은 anchor station/line. 발사/advance 동작에는 관여하지 않는다.
 *
 * `promotion-rejected-uncorroborated` (#2824) — `/boarding-lock/sync`(index.ts)의 sync-promotion
 * (`isPromotionCorroborated`)이 device가 보낸 `payload.trainCode`가 `trip.recentPromptCandidates`
 * (TTL 15분)에도 `trip.legResolveStreak.trainCode`에도 없어 lock 승격을 거부한 시점에 1건
 * append한다. `meta`에 `{ trainCode, line }`을 싣는다. 두 신호가 모두 부재(한 번도 stamp된 적
 * 없음)면 이 kind는 append되지 않고 기존대로 승격한다(backward-safe).
 *
 * `vanish-swap` (#2869, 진단 계측 전용) — 10/3 신당 고착 RCA의 "지상 attempt 0행" 블라인드
 * (RCA 하루 지연, R2 수동 소급 필요) 재발 방지. `meta.phase`로 두 전이를 구분한다:
 *   - `'estimate-null'`: `runTrainCodeTracking`의 `estimateBoardingLockArrival`이 null로 끝난
 *     상태(trainCode 피드 소실)의 전이. `meta.isNull`.
 *   - `'swap-attempt'`: `attemptVanishSwap`이 threshold 도달로 실제 시도된 tick의 결과(후보
 *     없음/ambiguity로 실패=true, 성공=false) 전이. `meta.failed`.
 * 둘 다 전이 시에만(#2073 quota 보호) append — 발사/advance/lock 판정에는 관여하지 않는다.
 *
 * `cooldown-bypass` (#2912) — POST /trips(index.ts)가 `#1425 trip-recently-ended` 쿨다운을
 * destination-recovery 좁은 예외(직전 종료 사유가 destination이고 incoming waypoints가 남아
 * 있을 때, `cooldownBypass.ts`의 쿼터 안에서만)로 우회해 재등록을 실제로 허용한 시점에 1건
 * append한다. `meta`에 `{ endReason, ageMs, waypointsRemaining, bypassCount }`를 싣는다 —
 * 우회가 남용/오작동(같은 token이 반복적으로 destination 종료→우회를 도는 패턴)인지 사후
 * 판정하기 위한 관측 전용 kind. fire/advance/lock 판정에는 관여하지 않는다.
 */
export type TripEventKind =
  | 'sync-received'
  | 'advance'
  // #3083 — 환승 체류(anchor ∧ 활성 lock 없음 ∧ 창 안) 중 `/boarding-lock/sync` 관측 전진이 cap으로 막힌 시점 1행.
  // station=관측역, meta={ requested, cappedTo }. sync 요청당 최대 1행(KV write 0). 관측 전용.
  | 'advance-held'
  | 'hydrate-issued'
  | 'trip-end'
  | 'consensus-confirm'
  | 'consensus-demote'
  | 'consensus-suppress'
  | 'cron-fire-attempt'
  | 'consensus-tick'
  | 'intermediate-route'
  | 'boarding-confirm-result'
  | 'transfer-advance'
  | 'leg2-estimate'
  | 'leg-boarding-prompt'
  | 'hop-end-prompt'
  | 'fallback-alert-fired'
  | 'fallback-implicit-ack'
  | 'leg-anchor-observed'
  | 'boarding-prompt-leg-mismatch'
  | 'route-signature-mismatch'
  | 'leg-resolve-attempt'
  | 'promotion-rejected-uncorroborated'
  // #3155 — sync 승격 시 열차가 이미 지난 중간역 waypoint를 건너뛴 수(`skipped`) / 지난 환승·도착 때문에 포기한
  // 경우(`blockedAt`). 건너뛰면 늦은 매역 push가 없어야 한다.
  | 'promotion-fastforward'
  | 'vanish-swap'
  // #3158 — lock 열차 번호 교체 1건마다 1행. meta={ source: 'timetable-successor'|'vanish-swap', from, to,
  // timetableFrom?(시간표 조회 원 열차) }. 관측 전용 — swap 빈도는 낮아(성수 renumber/소멸 시만) D1 quota 위험 낮음.
  | 'lock-reattach'
  | 'cooldown-bypass'
  // #3110 — 준비 알람(`maybeFirePrepareAlarm`, "곧 OO 도착") 평가 outcome. 발사/skip/rollback이
  // `log()`·`stats`뿐이라 10/21 trip 173 06:28:45 '곧 뚝섬' 조기 발사를 사후 판별할 수 없었다.
  // 이 함수는 tick마다가 아니라 waypoint advance 시점에만 호출되므로(트립당 정거장 수 이하)
  // outcome마다 1행을 append해도 D1 quota 위험이 낮다(KV write 추가 0, #2073/#3006).
  // `station`/`line`=직전 intermediate waypoint. `meta`={ outcome: 'fired'|'skipped'|'rolled-back',
  // reason?(skipped: sleep|dedup|not-preceding), targetStation?, targetKind?, pushId?, status? }.
  // 관측 전용 — 발사/advance 판정에는 관여하지 않는다.
  | 'prepare-alarm'
  // #3100 — 취침 알람 비기본 칸(N역 전, N이 기본 1역 전이 아닌 것)의 발사 outcome. 기본 칸은 행을 만들지 않는다
  // (D1 행 증가 0 — 기본 사용자는 관측 변화 없음). meta={ outcome: 'fired'|'rolled-back', remaining, targetStation,
  // targetKind, pushId?, status? }. 비기본 설정 사용자의 칸당 최대 1~2행이라 D1 quota 영향 미미(KV write 0).
  // 관측 전용 — 발사/advance 판정에는 관여하지 않는다.
  | 'sleep-alarm'
  // #3146 — 프롬프트 소리 채널 결정. LA alert 성공 시 일반 알림을 무음으로 보내는 정책의 튜닝용:
  // meta={ laOk, notificationSilenced, guard('none'|'stale'|'not-live'), laPushAgeMs(null=heartbeat
  // 미기록), laBudgetExceeded, laMs }. 프롬프트 발사당 1행(D1 quota 영향 미미, KV write 0).
  | 'prompt-sound-channel'
  // #2977 — LA push 채널 진단. `laPushDelivery=0/0`(backend LA push 시도 0건)이 #2667 fix
  // 이후에도 재발했는데(2026-10-13 실측) 어디서 끊겼는지 판정할 수 없었다: device 등록 결과는
  // `log.info`에만 남고(`liveActivityPushChannel.ts:201/209/141/128`), backend 저장 라우트
  // (`index.ts POST /live-activity/register`)에는 계측이 0건이었다.
  //
  // 이 kind 하나로 1차 분기가 갈린다 — 이벤트가 **0건이면 등록 경로 자체가 끊긴 것**이고
  // (#2667 fix inert 확정), 1건 이상이면 등록은 됐으니 원인은 push 단계로 좁혀진다. 후자의
  // 분기에 실제로 들어갔을 때 no-op 사유(`no-token` / `state-not-live`) 계측을 별건으로
  // 추가한다 — 지금 넣으면 소비처 없는 export가 된다.
  | 'la-token-register'
  // #3006 PR-0 — POST /position 1/20 샘플: 그 호출이 시도한 KV put prefix(`stages`)·lockState·appState 등.
  // 관측 전용, KV 접근 추가 0, UTC 일 300행 상한(`positionKvSample.ts`).
  | 'position-kv-sample'
  // #2985 — `trip_metrics` 행이 트립 전 구간을 덮지 못한 경우(window 절단) 1건. `started_at`과
  // `fired_count`/`suppressed_count`가 모두 `trip.createdAt`을 하한으로 쓰는데, 세션 교체
  // (`index.ts:1240` `{...incoming}`)가 그 값을 갈아치우면 앞 구간이 집계에서 통째로 빠진다.
  // 2026-10-13 실측: 23분 트립이 75초 1행으로 남고 `fired_count`가 3→1로 과소 보고됐다.
  //
  // **정책 변경이 아니라 계측이다** — 행의 값은 그대로 두고 "이 행을 믿을 수 있는가"를 밖에서
  // 판정 가능하게 만든다. 정상 트립에는 적재하지 않는다(노이즈 0).
  | 'metrics-window-truncated'
  // #3003 — `POST /trips` 결과. 이 라우트의 exit 분기 6개 중 D1에 남는 것이 `cooldown-bypass`
  // 1개뿐이어서, 2026-10-15 16:25~16:43 트립의 **400 × 30**을 D1으로 알 수 없었다(그 결과
  // `/live-activity/register` 404 × 12 → LA 영구 부재). 수치는 device 덤프에서만 나왔고
  // `console.log`는 `wrangler tail` 실시간 전용이라 사후 조회가 불가하다.
  //
  // `la-token-register`(#2977)와 같은 1차 분기 구조다 — `stored`가 0건이면 **등록 경로 자체가
  // 끊긴 것**이고, 있으면 원인은 그 뒤(LA 토큰/cron 발사)로 좁혀진다.
  //
  // 정책 변경이 아니라 계측이다 — 응답 코드/body/저장 동작은 그대로다.
  | 'trip-register'
  // #3007 — "정지 15분 = 종료 제안 시점"이 성립한 tick 1건. **계측 전용**(동작 변경 없음) —
  // LA 종료 제안(alert/버튼)은 PR-B에서 붙는다. 이 kind를 먼저 깔아 **실데이터로 발동 빈도를
  // 확인**한 뒤 UI를 만든다(inert wire 방지).
  //
  // 근거: 2026-10-15 14:04 트립이 `trip-end {reason:"expired"}`로 2시간 좀비로 살며 KV write
  // 쿼터의 60~72%를 먹었고 21:17부터 backend가 500으로 사망했다(#3006). 15분 종료 제안이
  // 있었다면 그날 소비가 ~27%였다.
  //
  // 중복 적재 없음 — `isEndPromptDue`가 "하한 D 만족 && 하한 D+1tick 불만족"으로 due tick
  // 하나만 true가 되게 무상태 판정한다(마커를 KV에 쓰지 않기 위한 설계).
  | 'end-prompt-due'
  // #3144 (v8 D3, ADR-043) — backend가 trip.boardingLock을 **부착한 모든 지점** 1건. 171 leg-1 backend
  // lock의 출처(sync/boarding-confirm/ register resolver / cron resolver)를 D1만으로 가릴 수 없었던
  // 계측 공백을 메운다. `meta`={ path: LockAttachPath, trainCode, hasResponseMarker }, `station`=
  // lock.segmentStations[0], `line`=lock.line. 목표(ADR-043): 사용자 행위 3경로(confirm/sync)와 그 파생(vanish-swap)
  // 외의 attach 0 — register/cron-leg1/cron-leg2는 hasResponseMarker=true일 때만 나타나야 한다.
  // 부착 시점 1회만 적재(tick 반복 아님) — KV write 추가 0.
  | 'lock-attached'
  // #3221 PR-3 — 탑승 LA push-to-start(`fireBoardingLaStart`) 발사 1건마다 1행. 질문(탑승/하차/종료 제안) 1건당 최대 1행이라
  // D1 quota 영향 미미, KV write 0. meta={ path: 'boarding-prompt'|'hop-end-prompt'|'end-prompt-due', phase, status(APNs HTTP),
  // ok, reason? }. "start 2xx면 일반 알림 무음"(#3146 기준) 판정의 사후 대조와 "split인데 start 0건" 감시용. 관측 전용.
  | 'la-boarding-start';

/** #3144 — `lock-attached` 이벤트의 부착 경로. 데이터 주도(신규 경로는 여기에만 추가). */
export type LockAttachPath =
  | 'register'
  | 'cron-leg1'
  | 'cron-leg2'
  | 'confirm'
  | 'sync'
  | 'vanish-swap'
  | 'register-incoming';

/** #2977 — `POST /live-activity/register` 결과. */
export type LaTokenRegisterOutcome = 'stored' | 'trip_not_found' | 'invalid_payload';

/**
 * #3003 — `POST /trips`의 결과 분기.
 *
 * `invalid_json`은 **포함하지 않는다** — body 자체가 파싱 불가라 `token_hash`를 만들 hash
 * 대상이 없다(#2977이 `invalid_payload`를 같은 이유로 제외한 선례). 따라서 이 kind의 이벤트가
 * 0건인 것은 "요청이 없었다"와 "JSON이 깨진 요청만 있었다"를 **구별하지 못한다** — 후자가
 * 의심되면 `wrangler tail`을 실시간으로 봐야 한다.
 */
export type TripRegisterOutcome =
  | 'stored'
  | 'invalid-trip'
  | 'rate-limited'
  | 'recently-ended-rejected';

/**
 * ADR-037 D2 (#2533) — intermediate waypoint 라우팅 분기 진단 표식.
 * `lockless` = C 토글 ON(`runLocklessIntermediate`), `no-intent` = C 토글 OFF(#2766 결정 D1 —
 * fire 시도 없이 완전 침묵). 데이터 주도 — scheduled.ts 하드코딩 분기 대신 본 유니온으로 구동.
 *
 * #2766 (결정 D1, 코드리뷰 후속) — 이 값의 라벨은 원래 `'consensus'`였다(제거된
 * `tryFireConsensusTrainLeg` 메커니즘 이름). 그 메커니즘이 완전 삭제된 뒤에도 D1
 * `trip_events`에 'consensus'라는 이름을 계속 새로 태우면, 나중에 이 kind를 조회하는 사람이
 * "consensus 엔진이 아직 관여한다"고 오독할 위험이 있어 `'no-intent'`로 개명했다. 개명 이전에
 * 이미 적재된 `meta.branch:'consensus'` 행은 히스토리로 그대로 남겨두고 마이그레이션하지
 * 않는다(append-only 로그 원칙, #2283).
 */
export type IntermediateRouteBranch = 'lockless' | 'no-intent';

/**
 * ADR-037 D2b (#2535) — 환승 waypoint advance 진단 표식(데이터 주도). `no-arvlcd` = 해당 역
 * arrivals에서 arvlCd 자체를 못 잡음(지하 침묵), `not-fires` = arvlCd는 잡았으나 ENTERING(0)/
 * ARRIVED(1)가 아님(아직 통과 전), `advanced` = waypoint를 실제로 통과. `lockless`(`runLocklessTransfer`)
 * 경로는 3값 전부, `lock-active`(`runTrainCodeTracking`) 경로는 `no-arvlcd`/`advanced` 2값만 쓴다
 * (lock 활성 경로는 arvlCd ENTERING/ARRIVED 확정 시에만 advance를 시도하므로 `not-fires` 중간
 * 상태가 없다).
 *
 * #2921 — `ambiguous-candidates`(direction-필터링된 pool에 서로 다른 trainCode의 fire
 * 신호가 2개+, 임의 선택 거부) 추가 — `lockless` 경로 전용(leg 전진 후보 제한은 lock-active
 * 경로를 건드리지 않는다, 거부 케이스 ⓔ). 시간창 게이트(거부 케이스 ⓑ)는
 * `runLocklessDestination`에만 적용되고 그 함수는 이 진단 표식을 쓰지 않는다(destination은
 * `stats.legAdvanceWindowBlocked`로만 관측 — 아래 참고).
 */
export type TransferAdvanceOutcome =
  | 'no-arvlcd'
  | 'not-fires'
  | 'advanced'
  | 'ambiguous-candidates';

/** `transfer-advance` 이벤트가 어느 코드 경로에서 관측됐는지(데이터 주도). */
export type TransferAdvancePath = 'lockless' | 'lock-active';

/**
 * ADR-037 D2c (#2537, #2693 분리) — `maybeFireLegBoardingPrompt`(scheduled.ts)의 fire/skip
 * 사유(데이터 주도). `trip.currentLegAnchor`가 없을 때 원인이 정상(아직 환승 전)인지 결함(환승
 * 후인데 anchor가 없음)인지를 `trip.route`의 총 환승 수 대비 `trip.waypoints`에 남은 `transfer`
 * kind 개수로 판별한다(#2693 — 이 함수가 이미 읽는 `trip` 필드만 사용, 신규 read 없음):
 *
 * - `no-anchor` = 아직 환승 전(leg-1, 정상) — 남은 `transfer` waypoint 수가 route의 총 환승
 *   수와 같다. 기존 의미 그대로 유지(회귀 비교용).
 * - `anchor-not-stamped-after-transfer` = 환승 후인데 anchor가 애초에 stamp되지 않음(#2693 갈래
 *   B) — SSoT의 직전 `legBoardingPromptOutcome`이 anchor 존재를 전제하는 값(`walk-gated`/
 *   `no-candidates`/`silenced`/`fired`/`anchor-lost-after-transfer`)이 아니었다.
 * - `anchor-lost-after-transfer` = 환승 후 anchor가 stamp된 적은 있으나 소실됨(#2693 갈래 A) —
 *   SSoT의 직전 `legBoardingPromptOutcome`이 anchor 존재를 전제하는 값이었다.
 * - `walk-gated` = `now < trip.legBoardingEligibleAt`(도보시간 미경과), `no-candidates` = Seoul
 *   API 열차 후보 0건, `silenced` = `evaluateHopEndPromptGates` dedup(이미 발사됨/silence 윈도우,
 *   두 사유를 단일 값으로 합산), `fired` = 실제 발사 성공.
 */
export type LegBoardingPromptOutcome =
  | 'no-anchor'
  | 'anchor-not-stamped-after-transfer'
  | 'anchor-lost-after-transfer'
  | 'walk-gated'
  | 'no-candidates'
  | 'silenced'
  /** #3200 — 응답한 열차(silencedTrainCode)와 같은/불명 선택이 무음 창에서 차단됨(열차 단위 무음). */
  | 'silenced-train'
  | 'fired'
  /**
   * #2801 — 후보는 있으나 전부 관측됐고(arvlCd non-null) 임박(0/1/2)/approaching(3/5, 3차
   * reopen) 모두 0건 → 조기 발사 억제.
   */
  | 'suppressed-not-imminent'
  /**
   * #2939 (10/9 실측 — lock 부착 후에도 재발사) — 해당 leg의 lock이 이미 실 trainCode를 가지면
   * 차단(`isLockActiveForLeg`). 전역 lock 유무가 아니라 **현재 leg/line에 해당하는** lock만
   * 본다 — leg-1 lock이 leg-2 프롬프트를 막는 과차단(10/9 `lockState=leg1` 상태)을 방지한다.
   * `PENDING` sentinel trainCode는 특정된 것으로 보지 않는다(ADR-036 보조 항목과 동일 정책).
   */
  | 'lock-already-attached';

/**
 * ADR-037 D2c (#2537) — `maybeFireHopEndPrompt`(scheduled.ts)의 fire/skip 사유(데이터 주도).
 * `silenced` = `evaluateHopEndPromptGates` dedup(이미 발사됨/silence 윈도우 합산), `fired` = 실제
 * 발사 성공.
 */
export type HopEndPromptOutcome = 'silenced' | 'fired';

/**
 * #2851 (진단 계측 only) — `maybeFireOriginBoardingPromptGpsFree`(scheduled.ts, leg-1 origin
 * 전용)의 fire/suppress 사유(데이터 주도). #2834의 candidateArvlCds/gateDecision 계측이
 * `recordLegBoardingPromptTransition`(kind='leg-boarding-prompt') 경유라 leg-2 전용이었던
 * 편측 계측 갭을 메운다 — leg-1 origin도 같은 kind로 기록하되 `meta.leg: 'origin'`으로 구분한다
 * (신규 kind 남발 금지, 이슈 spec).
 *
 * - `too-far` = #2653 거리 가드(`origin-too-far` / `origin-too-far-stale-anchor` 두 세부 사유를
 *   단일 값으로 합산 — 세부 사유는 기존 `log()`로 wrangler tail에서 구분 가능, D1 증설 없음).
 * - `silenced` = `evaluateBoardingPromptRepeatGate` dedup 또는 `onFireOnceSuppressed`(#2838,
 *   leg-2와 동일하게 두 사유를 단일 값으로 합산).
 * - `no-candidates` = Seoul API 열차 후보 0건.
 * - `suppressed-not-imminent` = #2801, 후보는 있으나 전부 관측됐고 임박(0/1/2)/approaching(3/5,
 *   3차 reopen) 모두 0건.
 * - `fired` = 실제 발사 성공.
 */
export type OriginBoardingPromptOutcome =
  | 'too-far'
  | 'silenced'
  /** #3200 — 열차 단위 무음 차단(leg-2 `silenced-train`과 동일 의미). */
  | 'silenced-train'
  | 'no-candidates'
  | 'suppressed-not-imminent'
  | 'fired';

export interface TripEventInput {
  /** trip token의 해시(hashTripToken 결과). 원본 token은 D1에 남기지 않는다. */
  tokenHash: string;
  kind: TripEventKind;
  station?: string;
  line?: string;
  meta?: object;
}

/**
 * trip_events에 이벤트 1건을 append한다.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param input - 이벤트 메타데이터.
 * @param now - 적재 시각(epoch ms). 기본값 Date.now() — 테스트에서 고정값 주입 가능.
 */
export async function recordTripEvent(
  db: D1Database | undefined,
  input: TripEventInput,
  now: number = Date.now(),
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        'INSERT INTO trip_events (token_hash, ts, kind, station, line, meta) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        input.tokenHash,
        now,
        input.kind,
        input.station ?? null,
        input.line ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      )
      .run();
  } catch (e) {
    console.warn(
      JSON.stringify({ msg: 'tripEventLog write failed', kind: input.kind, err: String(e) }),
    );
    // #2283 리뷰 P2-1 — D1 write 자체가 실패한 상황이라 D1 sink(trip_events)로는 escalate할 수
    // 없어 Sentry-only(d1ErrorLog.ts와 동일 패턴).
    captureXEvent('D1-write-failure', { table: 'trip_events', kind: input.kind, err: String(e) });
  }
}

/**
 * #3144 — `lock-attached` 1건 append. 모든 lock 부착 지점(`LockAttachPath`)이 이 함수 하나로
 * 같은 meta shape을 남긴다(사본 금지). `hasResponseMarker`는 caller가 `hasBoardingResponseForCurrentLeg`
 * 결과를 넘긴다(trips.ts가 이 모듈을 import하므로 순환 방지로 여기서 계산하지 않는다).
 */
export async function recordLockAttached(
  db: D1Database | undefined,
  input: {
    token: string;
    lock: { trainCode: string; line: string; segmentStations: readonly string[] };
    path: LockAttachPath;
    hasResponseMarker: boolean;
  },
): Promise<void> {
  const { token, lock, path, hasResponseMarker } = input;
  await recordTripEvent(db, {
    tokenHash: hashTripToken(token),
    kind: 'lock-attached',
    station: lock.segmentStations[0],
    line: lock.line,
    meta: { path, trainCode: lock.trainCode, hasResponseMarker },
  });
}

/** 보존 기간(ms). 7일 초과분은 cron cleanup이 삭제한다. */
export const TRIP_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 보존 기간(`TRIP_EVENT_RETENTION_MS`)을 초과한 trip_events 행을 삭제한다.
 *
 * 호출자(scheduled.ts)가 호출 빈도를 throttle한다 — 매 cron tick(1분)마다 부르면 D1 write
 * quota를 불필요하게 소진하므로, 시간 기반(예: 시 단위 1회) 게이트를 호출자 쪽에 둔다.
 *
 * @returns 삭제된 행 수. DB 미바인딩/실패 시 0.
 */
export async function cleanupTripEvents(
  db: D1Database | undefined,
  now: number = Date.now(),
): Promise<number> {
  if (!db) return 0;
  try {
    const cutoff = now - TRIP_EVENT_RETENTION_MS;
    const result = await db.prepare('DELETE FROM trip_events WHERE ts < ?').bind(cutoff).run();
    return result.meta?.changes ?? 0;
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'tripEventLog cleanup failed', err: String(e) }));
    // #2283 리뷰 P2-1 — cleanup(DELETE) 실패도 동일하게 Sentry escalation.
    captureXEvent('D1-write-failure', { table: 'trip_events', kind: 'cleanup', err: String(e) });
    return 0;
  }
}
