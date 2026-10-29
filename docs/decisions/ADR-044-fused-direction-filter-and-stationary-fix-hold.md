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
