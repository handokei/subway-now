/**
 * #2302 — trip 종료 사유 어휘. device의 모든 종료 경로가 자기 사유를 들고 cleanup
 * chokepoint(`runTripBoundCleanups`)에 진입하고, 그 값이 `clearActiveTrip` →
 * `DELETE /trips/:token?reason=`까지 흘러 backend `trip_metrics.end_reason` /
 * `trip_events.meta.reason`에 적재된다(backend는 이미 읽고 있다 — `index.ts:3836`,
 * `liveActivity.ts:534`·`:542`, `d1TripMetrics.ts:93`).
 *
 * **왜 필수 인자인가**: 2026-10-15 실측에서 trip 생성 6초 후 `trip-end
 * {reason:"user-delete", endPath:"http-delete"}`가 찍혔는데, DELETE 발행 지점이
 * `tripBoundCleanups.ts`의 `clearActiveTrip` 한 곳이고 `?reason=`을 보내지 않아
 * **9개 종료 경로가 모두 같은 라벨**로 기록됐다. 그 중 4곳은 alarmLog에도 흔적을
 * 남기지 않아(logger.info만) 주체 사후 특정이 구조적으로 불가능했다. optional로 두면
 * 새 종료 경로가 추가될 때 조용히 누락되므로 필수로 둔다 — 누락이 컴파일 에러가 된다.
 *
 * **왜 새 어휘를 만들지 않는가**: 각 값은 그 경로가 이미 `releaseLock` 사유 또는
 * alarmLog reason으로 쓰는 문자열이다. 같은 사건이 채널마다 다른 이름으로 기록되는
 * 상황을 늘리지 않는다(기존에 `releaseLock`만 경로별로 5가지 사유를 쓰고 있었다).
 *
 * 값 자체는 telemetry 전용 — backend에 분기 로직이 없고 64자로 잘린다
 * (`index.ts:3836`). 따라서 추가 시 backend 변경은 필요 없다.
 */
export type TripEndReason =
  /** 사용자가 목적지를 해제했다(`setDestination(null)`) — "안내 종료" 버튼 포함. */
  | 'user-clear'
  /** 사용자가 다른 목적지로 전환했다(`setDestination(station)`) — 이전 trip 종료분. */
  | 'destination-switch'
  /** backend가 `trip-ended` silent push로 종료를 통지했다. */
  | 'silent-push-trip-ended'
  /** backend가 `status:'ended'`로 명시 확정했다(launch reconciliation / pull death backstop). */
  | 'backend-confirmed'
  /** 사용자가 알림의 [안내 종료] 액션을 직접 탭했다(#2428). */
  | 'user-end-trip-button'
  /** 사용자가 15분 종료 제안(`trip-end-offer`, #3007 A)의 [종료] 액션을 탭했다. */
  | 'user-end-offer'
  /** register effect의 "trip 없음" 안전망이 잔재를 회수했다(#2673/#2857 계보). */
  | 'hydration-safety-net'
  /** cold launch에서 silent push 30분 공백을 backend 무음으로 판정했다(#2045 Signal 4). */
  | 'launch-backend-silent-timeout'
  /** device self-end — fusion이 목적지 도착을 확정했다. */
  | 'trip-device-self-end-fusion-destination'
  /** device self-end — 경로 arc를 모두 소비했다. */
  | 'trip-device-self-end-arc-completion'
  /** device self-end — ETA backstop이 만료했다. */
  | 'trip-device-self-end-eta-backstop'
  /** FG 복귀 시 trip-ended sentinel을 소비해 store를 reset했다. */
  | 'sentinel-rehydration'
  /** trip 시작 9시간 경과 force-end backstop(#1573 T10). */
  | 'lifecycle-9h-force-end'
  /** "일시정지" 15분 경과 자동 종료 backstop(#2293). */
  | 'navigation-pause-auto-end';
