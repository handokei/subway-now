# plan 2026-10-17 — #2997 S3 확장: 목적지만 설정한 사용자의 전면 침묵을 푼다

> **왜 S3 스펙 그대로가 아닌가**: S3는 *"OR 게이트는 건드리지 않는다"*로 돼 있어 **리팩터만 되고
> 침묵은 그대로**다. 사용자가 신고한 결함(*"역을 탭해 목적지를 설정하고 그대로 둔 상태 … 탑승
> 알림조차 안 오고 LA에도 탑승 관련이 없다"*)이 바로 그 게이트에서 막힌다. 어제 지적받은
> "계측만 주고 동작은 안 바뀐다"를 반복하지 않기 위해 게이트까지 범위에 넣는다.

## 확정된 침묵 경로 (file:line)

의향 stamp 지점 **전수** — 목적지 설정은 **없다**:

| stamp | 트리거 |
| --- | --- |
| `HomeScreen.tsx:481 setPromptOptIn(true)` | "안내 시작" 버튼 |
| `useBoardingPromptResponder.ts:294 setInfoModeEnabled(true)` | 프롬프트 [탑승] 응답 |
| `useBoardingLockController.ts:451 setInfoModeEnabled(true)` | BoardingTrainList **열차** 탭 |
| `useBoardingIntentPromotion.ts:39` | `promptOptIn===true` 선행 필요 |

backend 게이트: `scheduled.ts:785`·`862`·`888` — `promptOptIn !== true && infoModeEnabled !== true` → 즉시 return. 실측 `lockless-no-user-intent=79`(10/15 23:28 덤프), KV 스냅샷 `promptOptIn: undefined / infoModeEnabled: undefined`(#2997 본문).

## 게이트를 건드려도 되는 이유 (금지 근거 2겹이 해소됐다)

| 과거 금지 근거 | 현재 |
| --- | --- |
| *"완화하면 일시정지 억제 수단(`promptOptIn=false`)이 사라진다 — backend Trip에 pause 필드 0건"* | **#3008이 해소.** backend가 `motionEvidence`로 "정지 15분"을 판정한다(KV 쓰기 0, `motionState.ts hasBeenStationaryFor`). 억제를 의향 축에서 **motion 축으로 이전**할 수 있다 |
| #2651 *"게이트 없는 프롬프트 발사 — 집에서 222m 실증"* | **거리 게이트가 독립 존재한다**: `scheduled.ts:8143-8145 isTooFarFromOrigin` → `boardingPrompt.ts:47 originDistanceM - originAccuracyM <= PROMPT_PROXIMITY_MARGIN_M`(150m). 의향 게이트와 **별개 층** |

### ⚠️ 그런데 거리 게이트에 구멍이 있다 (이 plan의 핵심 제약)

```
isTooFarFromOrigin = hasProximityReading && !isNearOrigin(...) && !anchorFresh
```

`hasProximityReading`이 **false면 차단하지 않는다**(fail-open). `scheduled.ts:909` 주석이 그 사실을 명시한다 — *"신뢰 불가로 보고 차단을 건너뛴(=발사를 허용한)"*.

→ **의향 게이트만 열면 "proximity reading 부재 + 집" 조합에서 발사된다.** #2651의 222m는 reading이 있었으니 막히지만 reading 없는 케이스는 안 막힌다.

**따라서 새 축은 "reading 있고 근접"을 AND로 요구한다.** fail-open 자체를 fail-closed로 바꾸는 것은 별 결정(기존 trip 영향 범위가 다름)이므로 이 plan에서 하지 않는다.

## 설계 (v2 — 더블체크로 재작성)

### v1이 비껴간 것

v1은 "표시/매역 게이트만 열고 프롬프트는 건드리지 않는다"였다. **게이트를 전수 분류하니 그게 사용자 가치를 못 낸다**:

| 게이트 | 정체 | v1 판정 | 실제 |
| --- | --- | --- | --- |
| `scheduled.ts:1923` | **통계만**(`boardingAnchorUnresolved++`) | "표시 게이트" | 게이트 아님 — 열 것이 없다 |
| `scheduled.ts:2043` | 매역 통과 push(`#816 C`) | 열기 대상 | `decision_notification_priority_3tier`에서 **"없어도 됨"** 등급이고 사용자가 요청하지 않았다 |
| LA 탑승 표시 | — | 열기 대상 | **S1(#3000)이 이미 덮었고 배포됨** — 추가 작업 0 |
| `scheduled.ts:8074` 프롬프트 | 출발역 탑승 프롬프트 | **건드리지 않음** | ← **사용자가 원한 바로 그것**(*"탑승했는지에 대한 알림조차 안 오고"*) |

→ v1을 그대로 구현하면 **사용자가 원하지 않은 것을 열고, 원한 것은 피해 간다.** 폐기.

### v2 — 프롬프트를 열되 #2651을 구조적으로 막는다

대상은 **`maybeFireOriginBoardingPromptGpsFree`(`scheduled.ts:8051`) 한 곳**이다. 사용자 시나리오(목적지 설정 후 출발역에서 대기)가 정확히 이 경로다. 환승 후(`maybeFireLegBoardingPrompt:8472`)·하차(`maybeFireHopEndPrompt:8764`)는 **범위 밖**(다음 단계).

이 함수 **안에 거리 게이트가 이미 있다**(`:8140-8145`) — 그래서 한 함수 안에서 "열기 + 안전장치"가 완결된다.

```
1) 의향 게이트(:8074)
   if (!명시의향 && !trackingOptIn) → skip        ← trackingOptIn을 OR로 추가

2) 거리 게이트(:8143)
   기존: isTooFarFromOrigin = hasProximityReading && !isNearOrigin(...) && !anchorFresh
         → reading 부재 시 fail-open (발사 허용, :909 주석이 명시)

   추가: trackingOptIn만으로 열린 trip은 reading 부재 시 **fail-closed**
         if (!명시의향 && !hasProximityReading) → skip
```

**이 조합이 #2651("집에서 222m 발사")을 구조적으로 불가능하게 만든다**: 약한 축으로 열린 trip은 **근접이 실측으로 확인돼야만** 발사된다. 명시 의향 trip의 fail-open은 **그대로 유지**(동작 불변).

### 축 분리 (#2997 제목 그대로)

| 축 | 의미 | 트리거 | 이 PR에서 여는 것 |
| --- | --- | --- | --- |
| `trackingOptIn` **(신규)** | "이 트립을 추적해달라" — 약한 의향 | **목적지 설정** | 출발역 탑승 프롬프트(단 근접 실측 필수) |
| `promptOptIn` (기존) | "프롬프트를 받겠다" | "안내 시작" | 기존 유지 |
| `infoModeEnabled` (기존) | **명시 의향** — ADR-014 "lock 동급 보장 의무" | 응답/열차 탭 2곳 | 기존 유지 |

**`infoModeEnabled` 재사용 금지**: 목적지 설정만으로 켜면 ADR-014의 "명시 의향 = lock 동급 보장"이 희석되고 `memory/feedback_user_intent_equal_protection`이 금지한 등급 혼합이 된다. 그래서 **새 축**이며, 더 약한 축이므로 **더 엄격한 추가 조건(근접 실측)** 을 요구한다.

### 변경 범위

| 레이어 | 변경 |
| --- | --- |
| device | 목적지 설정 시 `trackingOptIn` stamp(trip-bound) + register payload forward + 종료 시 reset(`TRIP_BOUND_CLEANUPS`) |
| backend | `validateTrip` 수용(`index.ts:4232-4240` 패턴) + `Trip` 타입 + 위 2개 게이트 |

**매역 push(`:2043`)·환승·하차 프롬프트는 건드리지 않는다** — 사용자 요청 범위 밖이고 3-tier 결정과 충돌한다.

## acceptance

1. **test-first** — `trackingOptIn`만 있는 trip(명시 의향 전부 미설정)에서:
   - 근접 reading 있고 가까우면 **출발역 프롬프트가 발사된다**(기존엔 `NoOptIn`으로 skip)
   - **reading 부재 시 발사되지 않는다**(fail-closed — #2651 무회귀 핵심 가드)
   - reading 있고 **멀면** 발사되지 않는다(기존 거리 게이트 유지)
   - 축이 **전부 없으면** 기존대로 skip
   - **명시 의향 trip의 fail-open은 변하지 않는다**(동작 불변 가드)
2. **revert-red** — 축 추가를 되돌리면 1번 첫 항목이 red.
3. trip 종료 시 `trackingOptIn` reset(`TRIP_BOUND_CLEANUPS`) — 다음 trip에 leak 금지.
4. **측정** — 배포 후 `lockless-no-user-intent` 카운트가 목적지-설정-only 트립에서 감소하고, 프롬프트 발사 수는 **변하지 않는다**.

## 별 건으로 발견 (이 plan에서 고치지 않음)

- `boardingPromptSkippedTooFar`(`scheduled.ts:1467`)는 **증가 지점이 0건** — 죽은 통계다. 실제 거리 차단은 `originGpsFreeBoardingPromptBlocked`로 센다. 덤프/대시보드에서 "TooFar=0"을 "거리 차단이 없었다"로 오독할 수 있다.
