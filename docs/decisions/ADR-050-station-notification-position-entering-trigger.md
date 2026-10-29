# ADR-050: 매역 알림 트리거 = 진입(position sttus0 또는 arrivals 0) 또는 도착 중 먼저, 역당 1회

- **상태**: **채택 (Accepted)** — 2026-10-28 사용자 결정 A (#3223), 구현 PR 동봉
- **관련**: #3223, #2506(CLOSED, "도착 1개"), #2571(진입 또는 도착 중 먼저), ADR-040(역 통과 알림 단일 발사 수렴), ADR-042(약속 재정의), `tasks/plan-2026-10-28-3223-position-enter.md`(v2/v2.1)
- **검증 상태 표기**: 확인(코드 `file:line` / 10/28 R2 캡처 / D1 `trip_events`로 확인) / 추정(미검증)

## 배경

10/28 매역 알림은 열차가 역에 **도착한 뒤 47~64초** 지나서 울렸다(진입 대비 도착 확정 13~21초 + 서울 피드 반영 36~85초 + 30초 주기 + APNs 1~6초).

- arrivals 피드의 arvlCd 0(진입) 행은 이미 발사 조건이다. 그러나 이 행은 실제 도착보다 60~87초 늦게 나타난다(10/28 확인).
- position(realtimePosition) 경로는 목표역에서 **`trainSttus===ARRIVED`만** 도착으로 본다(`estimateArrivalFromPosition`). 진입(sttus0)은 가장 먼저 피드에 나오지만 발사 조건이 아니었다.
- 10/28 R2 캡처(메인 tick) 기준 intermediate 매역 6건 중 3건(군자AM −30s, 어린이대공원PM −29s, 중곡PM −60s)은 진입 tick이 노출돼 당겨진다. 2건(어린이대공원AM, 군자PM)은 진입이 tick 사이에 끝나 그대로다. 성수AM은 캡처에 3013 행이 없어 측정할 수 없다.
- 진입 후 정차가 길어지는 경우는 종점/번호 변경역뿐이다. 경로 중간 역에서 길게 선 사례는 10-19 2호선 3047 **성수** 451초 1건이다(번호 변경역, `data/line2RenumberSuccessors.json` `meta.renumberStation`).

## 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
| --- | --- | --- |
| ADR-042 결정 1 매역 알림 약속 "해당 역 재차 중 ~ 늦어도 다음 역 도착 전"(`ADR-042-promise-redefinition-and-fire-authority-moratorium.md:20`) | 창 **시작점** | **재배정**: 시작점을 "해당 역 **진입**(sttus0이 피드에 노출된 첫 tick)"으로 옮긴다. 근거는 2026-10-28 사용자 결정 A(#3223). 창 끝("다음 역 도착 전")과 `:23` "새 약속 창 밖만 결함"은 유지한다. 진입보다 먼저 발사하면 결함이다 |
| #2506 "도착 1개"(이슈, ADR 없음) | 개수 | 유지: 역당 1회. 진입 선발사 + 도착 후발사 2개가 아니라 발사 시점만 앞당긴다 |
| #2571 "진입 또는 도착 중 먼저"(`scheduled.ts` 주석, ADR 없음) | 트리거 출처 | 확장: 진입 출처에 position sttus0을 더한다(arrivals arvlCd 0만 있던 것). 그 결정의 "먼저 잡힌 것" 원칙을 그대로 따른다 |
| ADR-040 단일 발사 수렴 | 경로 수 | 유지: 새 경로를 만들지 않는다. `stationPassedFiredKey` 공용 dedup과 역 단위 collapseId가 그대로 역당 1개를 보장한다. 진입 발사는 mid-cycle 발사기를 공용 헬퍼로 빼서 쓴다 |
| `docs/agents/invariants.md` "advance 미성공 시 fire path 진입 금지"(`scheduled.ts` `fireArvlCdStationPush` 계약) | 적용 범위 | **범위 명시**: 이 불변식은 `fireArvlCdStationPush`에만 해당한다. advance 없이 발사만 하는 경로는 **mid-cycle과 position 진입 2곳**뿐이고, 둘 다 `sendStationPassedFireOnly`를 공유한다. 진입 경로는 trip/SSoT를 mutate하지 않는다 |

## 결정

1. **intermediate 매역 알림은 열차 위치가 목표역에 진입(trainSttus 0)으로 노출된 첫 tick에 1회 발사한다.** 도착 확정(arvlCd 0/1, position ARRIVED/지나침)이 먼저 잡히면 그 시점에 발사한다(진입 창을 건너뛴 경우의 폴백). 어느 쪽이든 역당 1회다.
2. **발사 시점만 앞당긴다.** waypoint advance, 취침 N역 전 알람, 준비 진동, transfer-release·hop-end 프롬프트, trip-end, LA 갱신은 도착 확정 그대로다(U2).
3. **적용 범위는 intermediate만이다.** transfer와 destination은 현행 도착 시점을 유지한다(U1). 번호 변경역(2호선 성수)은 진입 트리거에서 제외한다(U3, 데이터 `meta.renumberStation` 주도 — 하드코딩 아님).
4. **취침 mute는 진입 경로도 공유한다.** intermediate 매역 알림은 취침 모드에서 무음이다(`isSleepMutedStationNotif`).
5. **KV 쓰기 순증 0.** 진입 발사의 쓰기는 공용 dedup 키 PUT 1건이다. trip과 SSoT는 mutate하지 않는다. D1 `cron-fire-attempt` meta에 `path:'position-entering'`을 남겨 도착 시점 발사와 구분한다.

acceptance 문구 정정(plan v2-1 U5): "각 역 = 진입 첫 tick"이 아니다. **진입 tick이 노출된 intermediate 역만** 그 첫 tick에 발사하고, 노출되지 않은 역은 현행(도착 첫 tick)과 같거나 빠르다. 어떤 역도 sttus0 첫 노출 tick보다 먼저 발사하지 않는다.

## 대안 (기각)

| 옵션 | 기각 이유 |
| --- | --- |
| ③ 폴링 주기 단축(mid pass를 15초 등으로) | 진입 창이 짧아(중앙 19초) 30초 주기로는 모델상 34.9~86.8%를 놓친다. 주기를 줄이면 개선되나 Seoul 호출이 늘고 한도 근거가 저장소에 없다(B1). 효과는 측정할 수 없다(캡처가 메인 tick뿐). 본 결정 배포 후 D1 진입 발사 비율 1주 측정 뒤 별도 이슈로 판단한다 |
| ④ 진입을 도착으로 취급(상태 경계 이동) | advance·취침 알람·준비 진동·환승 lock 해제·trip-end·LA가 모두 13~21초 당겨진다. 성수 같은 정차에서는 상태가 미리 넘어간다. 사용자 결정(발사 시점만) 범위를 넘는다 |
| 예측 기반 발사(ETA 보간) | 사용자 결정으로 제외 |
| transfer/destination 포함 | U1 결정으로 제외. transfer는 T7 SSoT 게이트(`transferDestinationGate`)가 필요해 별도 이슈 |

## 결과

- 진입 tick이 노출된 intermediate 역은 알림이 29~60초 빨라진다(10/28 replay). 노출되지 않은 역은 변화가 없다.
- 도착 tick은 advance만 하고 매역 push를 다시 쏘지 않는다(공용 dedup).
- 진입 발사 직후 같은 역 도착까지 120초를 넘는 건은 오발사 후보로 측정한다(D1 `path:'position-entering'` 행 ts vs 같은 역·trip의 dedup/advance 행 ts).

## 리스크

- 진입 후 길게 정차하는 역(종점, 번호 변경역)에서는 알림이 일찍 울릴 수 있다. 번호 변경역은 제외했고, 종점 측정값은 출발 종점(방화, 불암산)뿐이라 경로 중간 intermediate에서는 10/28 기준 오발사 0건이다(진입 4건 모두 13~21초 뒤 같은 역에 도착).
- 알림이 LA보다 최대 약 60초 먼저 다음 역으로 넘어간다(mid-cycle 발사와 같은 구조적 차이가 커지는 것).
- 이 결정은 차단 가정에 의존한다: 번호 변경역이 `RENUMBER_STATION` 하나라는 것. 다른 노선에 번호 변경이 생기면 그 데이터에 추가해야 제외된다(추정 — 현재 데이터는 2호선 성수 1곳).

## U1 포함으로 개정 (2026-10-29 사용자 결정: "진입 시점으로 진행해야 한다")

초안(결정 3)은 transfer·destination을 도착 시점으로 남겼다(U1 제외). 2026-10-29 사용자 결정으로 **U1 = 포함**으로 바꾼다. 이 절이 결정 3과 대안 표의 "transfer/destination 포함" 행을 대체한다.

### 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
| --- | --- | --- |
| 본 ADR 결정 3 "적용 범위는 intermediate만" | 적용 kind | **대체**: intermediate·transfer·destination 모두 진입 첫 tick에 **알림 push만** 1회 발사한다. 번호 변경역 제외(U3)는 유지 |
| 본 ADR 결정 4 "취침 mute는 진입 경로도 공유(intermediate 매역 무음)" | 취침 | 유지: mute는 `isSleepMutedStationNotif`(#3100, intermediate 한정) 그대로라 transfer/destination 진입 발사는 취침 모드에서도 발사된다(도착 시점 발사와 동일) |
| 본 ADR 대안 표 "transfer/destination 포함 — U1 결정으로 제외, T7 SSoT 게이트 필요" | 게이트 | **T7 적용으로 해소**: 진입 발사도 `evaluateTransferDestinationGate`(`transferDestinationGate.ts`)를 arvlcd 경로와 같은 입력(`isDeviceSyncStale`, 기본 `maxFreshCycles`)으로 거친다. 새 임계 없음. 차단 시 push 0 + `transfer/destination gate blocked` 로그·`transferDestinationGateBlocked` 통계·D1 `skipped-reason`(메인 pass), dedup 키는 stamp하지 않아 도착 시점 폴백은 그대로다. advance·transfer-release·hop-end·취침 알람·LA·trip 종료는 여전히 도착 시점(U2) |

### 중복 방지(코드 확인)

진입 발사는 `stationPassedFiredKey`(경로 무관 공용 마커)를 stamp한다. 도착 경로 3곳(`fireArvlCdStationPush`, `fireVanishFallbackStationPush`, sync-skipped 발사)은 모두 push **직전** 이 키를 GET해 있으면 push만 건너뛰고 return한다. advance(`advanceTripPosition` / `advanceBoardingLockWaypoint`)는 push 이전·이후와 무관한 별도 호출이라 계속 실행된다. 따라서 도착 tick은 알림 0건 + advance·transfer-release·trip 종료 그대로다.

### 리스크 추가

- 정지 trip "환승임박" 오발사(N9, 6/19) 방어를 위해 transfer/destination 진입 발사에는 T7 게이트를 **적용**한다(ADR-010: FP=miss 동급). SSoT 부재(legacy)는 arvlcd 경로와 같이 통과한다. mid pass는 진입 후보일 때만 SSoT를 1회 read하고, trip/SSoT를 쓰지 않으려 D1·SSoT 마커 기록 없이 로그만 남긴다. 10/28 replay 건대입구 06:34:46은 SSoT가 직전 hop(어린이대공원)이고 마지막 advance가 60초 전이라 통과한다.
- 진입 후 도착까지의 지연이 긴 종점(destination)에서는 알림이 일찍 울릴 수 있다. 측정은 D1 `path:'position-entering'` 행 대비 trip 종료 행 간격으로 1주 본다.
