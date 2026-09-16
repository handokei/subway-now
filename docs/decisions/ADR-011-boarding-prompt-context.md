# ADR-011: Boarding-Prompt Context Wireup (Client → Backend)

## 상태

Accepted (2026-06-10)

관련 이슈: #1028 (boarding-prompt context wireup)
관련 PR (머지): #1030 / commit `e0e825b` — `feat/#1028-boarding-prompt-wireup`
참조 ADR: ADR-010 (D 방향 정책 SSOT — 9단 게이트 정의), ADR-009 (Phase 3 fusion 기술 SSOT)
관련 PR (병행): #1048 (`inferLoopDirection` — 비단조 line direction 후속 보강)
ADR Roadmap: "Feature-based + Ports & Adapters Phase 5" (#890) — cross-feature import 옵트인 규약

## 배경 — 9단 게이트가 조용히 스킵되고 있었다

ADR-010에서 정의한 D 방향 B 흐름(자동 BOARDING_PROMPT)은 `backend/alarm-worker/src/scheduled.ts` `evaluateAndMaybeFireBoardingPrompt`에서 9단 AND 게이트를 평가한다. 게이트가 동작하려면 두 필드가 필수다:

- `trip.promptGeoContext` — 게이트 #4(출발역 100m), #5(방향 cosine ≥ 0.7) 평가에 필요한 origin/nextStation 좌표 + 진행 vector
- `trip.promptDisplay` — alert 본문/카테고리에 들어갈 origin/nextStation 한글명 + 노선 식별자

`RegisterTripPayload` (`backend/alarm-worker/src/types.ts`) 스키마는 두 필드를 **이미** 옵셔널로 받도록 정의돼 있었고, 백엔드는 둘 중 하나라도 `null/undefined`면 게이트를 `gateSkipReason: 'context-missing'`으로 short-circuit 한다(noisy false positive 방지 — silent skip).

문제는 **클라이언트(`useApnsTripRegistration`)가 두 필드를 한 번도 계산해서 보낸 적이 없었다**는 것. 결과:

- ADR-010 B 흐름 머지(#822) 이후 모든 lockless trip에서 게이트 #3 이전에 silent skip
- KV stats(`boarding-prompt:skip`) 카운터에는 `context-missing`이 99.x% 점유
- 실제 발사 0건 → ADR-010 측정 follow-up(false positive율 / 탭률)이 시작조차 못 함

본 ADR은 **클라이언트에서 어떤 신호로 두 필드를 도출할지**의 결정 SSOT다. 게이트 자체 정의/임계값은 ADR-010, fusion 신호는 ADR-009에 위임한다.

## 결정 — `buildBoardingPromptContext` 신설 + 보수적 nullable 처리

### 신설 유틸

`src/features/alarm/utils/boardingPromptContext.ts`

```ts
// 시그니처 요지 (실제 구현은 PR #1030 참조)
buildBoardingPromptContext({ route, currentStation, destination })
  : { promptGeoContext, promptDisplay } | null
```

입력이 하나라도 부족하면 `null` → 호출자(`useApnsTripRegistration`)는 payload에 두 필드를 누락 → 백엔드는 ADR-010 게이트를 silent skip. **누락은 게이트 활성화 실패가 아니라 정상 흐름**이라는 점이 핵심.

### 신호 소스 — "지금 알 수 있는 것만" 원칙

| 필드 | 소스 | 근거 |
|---|---|---|
| `origin.lat/lng` | `currentStation` (GPS 최근접 역, `useFusedNearestStation` 출력) | trip register 시점은 사용자가 출발역 근처 — GPS 최근접이 곧 origin. 정적 route 첫 leg 출발역 좌표가 아닌 이유: 환승 mid-trip 재등록(rare)에서 다음 leg가 첫 leg가 아니라 active leg일 수 있음. GPS 최근접은 실제 위치 기반이라 mid-trip drift에 robust |
| `origin.name` | `currentStation.name` | 동일 |
| `nextStation.name` | `getNextStationName(line, origin, direction)` — route.legs[0]의 line 기준 | route 정의에 따른 결정론 |
| `nextStation.lat/lng` | nextStation.name으로 stations.json lookup | 좌표 SSOT |
| `direction` | `resolveTravelDirection(line, origin, destination)` | 단조 line(1·3·4호선 등)은 station index 비교로 확정. 2호선 순환선·loop는 `null` 반환 |
| `promptDisplay.line` | `route.legs[0].lineId` | route 정적 결정 |
| `promptDisplay.{origin,nextStation}Name` | 위 origin/nextStation 그대로 | alert 본문 |

### 비단조 line 처리 — null이면 false positive 차단

`resolveTravelDirection` null 반환 시 → `buildBoardingPromptContext`는 **전체를 null로** 반환(direction 없이는 nextStation을 결정론적으로 못 정함). 결과: 2호선 순환선 + loop line trip은 본 PR 시점에 보드ing-prompt 비활성.

**이게 의도된 보수 처리**다. 잘못된 nextStation으로 게이트 #5(방향 cosine)가 통과하면 사용자에게 잘못된 visible alert(false positive)가 발사된다 — ADR-010이 silent push 대비 한 자릿수 비싸다고 명시한 비용. 차라리 게이트 silent skip을 선택.

후속 보강은 PR #1048 (`inferLoopDirection`) — loop direction을 GPS series 진행 방향으로 추론. 머지 시 본 유틸이 자연스럽게 loop line도 커버한다(추가 클라이언트 변경 불필요).

## 트레이드오프

| 장점 | 단점 |
|---|---|
| `RegisterTripPayload` 스키마 무변경 — backend/client/wire 모두 무손실 호환 | mid-trip transfer leg에서 first-leg가 active leg와 어긋날 여지 — 다만 게이트 #4(origin 100m) + #5(방향) 이중 실패로 자연 차단 |
| nullable 반환 → 백엔드 silent skip → 회귀 zero | 비단조 line은 현시점 비활성 — PR #1048 머지 의존 |
| GPS 최근접을 origin 신호로 채택 → mid-trip drift robust | "leg 0 미시작(탑승 전)" 전제 — mid-trip 재등록은 minor edge case로 분류 |
| 유틸이 pure → 테스트 100% 도달 용이 | alarm 슬라이스가 route 슬라이스 유틸(`travelDirection`)을 직접 import → ADR Phase 5 cross-feature 규약 옵트인 필요 |

## Cross-feature import 옵트인

`src/features/alarm/utils/boardingPromptContext.ts` 파일 헤더에:

```ts
/* eslint-disable import/no-restricted-paths */
// alarm → route/utils/travelDirection 직접 import.
// ADR Phase 5 cross-feature 규약(#890)에 따른 명시 옵트인.
// Follow-up: route/alarm 공통 origin 도출 로직을 shared util로 분리(별도 이슈).
```

`travelDirection`은 본질적으로 route 도메인 책임이지만 boarding-prompt 게이트 평가는 alarm 도메인 책임 — 둘이 공유하는 "origin + direction + nextStation" 도출 로직이 shared로 빠질 때까지 한시적 옵트인.

## Alternatives Considered

| 대안 | 거부 이유 |
|---|---|
| (A) backend에서 KV positions로 origin 도출 | backend는 `stations.json` 미보유 → 클라이언트가 좌표를 어떻게든 ship 해야 함 → 결국 동일 신호를 두 곳에서 계산. 단일 출처 원칙 위반 |
| (B) 탑승 시점 origin을 ref에 latch(고정) — 이후 GPS 변동 무시 | 백엔드 9단 게이트는 register 시점 이후 KV positions로 평가 → register 시점 origin이 stale이어도 게이트는 실시간 GPS로 동작. mid-trip drift는 게이트 #4/#5에서 자연 차단. ref latch는 추가 복잡도만 도입 |
| (C) route.legs[0].departure.coordinates를 origin으로 사용 | 정적 route 정의는 사용자가 즐겨찾기로 미리 만든 경로 — register 시점 실제 위치가 다른 역(다음 출발역 등)일 수 있음. GPS 최근접이 실측 신호 |
| (D) 비단조 line에 임의 direction(예: 'inner') 부여 | false positive 위험(ADR-010 §"False positive 9단 AND 게이트"). 차라리 silent skip 후 #1048로 정공법 |

## Relation to other ADRs

| ADR | 본 ADR과의 경계 |
|---|---|
| ADR-010 (D 방향 정책 SSOT) | 9단 게이트 정의, 임계값, arvlCd 우선순위. 본 ADR-011은 그 게이트의 입력 두 필드 도출 책임만 |
| ADR-009 (Phase 3 fusion 기술) | fused speed/Kalman/map matching. 본 ADR과 무관 — 게이트 #7(fused speed) 신호는 backend cron이 KV positions로 직접 산출 |
| ADR-008 (boarding progress estimator) | lock **생성 이후** hop 누적. 본 ADR은 lock 생성 **이전** prompt 게이트 입력 |

## Follow-ups

1. **PR #1048 `inferLoopDirection` 머지** — 2호선 순환선 + loop line의 boarding-prompt 활성화. 본 유틸 변경 불필요(자연스러운 커버).
2. **`firstLeg` 추출 shared util 분리** — `src/features/route/utils/tripDirection.ts`와 본 유틸이 동일 추출 로직 중복. shared util로 분리 시 cross-feature import 옵트인 해제 가능 (별도 이슈).
3. **`context-missing` skip 카운터 dashboard** — ADR-010 follow-up 1(B false positive율 + 탭률 측정)의 prerequisite. KV stats 대시보드에 reason 분포 추가 → 본 PR 머지 후 비단조 line trip 비율 측정 → #1048 우선순위 결정.
4. **mid-trip 재등록 시 active-leg 식별** — 현재 first-leg 가정. 환승 hop이 잦은 노선(예: 1·4호선 환승) 사용자 회귀 발견 시 active leg 선택 로직 도입.

## References

**코드 (worktree `dev` 기준, PR #1030 머지 시점)**:
- `src/features/alarm/utils/boardingPromptContext.ts` — 신설 유틸 (본 ADR의 결정 대상)
- `src/features/alarm/hooks/useApnsTripRegistration.ts` — 호출자, payload 합성
- `src/features/route/utils/travelDirection.ts` `resolveTravelDirection` — direction 도출
- `src/shared/utils/stationLookup.ts` `getNextStationName` — nextStation 결정론
- `backend/alarm-worker/src/scheduled.ts` `evaluateAndMaybeFireBoardingPrompt` — 호출 entry
- `backend/alarm-worker/src/boardingPrompt.ts` `evaluateBoardingPromptGates` — 9단 게이트 평가
- `backend/alarm-worker/src/types.ts` `RegisterTripPayload.promptGeoContext / promptDisplay` — wire 스키마

**머지 PR**:
- #1030 (#1028 boarding-prompt context wireup)

**병행/후속 PR**:
- #1048 (`inferLoopDirection` — 비단조 line direction 후속 보강)

**ADR Roadmap**: "Feature-based + Ports & Adapters Phase 5" (#890)
