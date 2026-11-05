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

---

# 경로 arc 밖 후보 제외 — PR-1(A) (#3191, 2026-11-03)

## 배경 (off-arc)

2026-10-31 09:37~09:39 사용자는 용마산(7-015)에 있었고 trip route는 용마산→논현(하행)이었다. fix는 2분 가까이 묵었고(acc 86~87m, distM 34) 현재역이 **출발역보다 상류인 사가정(7-014)** 으로 두 번 튀었다(덤프 3DCCD Raw L614-616·L622-623, `arrival/arrival-arriving`·`arrival-confirmed`). 사가정의 도착 신호는 열차 신호(규칙상 lock 없는 trip에 허용된 신호)라 신선도·방향 게이트를 통과했다. 사용자는 arc(출발역~목적지) 밖 열차를 탈 수 없다.

## 이 ADR(PR-1 A 부분)이 수정·대체·모순하는 결정

- **ADR-044 방향 필터 절의 "본 필터는 GPS를 쓰지 않는다"는 A에는 해당하지 않는다(정정).** A의 arc 시작점은 tripOrigin이고, tripOrigin은 목적지 설정 시 `effectiveOrigin`(fused 결과 포함)에서 복사된다 — 10/31 origin 7-015도 `gps/gps-only` 결과에서 왔다(GPS 유래). 또 A로 열차 신호가 제외된 셀의 결과는 묵은 fix의 최근접(gps-only)이다. 사용자 방향(2026-11-03): memory 규칙 "GPS로 현재역 판정 금지"는 **판단(알림 발사·lock 생성·backend 진행 입력)에만 적용**하고 **표시는 허용**한다(plan §3 (a)). 따라서 A는 표시 한정 변경이며, 판단 경로로의 누수는 PR-S(#3289, sync 관측역 신선도 조건)가 막는다.
- **ADR-039 §D 핵심 1 ("GPS는 단독 거부권을 갖지 않는다", :117)**: A는 GPS 유래 tripOrigin이 만든 arc로 열차 신호 후보를 배제한다. GPS 좌표가 직접 거부하는 것이 아니라 **trip 경로(사용자 의향)** 가 거부하는 구조이며 표시 한정이다. 재배정 축: "arc 밖 후보의 열차 신호 점수" = 경로 기반 제외(표시 역 결정에 한함).
- **ADR-044 방향 필터 (PR-2D)**: 같은 fail-closed 방식(점수 0, 모두 0이면 candidates[0] gps-only)으로 `FusionCandidate.excluded` 를 추가한다. 방향 필터를 대체하지 않는다(둘 다 적용).
- **ADR-044:35·:23 (tier6 미변경)**: 유지. 아래 셀 M9.
- **#2125 (현재역 표시 고착 정직 강등)**: A로 lock 없는 trip이 출발역에 머무는 시간이 늘어 3분 강등이 더 자주 걸릴 수 있다. 강등 판정 규칙은 불변. 코드 주석(`lockless에서 positionTrain dormant`)은 `positionTrainConsensus.ts`(automotive ∧ cellular surface 합의면 채택 가능)와 어긋나 같은 PR에서 정정했다.

## 결정 (off-arc)

1. `FusionCandidate.excluded?: 'off-arc'` — 값이 있으면 arrival·position 두 신호 모두 점수 0. 모든 후보가 0이면 기존대로 `candidates[0]`(GPS 최근접) gps-only.
2. 호출자(`useFusedNearestStation`)가 `arcStations.length > 0 ∧ boardingLock 없음 ∧ arcIndexOfStation(arcStations, station) === -1`이면 `'off-arc'`을 준다. route 없음(arc 없음)과 lock 있는 trip은 대상이 아니다(lock trip은 기존 lock 가드).
3. 제외 전 점수>0이던 신호는 후보·종류당 1건을 reason `candidate-off-arc`로 candidateRejectBuffer에 적재한다(`signal: arrival|position`, observer 제외).

## 선언하는 미커버·위험 셀 (plan v5 §6)

- **M8 — tripOrigin이 실제 위치보다 하류로 캡처된 경우**: 실제 역(상류)이 arc 밖이 되어 0점 처리된다. A의 고유 위험이다(L797 유형, 실제 위치 미확정). 완화 없음 — 선언만 한다. 정체가 가짜 진행보다 낫다는 #3083 원칙 하에 허용.
- **M9 — lockless positionTrain(tier6) 상류역 채택**: `checkStationProgression`이 arc 밖 후보를 면제하므로 tier6가 상류역을 채택할 수 있고 A는 이를 막지 않는다(fused tier만 대상). 실측 결함 행 중 position-train 0건. ADR-044:35에 따라 변경하지 않는다.
- **M2' — 묵은 fix(>5분) + 상류 신호**: gps-only 탈락 → 강등 경로도 null → Home은 tripOrigin을 쓴다. 실측 0행.
- **M11 — observer(DebugModal) 인스턴스**: lock 인자를 받지 않아 lock trip 중에도 A가 적용된다. DebugModal 표시가 Home과 다를 수 있다(기존 lock 의존 로직 전부 동일한 한계).
- 환승역에서 route에 없는 다른 노선 변형 후보도 arc 밖으로 제외된다(사용자가 그 노선 열차를 탈 수 없다).

## 대안 (기각, off-arc)

- **연속성 가드(직전 역을 지났는가)**: 전방 이웃은 직전에 현재역을 지나므로 "사용자가 탔는가"를 못 가른다. 기각(plan §5).
- **GPS 거리 게이트로 상류 후보 거부**: 규칙 충돌(GPS 단독 거부)·묵은 fix 의존. 기각.
- **정확성 게이트 보강(신규)**: 후보 열차가 사용자 쪽으로 오는 중인지 판정하는 별도 게이트. 현재 코드에 없고 신규 작업이 필요하다 — 후속 후보.

## 결과 (off-arc)

- 10/31 결함 행 5개(Raw L614-616·L622-623) replay에서 사가정 도착 신호가 있어도 fused는 용마산(출발역)이고 Debug 'Candidate rejects'에 `candidate-off-arc`가 `signal` 태그와 함께 보인다.
- arc 위 다음 역(중곡)·출발역 자체의 신호는 같은 조건에서 그대로 채택된다.

## 리스크 (off-arc)

- M8: origin이 하류로 잘못 캡처된 trip에서 실제 역이 0점이 된다.
- Raw에 비최근접 후보 열차 신호가 없어 replay의 사가정 arrival은 합성이다(fix 시각·정확도는 실측 원문).

---

## unreachable (PR-D) — 정지 fix 직후 도달 불가 이웃역 제외 (#3191, plan v6 D-hop)

### 배경

지상에서 정지하면 iOS가 15초 넘게 새 fix를 주지 않는다. hold(PR-2)는 최근접역 >=150m일 때만 켜져(G2) 역 앞(<150m)에서는 15초 넘은 fix가 결정 입력에서 빠지고(ADR-039 1단계) 거리 게이트가 꺼진다. 그 틈에 앵커(`candidates[0]`) 바로 옆 역의 열차 신호가 앵커를 이겨 사용자가 한 역 앞/뒤로 표시된다. 실측 2건(사용자에게 보임, trip 활성): R11 11/02 19:44:34 뚝섬->성수(LA 28초, 덤프 AB2FB L633/L634) / W 10/30 17:24:06 건대입구->어린이대공원(덤프 B8D812 L762/L763, ADR-044 "W 미커버" 선언의 대상). R12(11/03 실제 탑승 이동, speed 0.6)는 결함이 아니므로 대상에서 뺀다(C 안을 채택하지 않은 결정적 근거).

### 결정

`findUnreachableNeighborIds`(`utils/unreachableNeighbor.ts`)가 아래를 **모두** 만족하는 후보를 `excluded: 'unreachable'`로 점수 0 처리한다(fail-closed, off-arc와 같은 방식). 판정이 off-arc보다 뒤다(off-arc 우선).

1. lock 없음, hold 아님, fix 나이 >= 15s (`GPS_QUALITY_GATE_MAX_AGE_MS`)
2. 마지막 fix가 정지 품질: acc <= `STATIONARY_HOLD_MAX_ACCURACY_M`(30), speed null 또는 < `STATIONARY_HOLD_MAX_SPEED_MPS`(0.5) — hold 술어와 같은 임계
3. 후보가 앵커의 같은 노선 인접역이고(`lookupAdjacentHopSeconds`, `shared/utils/adjacentHopSeconds.ts`로 barometerState에서 추출) fix 나이 < 그 hop 운행시간
4. 신선 fix였다면 거리 게이트(`passesFusionDistanceGate`, 일반 0.6km/0.2km)가 이 후보를 거부했을 위치 — 신선 게이트보다 엄격해지는 일이 없다

제외된 점수>0 신호는 reason `candidate-unreachable`(`signal` 태그)로 candidateRejectBuffer에 적재한다(DebugModal 'Candidate rejects'). 길어야 hop 운행시간(데이터상 60~270s) 뒤에는 현행 동작으로 돌아간다. 적용 환경은 전 환경(지상·지하, 사용자 결정 QA-2).

### 이 ADR(PR-D)이 수정·대체·모순하는 결정

- **ADR-044 / #2713 / ADR-039 1단계 ("15초 넘은 fix는 결정 입력에서 제외")**: 묵은 fix를 "정지 품질 ∧ hop 운행시간 이내"일 때 **제외 입력**으로만 쓴다. 재배정 축: 나이 상한 15s 고정 -> 인접 hop 운행시간, 표시 한정·lockless 한정.
- **ADR-044 (지상 역 앞 <150m는 hold를 끄고 fused 신호가 대체로 맞으므로 비용으로 수용)**: R11·W 실측으로 그 비용이 결함으로 확인됐다. G2는 바꾸지 않는다(hold는 그대로 꺼짐) — hop 시간 동안 도달 불가 이웃만 제외한다.
- **ADR-044 O3 (acc<=100 기각) / S (사후 override 기각)**: 유지. D는 acc<=30(ADR-015 §3 strong A와 같은 값)이고, cascade 입력 단계의 제외다.
- **ADR-044 W 미커버 선언**: **커버로 바뀐다**(W 17:24:06 replay).
- **ADR-039 §D 핵심 1 ("GPS 단독 거부권 없음")**: D는 묵은 fix + 운행시간 데이터로 열차 신호 후보를 배제한다. (a) 범위(표시 한정)에서 재배정 — 판단 경로(알림 발사·lock 생성·backend 입력)는 영향 0(lockless 발사 차단, sync 묵음 미송신)이고 소비처 전수는 plan §4.
- **ADR-015 §3 (지하 GPS reject, fire 게이트)**: 직접 충돌 없음. W(지하 승강장)에 적용되므로 전 환경으로 결정(QA-2).
- **memory "GPS 결정권한 X(지상만)"**: (a)에 따라 표시에만 쓴다.
- **#2841 (정체는 결함)**: 정체는 hop 시간 이내로 제한하며 E2(제외된 후보가 hop 안의 다음 신선 fix 최근접이었던 건수, acceptance 1주 0건)로 감시한다.

### 선언하는 미커버 셀

- S5b/R12(speed >=0.5 정차 중 열차 안 fix): 현행 유지 — D 비활성(speed 조건).
- S12(acc >30, L797 acc 189 포함): D 밖. 실제 위치 미확정.
- S24(열차 안에서 찍힌 mid-hop 정지 fix, speed<0.5): 이웃 표시가 최대 hop 시간 지연된다. 실측 0건, E2로 감시.
- S23(인접 hop 키 없음: 다른 노선·비인접·데이터 미커버 구간): D 비활성(현행).
- S22: 앵커는 `candidates[0]`(allowedLines 필터 후, pickFusedStation과 같은 기준). hold G2는 `gps.liveResult` 기준이라 두 값이 다를 수 있다.

### 결과 / 검증

`useFusedNearestStation.unreachableNeighbor.test.ts` — R11·W 실측 행 replay(덤프 원문 fixture `replay_20261103_unreachable_neighbor.ts`, 열차 신호는 합성)와 경계 it.each, 대조(R0·R12·R7-R10·L797·lock·hold·off-arc 우선)가 함께 있다.
