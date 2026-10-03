# 핵심 경로 OPEN 이슈 재판정 (2026-09-20)

## 왜 했나

같은 날 검사한 이슈 2건(#2711, #2734)이 **둘 다 본문이 낡아 있었다** — 지목한 결함이 이미 다른 PR로 닫혔거나 원인이 달랐다. 열린 이슈 개수가 남은 일의 척도가 아니라는 신호였으므로, "사용자가 내릴 역을 놓치지 않는다"에 직접 걸리는 이슈 10건을 현재 `dev` 코드와 전수 대조했다.

**판정 기준**: 이슈 본문이 지목한 구체적 코드 지점을 직접 열어 확인한다. 테스트 통과만으로 SUPERSEDED 판정하지 않는다 — 같은 날 #2751 에서 mock 이 실 API 가 보내지 않는 모양을 넣어 커버리지 100% 가 결함을 가린 사례가 나왔다.

## 결과 — 10건 중 6건이 이미 해소돼 있었다

| 이슈 | 판정 | 영향도 | 근거 |
| --- | --- | --- | --- |
| **#2641** | **STILL-VALID** | **BLOCKS-CORE** | `evaluateConsensusGate` 호출 전수 = `advanceTripPosition.ts:510` 1곳뿐. `scheduled.ts` 에서 0건 |
| **#2655** | **CHANGED** | **BLOCKS-CORE** | 원 결함은 `scheduled.ts:5627`(walk-gate 기준 `arrivedAt` 교체)로 해소. 이슈 후속 코멘트가 진짜 root 를 재규명 |
| #2699 | STILL-VALID | DEGRADES | `useApnsTripRegistration.ts:1079-1085` deps 배열이 이슈 인용문과 동일, `:1067-1077` 주석도 그대로 |
| #2610 | CHANGED | DEGRADES | `useForegroundLaMirrorSync.ts:8-16` 파일 헤더가 "원인 규명은 이 PR 범위 밖"이라고 스스로 명시 |
| #2651 | SUPERSEDED | DEGRADES | `scheduled.ts:7716-7752` 에 `hasFreshOriginProximityCorroboration` + `isTooFarFromOrigin` 거리가드 (PR #2654) |
| #2594 | SUPERSEDED | PERIPHERAL | `useFusedNearestStation.ts:1841-1846` — 제안 fix(TTL 캐시)는 기각, 실제 root 는 barometer 1Hz (PR #2622) |
| #2526 | SUPERSEDED | — | `scheduled.ts:1602-1624` `{ allowLegTransfer: true }` + `LEG_RESOLVE_STREAK_THRESHOLD`. 주석이 #2539 를 인용 |
| #2371 | SUPERSEDED | — | `useBoardingPromptResponder.ts:290`, `useBoardingLockController.ts:400` 양쪽 `startNavigation()` 호출 |
| #2306 | SUPERSEDED | — | `useBackgroundLocation.ts:64-65,128` `navigationActive` 게이트 + 자식 이슈 #2371 배선 |
| #2130 | SUPERSEDED (부분) | — | acceptance 4개 중 **1·3만** 확인(`scheduled.ts:783,1315,7094-7095`, `useApnsTripRegistration.ts:1089`). 2·4 미확인 |

## 핵심 경로에 남은 것 (우선순위)

### 1. #2641 — 약속된 2차 방어가 호출부에 없다

`boardingPrompt.ts:24 / :199 / :368` 이 세 번에 걸쳐 **"caller(scheduled.ts)가 `evaluateConsensusGate(environment, signals)` 로 arrival + lockAttachable 합의를 별도 검증한다"** 고 적어 두었다. 그 호출이 **존재하지 않는다.**

```
evaluateConsensusGate 호출 전수 (주석·import·타입 제외):
  advanceTripPosition.ts:510   ← 유일
  scheduled.ts                 ← 0건
```
`advanceTripPosition.ts:11` 이 스스로 `"evaluateConsensusGate — 호출자 미적용"` 이라고 적고 있다.

`boardingPrompt.ts:357-395` 의 `isGpsDependentBypassEnv` 가 지하/unknown 환경에서 GPS 게이트를 bypass 하는데, 그 대가로 요구된 2차 방어가 배선되지 않아 **합의 검증 없이 통과**한다. #2637 머지로 노출 범위가 지상→지하/mixed 로 축소됐을 뿐 결함은 그대로다.

ADR-010 첫 줄("두 실패 모드는 동급") 위반 — 오탑승 방향으로 무방비다.

### 2. #2655 — 원 결함은 닫혔고, 재규명된 root 가 부분 방어 상태

walk-gate 기준 시각 오류는 PR #2670 으로 해소됐다(`scheduled.ts:5627`). 그러나 **이슈 자신의 2026-09-16 후속 코멘트**가 진짜 root 를 **backend 내부 KV stale-read 레이스로 같은 환승이 재처리되는 것**으로 재규명했고, 머지된 anchor 재-stamp 멱등 가드(`scheduled.ts:5561-5600`, #2658)는 **부분 방어일 뿐**이라고 명시한다.

→ 이슈 제목·본문이 실제 잔여 결함과 어긋나 있다. 착수 전 본문 갱신 필요.

## 중복·포함 관계

- **#2526 ⊂ #2655** — #2526(cron leg-2 자동락)이 이미 해소되어 #2655 의 "경로 A/B 둘 다 막힘" 중 backend 자동승격 경로는 열려 있다. #2655 의 close 조건 자체는 불변.
- **#2610(b) · #2306/#2371 · #2589** — "LA/알림이 backend advance 를 못 따라간다"는 같은 증상군을 서로 다른 채널(FG mirror poll vs BG `navigationActive`)로 고친 **형제 관계**. 중복 아님.
- **#2641 · #2637** — #2637 은 노출 **범위**만 줄였다. 별개 유지.

## SUPERSEDED 6건을 닫지 않은 이유

`CLAUDE.md` 결정 룰: **"PR 머지 = close 금지. close 조건은 실기기 1주 재발 0건 OR 1주 production 측정 회귀 0건."**

6건 전부 라이드로 판정되는 회귀다. 현재 상태는 **"코드 해소, 현장 검증 대기"** 이며, 다음 라이드 1회가 6건을 동시에 판정한다. 그 전에 닫으면 같은 룰이 막으려던 "머지=완료" 착각이 재현된다.

#2130 은 acceptance 4개 중 2개만 확인됐으므로 **부분 해소**로 별도 표기한다.

## 방법론 메모

- 이슈 개수는 남은 일의 척도가 아니다 — **표본 10건 중 6건(60%)이 이미 죽은 이슈**였다. 43건 전체로 환산하면 실제 잔여는 절반 이하일 가능성이 높다.
- 착수 전 재판정이 싸다. 낡은 본문대로 구현하면 이미 있는 코드를 다시 만들거나, 틀린 원인을 고친다.
- 이슈 **본문보다 후속 코멘트가 최신일 수 있다**(#2655 가 그 사례). 본문만 읽고 착수하면 안 된다.
