# ADR-044 — fused 현재역 후보 점수는 경로 leg 방향과 반대인 열차 신호를 쓰지 않는다 (+ 정지 fix 유지는 PR-2에서 덧붙임)

- 상태: Proposed (2026-10-28) — **방향 필터(PR-2D)만 본 ADR에 기록됨.** 정지 fix 유지(hold)·G2·D2·L 단조·BG 주입·tier8 결정은 PR-2가 같은 ADR에 이어서 덧붙인다.
- 관련: #3191, #2696, #2944, ADR-039, ADR-042, `tasks/plan-2026-10-28-3191-pr2-final.md`(로컬)

---

## 배경

2026-10-28 06:26:49 trip 179(용마산(7)→건대입구→뚝섬(2)), 사용자는 지하에서 용마산 승강장에 있었고 현재역이 중곡으로 튀었다.

- 사용자 열차 7035(석남행, updnLine 1)는 용마산 sttus0(진입, 80점).
- **반대 방향** 열차 7012(도봉산행, updnLine 0)는 중곡 sttus1(도착, 100점) — R2 `seoul-capture/2026-10-27/1793136405264.json`(06:26:46 cycle).
- `pickFusedStation`은 후보마다 `max(arrival, position)` 점수를 구하고 열차 방향을 보지 않는다(arrival은 up+down 합산, position은 역명이 같은 열차 전부). 7012의 100점이 7035의 80점을 이겼다(덤프 W 06:26:49 `enter 7-016 position/arrival-arriving`).
- 이 사례는 정지 fix 유지(hold)로 고칠 수 없다 — 사용자가 지하라 기압 이벤트가 lookback 안에 있어 hold가 꺼진다(PR-2 plan §0).

## 이 ADR이 수정·대체·모순하는 결정

- **#2696 / #2944 (lock leg 방향 규칙, issue 결정)**: 둘 다 "lock이 추적 중인 line의 후보 열차" 규칙이었다(`direction===null → 후보 없음, 양방향 병합 금지`). 본 ADR은 같은 규칙을 **lock 유무와 무관하게 route가 있는 fused 후보 점수**로 확장한다. 재배정 축: 방향 필터 적용 범위 = "lock leg의 position-train enumeration"에서 "route(arc)가 있는 모든 fused 후보 점수"로.
- **route 없음(trip 없음)은 대상이 아니다.** 방향을 정의할 수 없으므로 필터를 적용하지 않는다(현행 유지). #2696·#2944는 trip leg 규칙이므로 이 셀을 포함하지 않는다.
- **ADR-039 (GPS 권한 경계)**: 변경 없음. 본 필터는 GPS를 쓰지 않는다 — 경로 arc에서 유도한 방향만 쓴다. 표시 축 권한 재배정 없음.
- **ADR-042 (발사 권위 모라토리엄)**: 변경 없음. 발사 경로(backend/cron)는 건드리지 않는다. 본 ADR은 device fused **표시** 역 결정에만 적용된다. device fused 역은 sync 관측역 입력이 되므로(#3222) backend `restrictArrivalsByLegDirection`과 방향이 어긋나면 안 된다 — parity 테스트로 강제한다.
- **미커버 셀(선언)**: ① lockless tier6(position-train)는 `gps.userLocation` 최근접 역의 열차를 고르며 이 PR에서 방향 필터를 넣지 않는다(출력 변화를 관측할 수 없음) ② 지하·같은 방향 열차의 전역 코드 4/5가 후보역 점수로 쓰이는 문제(17:24:06 어린이대공원 오승리, 방향 필터로 바뀌지 않음) ③ 지하·route 없음.

## 결정

1. `FusionCandidate.direction`을 추가한다. 값은 `'up'|'down'`(필터), `null`(route 있는데 방향 미해결 → fail-closed, 모든 신호 점수 0), `undefined`(route 없음 → 미적용).
2. arrival은 해당 방향 리스트만, position은 `updnLine===(up?0:1)`인 열차만 점수에 넣는다. `updnLine -1`(파싱 실패)은 제외한다(`pickCandidateTrains.ts`와 같은 규약).
3. 방향은 `legDirectionByLine(arcStations)`로 노선 run 단위 산출한다(`tripDirection.ts`, `resolveTripDirection`과 같은 극성 규칙 공유). run 길이 1이거나 같은 노선의 run끼리 방향이 다르면 그 노선은 미해결(null).
4. 점수>0인 반대 방향 신호가 빠지면 후보·종류당 1건을 기존 reason `candidate-opposite-direction`으로 candidateRejectBuffer에 적재한다(`signal: arrival|position`). 0점은 적재하지 않는다. 같은 reason은 10초 윈도우로 집계된다.

## 대안 (기각)

- **정지 fix hold로 해결**: 06:26:49는 지하라 hold 조건(기압 이벤트 lookback)이 꺼져 있다. 기각.
- **tier6(lockless position-train)에도 방향 필터 적용**: 반대 방향 열차가 GPS 최근접역에 있어 tier6가 오채택한 실측 행을 찾지 못했다. 관측할 수 없는 변경은 범위에서 뺀다.
- **route 없음에도 직전 방향 추정 적용**: 근거 없는 방향을 만든다. 기각.
- **정확성 게이트 보강(신규)**: 방향 외에 "열차가 사용자 쪽으로 오는 중인가"(진행 방향 vs 사용자 위치) 판정을 더하는 안. 현재 코드에 없고 신규 작업이 필요하다(17:24:06 미커버 셀의 후속 후보).

## 결과

- 10/28 06:26:49 입력(R2 원문 replay)에서 현재역이 용마산으로 유지된다(source `position`).
- route가 있는 trip에서 반대 방향 열차의 도착/위치 신호가 fused 현재역을 끌어가지 않는다.
- Debug 'Candidate rejects'에 fused 경로의 반대 방향 제외가 `signal` 태그와 함께 보인다.

## 리스크

- `updnLine` 인코딩 오해석 시 정상 열차를 전부 제외할 수 있다 — 52쌍 실측(`memory/reference_seoul_updnline_format_differs`)과 R2 원문 replay로 고정.
- 순환선 양끝점 등 방향 미해결 노선은 fail-closed로 신호 점수 0(GPS 최근접으로 후퇴). 정체가 가짜 진행보다 낫다는 #3083 원칙과 정합.
- device/backend는 입력 차이(leg≥2 앵커 전 origin, run 길이 1)로 한쪽만 null일 수 있다 — 각자의 fail-closed가 자기 점수에만 작용하므로 허용하고, 둘 다 non-null이면 같은 방향임을 parity 테스트로 강제한다.

---

# 정지 fix 유지(hold) — PR-2 (#3191, 2026-10-29)

위 방향 필터(PR-2D)는 수정하지 않는다. 아래는 PR-2가 같은 ADR에 덧붙이는 결정이다.

- 상태: Proposed (2026-10-29)
- 관련: #3191, #2713(ADR-039 1단계), #2876, ADR-039 §A/§D, ADR-015 §3, `tasks/plan-2026-10-28-3191-pr2-final.md`(로컬), `tasks/plan-2026-10-22-s1-sagajeong-surface-stale-gate.md`(v5, 로컬)

## 배경 (hold)

지상에서 정지하면 iOS가 fix를 15초 넘게 새로 주지 않는다. #2713은 15초 넘은 fix를 결정 tier 거리 게이트 입력에서 빼는데(`decisionUserLocation=null` -> 거리 sanity 자체가 꺼진다), 그러면 정지한 사용자의 현재역 후보를 거리로 거부할 수단이 사라진다.

- 10/21 T·10/18 A (집, 용마산 227m): fix 21:25:25 이후 14초가 지나자 사가정(593m) position/arrival 신호가 용마산을 이겼다.
- 10/19 D (뚝섬 사무실, 뚝섬 161m, trip 없음): 17:44~17:46 fix가 96초 묵자 서울숲(분당선, 471m)이 tier8 detection-fused로 채택됐다.

사용자 원칙(10/22, 그대로): "정지해 있으면 그 GPS를 가지고 있으면 되잖아".

## 이 ADR(PR-2 부분)이 수정·대체·모순하는 결정

- **#2713 / ADR-039 1단계 ("15초 넘은 fix는 결정 tier에서 제외")**: 재배정 축 = *fix 나이* 하나로 결정 tier 입력 자격을 정하던 것을 *"L 이후 이동 증거 + 지상 정지 품질"*로 정한다. 나이는 이동 증거가 아니다. 이동 증거가 없고 L이 지상 정지 fix이면 15초가 지나도 L을 쓴다. 증거가 생기면(새 fix / 기압 하강 / 기압 ΔP 이벤트) 현행(15초 규칙)으로 돌아간다. ADR-039 §A(GPS 표시 권한)는 그대로고 §D(결정 권한 제외)의 "stale" 정의만 좁힌다.
- **#2876 (tier8 좋은 GPS 가드)**: 가드의 "fix age <= 30s" 조건에 hold를 OR로 더한다. 가드 자체의 조건(accuracy<=50, 노선·거리 불일치)은 그대로다.
- **ADR-015 §3 (strong A 정확도 30m)**: hold의 정확도 임계는 같은 30m를 쓴다(새 임계 도입 아님). 다만 *acc<=30 = 지상 품질*이라는 PR-1 전제는 W 덤프에서 반증됐다(지하 승강장 acc 24~27 fix가 hold=1, L597-607) — 그래서 지상 판별자를 추가한다(아래).
- **memory `feedback_no_gps_for_decision` 1·3번 (GPS는 결정 권한 없음 / 신선할 때만)**: hold는 GPS를 *제외 규칙의 입력*으로 계속 쓰는 것이지 *현재역을 선택*하는 데 쓰지 않는다. 4번("지하/mixed/BG는 GPS 제외")은 **G2로 지하를 제외**하고, **BG는 v5에서 FG watch가 꺼진 동안 BG task fix를 L로 주입**하므로 BG 재배정을 명시한다: BG에서도 "새 fix 없음 = 이동 없음"이 성립하는 경우(지상·정지·기압 관측 중)에만 L을 쓴다.
- **ADR-041/042**: 변경 없음. hold는 device fused **표시** 결정에만 영향을 주고, 발사 경로(backend/cron)는 건드리지 않는다. lock 있는 trip은 범위 밖(`stationaryHoldBlock`의 `lock`).
- **`location.ts` 15초(`GPS_QUALITY_GATE_MAX_AGE_MS`)**: 값은 그대로, 의미만 "hold 아닌 경우의 신선도"로 좁아진다.
- **sync 게이트(#3222)**: `useBoardingLockSync.ts`는 건드리지 않는다. device fused 역이 sync 관측역 입력이 되므로(HomeScreen) hold가 바꾸는 표시역은 #3222 소관의 하류에 영향을 줄 수 있다 — 별도 추적.
- **미커버 셀(선언)**:
  - 지하·정지·lock 없음·같은 방향 열차의 전역 코드 4/5(W 17:24:06 어린이대공원 오승리) — G2로 hold에서 빠지고 방향 필터로도 바뀌지 않는다. 후속 후보: 전역 코드 4/5를 후보역 점수로 쓰는 문제(`arrivalCodes.ts`).
  - 지하·route 없음.
  - **D3 알려진 갭 — trip 없음 + BG + 평지 이동**: BG task는 목적지(trip)가 없으면 `BG_LAST_FIX_KEY`를 쓰지 않으므로 주입할 fix가 없다. 이 셀에서 hold는 FG 마지막 fix에 머문다. lock 없는 표시는 정확성 보장 대상이 아니고(잘못된 전진보다 정체가 낫다, #3083), FG 복귀 refresh가 2초 안에 새 fix를 준다.

## 결정 (hold)

1. **술어**: `stationaryHoldBlock`/`shouldHoldStationaryFix`. 아래가 모두 참이면 hold, 하나라도 깨지면 첫 번째 깨진 조건 이름을 Raw `holdBlock`에 기록한다.
   - lock 없음, 기압계 관측 가능(D2(b)), L 이후 새 fix 없음, `subsurface!==true`
   - L.accuracy<=30m, L.speed null 또는 <0.5 m/s
   - **G2(D1)**: fix↔GPS 최근접역 거리 **>=150m** (상수 `STATIONARY_HOLD_MIN_NEAREST_STATION_M`). 거리를 모르면 hold하지 않는다(fail-closed, `distance-unknown`).
   - 기압 ΔP 이벤트가 `[L-3분, now]`에 없음
2. **D1 = G2, X=150m**: Downloads 덤프 161개 헤더 집계 — 집 군집 118건 p5 222m / p50 227m / p90 230m(<150m는 0m 1건), 집 외 acc<=30 + 역<=100m 표본 10건(용마산 64/69, 건대입구 26/45, 사가정 82, 왕십리 19, 뚝섬 40, 성수 80/81/100), v5 D 161m. 집·D는 남기고 역사·승강장 표본은 전부 거부한다. 한계: 표본은 덤프를 뜬 순간뿐이고 지상 표본이 사실상 두 지점(집·뚝섬 사무실)이다. 지상 역사 앞(성수 80~100m)에서는 hold가 꺼지며, 거기서는 fused 신호가 대체로 맞으므로 비용으로 수용한다.
3. **D2(b) 기압계 관측 가능**: `isBarometerObservable` = 센서·권한·리스너 실패 없음(`sensor|permission|listener-failed|flag-on-dormant` 제외, `readings`는 허용) AND 첫 reading 후 30초 경과 AND 마지막 reading이 30초 이내. 현행 `unavailableReason===undefined`는 stop verdict의 30초 baseline에 의존해 reset·DebugModal 닫힘·기압 공백 뒤 30초 동안 hold가 꺼졌다. ΔP 추적은 `resetBarometerState`의 영향을 받지 않는다(테스트로 승격).
4. **게이트 입력**: `gateUserLocation = decisionUserLocation ?? (hold ? gps.userLocation : null)`를 pickCandidateTrains / positionTrain 게이트 / fused·route `gateOpts` / WiFi 거리 게이트에 쓴다. `usePositionStability`(#2713 자기강화 방지)와 `lockGpsDrift`(lock 범위)는 `decisionUserLocation` 그대로다.
5. **tier8**: `goodGpsOverridesTier8`의 fix 나이 조건을 `(age<=30s || hold)`로 바꾼다.
6. **BG fix 주입**: `useNearestStation`이 FG watch 구독이 없는 동안(`subscriptionRef==null`, `enabled!==false`) 5초마다 `BG_LAST_FIX_KEY`를 읽어 `applyLocation`에 넣는다. 조건을 AppState가 아니라 구독 상태로 둔 근거: W Raw 300행 중 `watch=active app=background` 81행 — BG 중에도 FG fix가 전진했다. 주입된 fix는 `lastFixFromBg`로 표시해 FG 업로드(`useFgPositionUpload`)를 건너뛴다(BG task가 이미 업로드, KV 쓰기 쿼터).
7. **L 단조성**: `applyLocation`은 `timestamp <= 직전 L.timestamp`인 fix를 표시 경로(좌표·시각·accuracy)에 반영하지 않는다. 품질 게이트(`evaluateGpsQuality`)는 그대로 평가한다. 실측: 06:26:51 -> 06:26:34, 17:25:08 -> 17:24:46 (둘 다 watch가 inactive에서 active로 바뀐 직후).
8. **관측**: Raw 필드 `holdBlock`/`distM`, 덤프 `holdBlk=`/`distM=`/`pos=`(lat,lng). candidateRejectBuffer reason `gps-stale-held`(hold로 L을 계속 쓴 stale)를 `gps-stale`과 분리해 센다.

## 대안 (기각, hold)

| 옵션 | 판정 |
|---|---|
| O1 (채택) acc<=30 유지 + G2 + PR-2D | 승인 규칙 무변경, 10/21 T·A·D 막음 |
| O2 acc<=50 | 10/28 중곡을 못 막고, v5 거부 행(F9 acc 44, 5B acc 50)이 자격을 얻는다 |
| O3 acc<=100 | 지하 dead-zone fix(scan 50–100 28행)가 거리 거부권을 얻는다 — #2713 결정 2를 넓히는 극단 |
| O4 정확성 게이트 보강(신규): 기압 이벤트를 누적 수직량으로 바꿔 플랫폼 압력 요동과 구분 | 지하 hold까지 가능하나 1~2주 신규 작업. 지하·정지 셀(17:24:06)의 후속 후보 |
| G1 (역 environment 지상 판별) | 거부 — T·A의 GPS 최근접역 7-015가 `underground`인데 사용자는 지상(집)이었다 |
| G3 (세션 기준 hPa 대비 상승량) | 비권장 — 하루치 표본 1개, 지하 콜드스타트면 기준선 자체가 지하 |
| 표시역만 유지(S) | 거부 — cascade 출력을 덮는 사후 override 계층(ADR-038 다중 권위 fork 위험) |

## 결과 (hold)

- 10/21 T·10/18 A 실측 행에서 fix 나이와 무관하게 용마산이 유지되고(`stationaryHoldWiring.test.ts`), 10/19 D에서 서울숲 detection-fused가 보류된다(`stationaryHoldTier8.test.ts`).
- 거부 행(acc 44 / 13.9 m/s / fix 이후 ΔP / 승강장 64m / 센서 실패 / 기압 공백 / 워밍업)은 현행 그대로다.

## 리스크 (hold)

- G2 X=150m의 표본이 두 지점뿐이다 — Raw `distM`·`pos=`로 새 덤프부터 임계 표본을 늘린다(B8: 이전 덤프의 B·E7 긍정 행은 거리가 기록돼 있지 않아 이번 replay에서 제외).
- 지상 역 앞(<150m) 정지 사용자는 hold가 꺼진다 — 현행 동작이므로 회귀는 아니다.
- BG 주입된 오래된 fix(키가 하루 전 값)가 FG 콜드스타트 직후 L이 될 수 있다 — 이 구간은 기압계 워밍업(첫 reading 후 30초)이 hold를 막고, FG watch의 첫 fix가 곧 L을 교체한다.
- `backgroundLocationTask.ts:175` 주석("기압계는 BG에서 무용")은 W BG 행(hpa·baroEvt 갱신)과 어긋난다 — #2345 proxy 전제 재검토를 후속으로 남긴다.
