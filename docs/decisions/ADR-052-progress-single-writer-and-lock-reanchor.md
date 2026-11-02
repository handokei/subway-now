# ADR-052: 진행 위치(progress)의 작성자는 cron 하나, lock 시작 시 노선 원본으로 재고정한다

- **상태**: **Proposed** (2026-11-03)
- **관련**: #2308(재오픈), #3083, #3006, ADR-042 결정 1, ADR-010, `tasks/plan-2026-11-02-reregister-storm-progress-authority.md`(v3)
- **검증 상태 표기**: 확인(코드 `file:line` / D1 `trip_events` / R2 캡처 / replay로 확인)

## 배경

- 10/31 09:55~09:59(lock 7077): cron이 강남구청을 전진시킨 직후 같은 세션 재등록(`POST /trips`)이 KV에서 낡은 trip을 읽어 그대로 다시 써서 cron이 강남구청을 4번 소비했다(D1 `prepare-alarm` 1915/1921/1926/1929). 열차는 09:57:13에 학동에 도착했는데 학동 알림은 논현 진입 뒤(09:59:46)에 나갔다(ADR-042 결정 1 "늦어도 다음 역 도착 전" 위반).
- 11/02 19:44~20:02(lock 7320): lock 전 lockless cron이 어린이대공원을 소비(D1 1984)하고, 재등록이 lockless progress를 `headHopIndex`로 적용해 군자를 건너뛰었다(D1 1985 head 군자 → 1987 head 중곡). device waypoints에는 hopIndex가 없어 `validateTrip`이 배열 위치로 다시 매기기 때문에 hopIndex는 head 식별자가 못 된다(확인: 코드 재현 + replay). lock 7320의 segment가 `[건대입구, 중곡, 용마산]`으로 잘려 어린이대공원·군자 매역이 0건이었다.
- 두 사고 모두 whole-trip replay로 재현된다: `replay_20261031_reregister_storm`, `replay_20261102_lockless_jump_leg2`.

## 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
|---|---|---|
| #705 / #2308(구) `applyProgress`가 register에서 hopIndex로 slice | 진행 위치 작성 권한 | **대체** — register는 lock·lockless 트립의 진행 위치를 쓰지 않는다. head 식별은 내용 키(`waypointSignatureKey`) |
| #2645 sync advance + `maybeMirrorLockSyncProgress` | 진행 위치 작성 권한 | **재배정(b2)** — sync는 trip.waypoints만 전진, progress mirror 제거. sync-mixed는 `completeWaypointAdvance(…,{mirrorProgress:false})` |
| #1285 lockless progress(`mirrorLocklessProgress`) | 진행 위치 작성 권한 | **폐기** — 유일한 독자였던 register 적용이 사라져 orphan, 앞쪽 점프의 원인 경로였다 |
| #903 Seam G / #2699(subsurface 전환 → 즉시 재등록) | device 재등록 트리거 | 본 PR 범위 밖(PR-1에서 별도 처리). 본 ADR은 영향 없음 |
| ADR-042 결정 2(발사 권위 모라토리엄) | 발사 권위 | **무변경** — 발사 권위는 backend 그대로, 이 ADR은 발사 근거 위치를 바꾸지 않는다 |
| ADR-042 결정 1(매역 = 늦어도 다음 역 전) | acceptance | **채택** — acceptance 기준 |
| ADR-010(오발사·누락 동급) | 게이트 | 재고정은 앞으로 잘린 경우·노선 일치·routeWaypoints 존재일 때만(fail-closed), 맞춤은 앞으로만 |
| ADR-031(per-trip DO 직렬화, Proposed) | 쓰기 직렬화 | **무변경·미채택** — lost-update 근절은 ADR-031 몫. 본 규칙(작성자 1)은 DO cutover 시 DO가 그대로 넘겨받는 형태 |
| memory `decision_lock_only_alerts.md`(lock 없음 = 알림 없음) | 범위 | 충돌 없음 — lock 트립 전용. lockless cron 전진 철거는 K5(#2926) 몫으로 남기고, lock 트립으로의 누수만 재고정으로 막는다 |
| memory `decision_ARCHITECTURE_COMMITTED_server_track_visible_push.md` | 추적 권한 | **강화** — 진행 위치 권위를 backend progress로 일원화 |

## 결정

1. **R2 규칙**: lock 트립의 "어디까지 왔나"는 `progress:<token>`이 권위다. 작성자는 cron 경로의 `mirrorProgress` 하나다. `POST /trips`는 progress를 읽지도·적용하지도·지우지도 않는다(세션 경계에서만 삭제). `/boarding-lock/sync`는 trip.waypoints만 전진시킨다.
2. **내용 키**: progress에 `headKey`(`waypointSignatureKey`)를 stamp하고, cron이 `pickActiveWaypoint` 직전에 lock 활성 trip의 waypoints를 progress head까지 **앞으로만** 맞춘다. LA·추적 기준값은 progress 값으로 덮는다. 바뀌면 `putTrip` 1회 + D1 `progress-reconcile`.
3. **lock 시작 재고정**: `Trip.routeWaypoints`(세션 노선 원본)를 새 세션 register가 1회 채우고 같은 세션은 보존한다. lock epoch 시작(이 lock의 progress 없음)에서 head가 탑승역 다음보다 앞서 잘려 있으면 `routeWaypoints`로 탑승역 다음부터 waypoints·segmentStations를 다시 깐다. D1 `lock-reanchor`.

## 대안 (기각)

- sync가 progress를 계속 쓰되 단조 가드(max): 가드 기준 읽기가 낡을 수 있고 KV CAS가 없다.
- 재등록의 hopIndex 적용을 고쳐 유지: device waypoints에 hopIndex가 없어 구조적으로 불가능.
- per-trip Durable Object 직렬화: ADR-031 범위, 이번 변경의 선행이 아니다.
- lockless intermediate 전진을 멈춤: destination·transfer 판정이 head 도달을 전제해 lockless 도착 종료·leg-2 앵커 stamp가 같이 멈춘다.

## 결과

- 재등록이 cron 전진을 되돌리지 못하고(되돌려도 다음 tick 맞춤이 복구), 같은 역을 두 번 소비하지 않는다.
- lock이 붙을 때 지워진 역(탑승역~head 사이)이 복원돼 매역 알림이 나간다.
- 배포 직후 기존 progress에는 `headKey`가 없어 맞춤은 no-op이다(현행과 같은 무보호). 활성 lock 트립의 다음 `mirrorProgress`가 1회 `headKey`를 쓴다.
- KV: register progress 읽기·삭제 제거, sync mirror 제거, lockless mirror 제거(감소). cron 진입 progress 읽기는 같은 tick mirror가 재사용하고 재사용 못 한 읽기는 `progressEntryReadUnused`로 집계한다.

## 리스크

- 맞춤은 전파 지연(> cacheTtl 30s)이 있으면 한 tick 늦다. 안전망(위치 따라잡기)은 PR-3 범위다.
- 재고정은 `routeWaypoints`가 있는 신규 세션부터 동작한다(구 trip은 fail-closed).
- 기존 HTTP 경로(/position, dismiss, confirm, LA register)는 낡은 waypoints를 다시 쓸 수 있으나 다음 cron 맞춤이 복구한다.
- `prepare-alarm` D1 행은 #2510(11/03)으로 일반 모드에서 더 이상 기록되지 않아, 재소비 감시 술어(PR-0)가 이 신호를 못 본다 — 별도 후속 필요.
