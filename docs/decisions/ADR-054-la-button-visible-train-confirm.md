# ADR-054: LA 탑승 버튼은 "LA에 보이는 열차"를 확정한다 — 발사 열차 동봉, cron 전용 발사 기록(`prompt_fires`), 최신 발사 + 3분 창 검증, live는 fallback

- **상태**: **Proposed** (2026-11-03)
- **관련**: #3221, #3055, #3044, ADR-042, ADR-051, ADR-010, `tasks/plan-2026-11-02-la-button-train-refresh.md`(v6) §3.2·§4
- **검증 상태 표기**: 확인(코드 `file:line` / D1 `trip_events` / replay로 확인)

## 배경

- 11/02 19:54:57 LA "탑승했어요" 탭: 질문 발사(19:54:45, 열차 7320)를 보고 누른 탭을 backend가 live 해소로 처리해 7320을 lock했지만(D1 1996·1997), 이는 우연의 일치다. 구조상 backend는 사용자가 **본** 열차가 아니라 탭 시점에 Seoul position에서 다시 고른 열차를 lock한다. 질문 발사 후 다른 열차가 앵커에 도착하면 보이는 열차와 lock이 갈린다.
- 사용자 결정(2026-11-02, verbatim): "그냥 la에서 내가 탑승 여부 알림 올 떄 서버에서 새로 받아서 할 수 있돌고 하면 되는거잖아" — LA 버튼은 보이는 열차를 확정한다. 10/21 결정(#3044 ⓑ 부분 대체, F4 "도착확정 발사 + 3분 내 탭이면 프롬프트 열차, 창 밖은 재조회")과 같은 방향이며 F4는 미구현이었다(`PROMPT_TRAIN_TRUST_WINDOW_MS` origin/dev 0건).
- trip 레코드의 발사 stamp(`legBoardingFireStamp`·`recentPromptCandidates`)는 재등록·60s 캐시 읽기 되돌림으로 소실돼 신선도 근거가 못 된다(계획 §2.2). 그래서 trip 밖 cron 전용 append-only D1 `prompt_fires`(#3221 PR-3a)를 근거로 쓴다.

## 이 ADR이 수정·대체·모순하는 결정

| 결정 | 축 | 재배정 |
|---|---|---|
| #3044 ⓑ / #3062 | LA 열차 신호 전송·권위 | 번복(LA 채널): `laCandidate`로 보이는 열차 전송 재개, 권위는 "prompt_fires 최신 발사 + 3분 창". 알림 채널은 무변경 |
| 10/21 F4 (`plan-2026-10-21-sleep-trip-quickfixes.md`) | 신뢰 창·진행 가드 | 3분 창(`PROMPT_TRAIN_TRUST_WINDOW_MS`) 신설·진행 가드 복원(+2역 거부, 스냅샷 없으면 수용). LA 채널에만 적용 |
| #2961/#2975 (body-first) | 알림 body trainCode | 무변경. 알림은 `prompt_fires` 최신 발사·3분 창을 거치지 않는다(남는 비대칭, 사용자 지시로 범위 밖) |
| #2957 `promoteStampedTrainCode` | stamp 직접 승격 | `laCandidate` 요청에서만 비활성(그 외 무변경) |
| #1729/#2957 기존 lock 재평가 금지 | 탭 시 lock 존재 | 무변경 — 유지 판정이면 기존 lock 반환(`laCandidateDecision:'existing-lock'`) |
| #3056 `resolveTier` 계약 | 응답·D1 tier | 값 집합 무변경(`'assertion-departed'`). 후보가 최종 lock이면 생략 |
| ADR-010 첫 줄 (false positive / miss 동급) | lock 정확도 | 유지 — 후보 거부 사유 전부 fail-closed(현행 live 경로로), 후보 채택은 사용자가 본 열차 |
| ADR-042 | 약속 재정의 | 충돌 없음 |
| ADR-051 | 탑승 LA 분리 | 충돌 없음(LA content 필드 확장은 PR-3a/PR-2) |

## 결정

`laCandidate`(`{trainCode, issuedAtMs}`)가 있는 `boarded` 요청만 새 판정을 탄다. 없으면 현행 100%.

1. 기존 lock 유지/해제 판정(`decideLegLockReleaseForBoardedTap`)은 무변경. 유지되면 기존 lock 반환 + `existing-lock`.
2. `laCandidate` 요청에서는 `promoteStampedTrainCode`를 건너뛴다.
3. `prompt_fires`의 (trip, 탭 anchor 역, 노선 코드) 최신 행과 후보를 비교한다: trainCode·issuedAtMs 일치, 발사 decision이 도착확정(`isArrivalConfirmedDecision`), 탭 anchor가 현재 leg anchor와 정합(`buildAnchoredTrainCodeLock`), 진행도 가드(cron이 폴링한 노선 position 스냅샷에서 그 열차가 anchor보다 2역 이상 진행했으면 거부, 스냅샷 없음·방향 불명은 수용).
   - 발사 후 3분 이내: 위를 통과하면 live 없이 후보로 lock (`accepted-trusted`).
   - 3분 초과~15분(`RECENT_PROMPT_CANDIDATES_TTL_MS`): live 먼저. live가 lock을 만들면 live (`window-expired-live`, `laCandidateAgrees`), 못 만들면 후보 (`window-expired-candidate`).
   - 15분 초과 / 더 새 발사 / 도착확정 아님 / anchor 불일치 / 진행도 초과 / `prompt_fires` 읽기 실패·행 없음: 후보 무시, 현행 live 경로(`expired`·`stale-newer-prompt`·`not-arrival-confirmed`·`leg-mismatch`·`progressed-past-anchor`·`no-fire-record`).
4. 후보가 최종 lock이면 응답·meta에서 `resolveTier`가 없고(`outcome`도 없음), 시도한 live 결과는 meta `liveOutcome`/`liveNoneReason`. 판정은 meta `laCandidateDecision`.

## 대안 (기각)

| 안 | 기각 이유 |
|---|---|
| live 우선, 후보는 fallback만 (v3·v4 ③) | 보이는 열차와 다른 열차가 lock될 수 있어 사용자 결정과 상충 |
| 후보 무조건 우선(검증 없음) | 갱신 전 탭(A 표시 중 B 질문 발사)을 막지 못함 |
| trip 레코드 stamp 보존 후 stamp로 검증 | 알림 body·목록 탭 판정까지 바꿔 범위가 넓다(별도 결정, 계획 §3.5) |
| 정확성 게이트(발사 시 position으로 플랫폼 열차 재확인) | 신규 작업, 발사 열차 선택 편향은 PR-4(D-1a)에서 별도 처리 |

## 결과

- LA 버튼 1탭이 발사 후 3분 안이면 보이는 열차로 lock된다(live 호출 없음). 알림 경로는 불변.
- D1 `boarding-confirm-result.meta.laCandidateDecision` 분포로 24h·1주 측정. `window-expired-live && laCandidateAgrees=false`는 창 길이 재검토 신호.
- invariants.md: `resolveTier` 행에 "laCandidate 채택 행 제외", 신규 행 "laCandidate는 prompt_fires로만 검증".

## 리스크

- `prompt_fires` 쓰기 실패 시 "더 새 발사"가 누락돼 이전 후보가 최신으로 판정될 수 있다(fail-open 잔여, Sentry `D1-write-failure{table:'prompt_fires'}`로 관측).
- 발사 열차 선택이 출발(2) 열차를 고르는 편향(실측 0/6)은 PR-4(D-1a, #3290)로 별도 처리.
- 진행도 가드는 cron 스냅샷(최대 90s 전)에 의존한다.
