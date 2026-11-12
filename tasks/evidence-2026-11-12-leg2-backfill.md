# Evidence 2026-11-12 — leg-2 경계 / 목록 a 30일 backfill (#3357 항목 2)

조회 시각 2026-11-12 (read-only). 대상: dev 45282a89 (#3354 경계 소비, #3355 목록 a).

## 데이터 가용성 (먼저 읽을 것)

| 소스 | 범위 | 비고 |
| --- | --- | --- |
| D1 `trip_metrics` | 2026-06-26 ~ 11-12 (149행) | 최근 30일 39행 |
| D1 `trip_events` | **2026-11-06 19:07 ~ 11-12 (202행)** | 보존 ~6일. 30일 중 앞 24일의 sync-received/lock-attached 등 device 이벤트는 **소실** |
| R2 `seoul-capture` | 10-13 ~ 11-12 (757 key, active cycle만) | Seoul 피드만. 사용자 위치/탭은 없음 |
| mid-cycle(t+30) 응답 | **없음** | recorder는 1차 pass client만 감쌈 (#3358 참고) |

결론: "30일 backfill"의 device 관측 의존 항목은 실제로 **최근 6일(trip 8건)** 만 계산 가능하다.

## 요약 표

| 지표 | N | 결과 |
| --- | --- | --- |
| 30일 트립 (trip_metrics) | 39 | |
| 환승 트립 (line_list >= 2) | 28 | |
| 환승 + lock_attached=0 (lockless) | 14 | 13건은 device 이벤트 소실 -> leg-2 판정 **불가(미확인)** |
| 이벤트 보존 구간(11/06~) 트립 | 8 | |
| 그중 (a) lock 없이 환승역 관측된 트립 | 1 (11/12 b00dd879) | |
| (a) leg-2 프롬프트 발사 가능 | 1 / 1 | replay_20261112_leg2_transfer_boundary: head -> 어린이대공원 전환, leg-boarding-prompt(7호선) + la-boarding-start(boarding-prompt) 기록 |
| 사용자 탭(lock-attached path=confirm) | 6 (11/06~11/10) | 아래 표 |
| (b) 탭 시점에 탑승 열차가 이미 S를 출발한 건 | 0 / 6 | 6건 모두 탑승 열차가 S에 sts=1(도착) |
| 목록 a가 실제 탑승 열차와 일치 | 0 / 6 (해당 없음) | 탑승 열차가 승강장에 있으면 a 슬롯의 대상이 아니다 |
| 목록 a 오선택 (탑승 열차가 이미 출발했는데 다른 열차를 a로) | **0** | 정의상 (b) 건이 0이라 측정 불가 |
| a가 비어 있지 않았던 건 | 2 / 6 | 아래 표: 탑승 열차와 다른 실재 열차 (오선택 아님, 정의 참고) |

## 탭별 상세 (justPassedFromPositions, 탭 직전 R2 position 스냅샷, 스냅샷 나이 6~10s)

| 탭(KST) | 역/선 | lock 열차 (스냅샷 위치) | a | a 위치 | 비고 |
| --- | --- | --- | --- | --- | --- |
| 11/06 19:08:58 | 건대입구/7 | 7298 (건대입구 sts1) | 없음 | - | |
| 11/07 10:36:54 | 용마산/7 | 7095 (용마산 sts1) | 없음 | - | |
| 11/07 10:43:52 | 군자/5 | 5056 (군자 sts1) | 없음 | - | |
| 11/07 15:47:53 | 경복궁/3 | 3208 (경복궁 sts1) | 없음 | - | |
| 11/10 19:27:56 | 성수/2 | 3358 (성수 sts1) | 2410 | 건대입구 sts2 | 다른 실재 열차 (S+1 구간) |
| 11/10 19:34:54 | 건대입구/7 | 7312 (건대입구 sts1) | 7310 | 어린이대공원 sts2 | 다른 실재 열차 (S+1 구간) |

## 정의 / 해석 주의

- "오선택"은 **탑승 열차가 이미 S를 출발했는데 a가 다른 열차인 경우**로 정의했다. 위 6건은 전부 탑승 열차가 승강장에 있던 탭이라 a 슬롯의 본래 대상이 아니며, a=2410/7310은 실제로 방금 지나간 열차다. 즉 6건으로는 a 정확도를 증명도 반증도 못 한다.
- (b) 케이스(출발 후 트립 생성)의 실측은 11/12 b00dd879 한 건(2336)뿐이고 #3355 replay가 이를 이미 커버한다. 사용자 탭 N이 6이고 (b)=0이므로 **추가 실측 근거는 이 backfill에서 나오지 않았다**.
- `trip_metrics.lock_attached`는 11/12 b00dd879 트립에서 1인데 `trip_events`에 `lock-attached` 행은 0이다(D1 lock 이벤트 0). 감시 규칙(항목 3)은 이 컬럼이 아니라 이벤트 행을 근거로 삼는다.

## 재현

- D1: `trip_metrics`(started_at > 1791879721938) 집계, `trip_events`에서 kind IN (lock-attached, sync-received, trip-register, trip-end, ...) 조회.
- R2: `/admin/seoul-capture/keys?from=&to=`로 탭 시각 -130s~0 key 목록 -> `wrangler r2 object get --remote` -> `parseSeoulCaptureCycle` -> `SeoulArrivalClient.fetchPositions` -> `anchorFromSegment` + `justPassedFromPositions(anchor, positions, tapMs)`.
