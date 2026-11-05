# plan 2026-10-10 — 방향 판정 전 노선 정합화 (양방향 · WHOLE)

- **상태**: **확정** (2026-10-10 사용자 결정) — **H-1 + H-6**, 순서 고정(H-1 선행). J0 전수 판정 완료
- **출처**: 2026-10-09 라이드(중곡→광화문, 7→5호선, D1 `trip_metrics` id=156, 토큰 `b00dd879`) + R2 `seoul-capture/2026-10-09/` 원본
- **사용자 지적**: "모든 노선에서 정확하게 진행될 수 있도록 해야해 5/1호선등이 아니라 모든 노선", "한 번 늦었다고 서비스를 제대로 누리지 못하는 건 문제"
- **표기**: confirmed(`file:line`/D1/R2로 확인) / **candidate**(후보, 미확정)

---

# 0. 확정 사실 — 사용자는 늦지 않았다

R2 원본(`seoul-capture/2026-10-09/1791513444417.json`, `1791513504415.json`):

| 시각 | 사건 | 출처 |
| --- | --- | --- |
| 11:36:43 | 5559 군자(능동) **진입** (`trainSttus:"0"`) | R2 realtimePosition |
| 11:37:26 | 5559 군자(능동) **도착** (`arvlCd:"1"`, `arvlMsg2:"군자(능동) 도착"`) | R2 realtimeStationArrival |
| 11:37:39 | **사용자 탭** | D1 `boarding-confirm-result` |
| 11:37:51 | lock 부착 (`promotedLock trainCode=5559`) | D1 `sync-received` |

**열차가 도착한 분에 응답했다. "늦게 lock 걸어서"라는 가설은 반증됐다.**

## 실제 결함 — 반대 방향 열차로 lock (confirmed)

```json
{"trainNo":"5559","statnNm":"군자(능동)","statnTnm":"마천","updnLine":"1"}
{"btrainNo":"5559","bstatnNm":"마천","arvlCd":"1"}
```

`stations.json` 5호선 ID: **광화문 5-024 → 장한평 5-034 → 군자 5-035 → 마천 5-046**

- 사용자: 군자(5-035) → 광화문(5-024) = **ID 감소 = 서쪽 = 상행**
- 5559: 종착 마천(5-046), `updnLine:"1"`(하행) = **ID 증가 = 동쪽**

**반대 방향이다.**

## 1~2정거장 지연의 기전 (confirmed, D1)

반대 방향 lock이 **매 역에서** 추정 실패 → swap 왕복을 만들었다:

```
11:40:37  vanish-swap 장한평  phase=estimate-null  isNull=true
11:40:37  leg2-estimate 장한평  matched=false     ← lock 열차로 ETA 추정 불가
11:41:24  vanish-swap 장한평  phase=swap-attempt
11:41:24  leg2-estimate 장한평  matched=true      ← 다른 열차로 대체
11:41:54  cron-fire-attempt 장한평  sent          ← 그제서야 발사
11:45:43  vanish-swap 답십리  estimate-null=true
11:46:25  leg2-estimate 답십리  matched=true → sent
11:49:24  cron-fire-attempt 왕십리  path="vanish-fallback"
```

swap 왕복이 **cron 1~2 cycle(60~120s)** 을 먹는다. 실측 지연:

| 역 | 통과 추정 | 발사 | 지연 |
| --- | --- | --- | --- |
| 장한평 | ~11:40 | 11:41:54 | +2분 |
| 답십리 | ~11:42 | 11:46:25 | +4.5분 |
| 마장 | ~11:44 | 11:47:24 | +3.5분 |
| 행당 | ~11:48 | 11:51:24 | +3.5분 |
| 을지로4가 | ~11:56 | 11:58:54 | +3분 |
| 광화문 | ~12:00 | 12:03:54 | +4분 |

첫 두 hop에서 3~4분이 쌓이고 그 뒤 **고정**된다. 5호선 역간 ~2분 → **1.5~2정거장**. 사용자 체감과 일치.

## 근본 (confirmed)

`boardingPrompt.ts:468`:
```ts
const directional = direction
  ? matching.filter((a) => (direction === 'up' ? a.isUp : !a.isUp))
  : matching;   // ← direction이 null이면 양방향 허용
```

`legDirection.ts:24` 주석:
> **그 외** (**1/5**/gyeongui 등 비단조/지선): null 반환. caller 는 기존 direction=null 동작 유지 (**현재 회귀 봉쇄 효과 0**, 기존 implicit segmentStations 필터에 의존)

`lineTopology.json`:
```
monotonicLines: ['3','4','7','8','9','airport','bundang','sinbundang']
closedLoops:    ['2','6']
```
> 다음 노선들은 단조 배열로 표현 불가하므로 제외: **1호선(다중 종착/지선), 2호선(순환선), 5호선(마천/상일동 분기), 6호선(응암 루프), 경의중앙선(다중 갈래)**

2·6은 `closedLoops`가 받는다. **1호선 · 5호선 · 경의중앙선은 어디에도 없어 `null`** → 방향 필터 전체 비활성 → 반대 방향 열차가 프롬프트에 제시 → 사용자 탭 → 반대 방향 lock.

---

# 1. 양방향 감사 (`/audit-sides` 축 + L20 신호 소비자 축)

## 축 1 — 레이어 비대칭 🔴 **편측 확정**

| 레이어 | 함수 | 전 노선 커버? |
| --- | --- | --- |
| **backend** | `legDirection.ts:68 inferLegDirection` | **아니오** — `MONOTONIC_LINES`/`CLOSED_LOOPS` 화이트리스트 밖이면 `null`(1·5·경의중앙) |
| **device** | `directionOnLine.ts:30 directionOnLine` (#2455) | **예** — `shortestLinePathIndices`(`lineLoopPath.ts`) 위에서 첫 step의 idx 증감으로 판정. **화이트리스트를 보지 않는다.** null은 "역이 그 노선에 없음 / from===to"일 때만 |

**토폴로지 데이터는 공유한다** — backend가 `import lineTopology from '../../../src/data/lineTopology.json'`(`legDirection.ts:34`). 즉 **데이터 drift는 없고 로직만 비대칭**이다.

`directionOnLine` doc이 설계 근거를 적어뒀다:
> `resolveTravelDirection`(단조 노선)/`inferLoopDirection`(호 길이 비교)을 조합하지 않는 이유: 2호선 순환선 seam(시청↔충정로)에서 그 두 유틸의 wraparound 판정이 **서로 어긋나는 사례를 발견**했다(#2455 설계 노트) — `shortestLinePathIndices` 기반 **하나의 알고리즘만 쓰면 이 불일치가 원천적으로 없다**

**backend의 `legDirection`은 정확히 그 "조합" 방식이다.** device가 이미 폐기한 접근을 backend가 쓰고 있다.

## 축 2 — 실패 방향 (오수용 ↔ 과차단)

| 방향 | 증상 | 10/9 | 위험 |
| --- | --- | --- | --- |
| **오수용** (방향 불명 → 양방향 허용) | 반대 방향 열차 제시·lock | **실측 확정** | 전 trip 알림이 1~2정거장 밀림. 최악은 목적지 반대로 안내 |
| **과차단** (방향 판정이 틀려 정답 열차 배제) | 후보 0건 → 프롬프트 미발사 / lock 미형성 | — | **G-1 수정이 새로 만들 수 있는 위험.** 지선 교차 쌍에서 `shortestLinePathIndices`가 분기점을 가로지르면 오판 가능(**candidate**) |

**둘 다 ADR-010상 동급**이다. G-1은 오수용을 막으면서 과차단을 만들지 않아야 한다.

## 축 3 — 신호 소비자 전수 판정 (J0 **재실행 완료**, 2026-10-10) 🔴

**1차 판정은 틀렸다.** grep 패턴 하나로 스캔하고 "전수"라 불렀다. 재실행에서 놓친 형태를 찾았다 — 기본값 주입(`||`/`??`), **옵셔널 파라미터 미전달**, 구조분해 기본값, 조합 폴백.

### fail-open — **8곳** (1차 4곳 → 재실행 8곳)

| 레이어 | 지점 | 코드/근거 | 비고 |
| --- | --- | --- | --- |
| backend | `boardingPrompt.ts:468` | `direction ? filter : matching` | 프롬프트 후보 |
| backend | `scheduled.ts:6519` | `if (direction === null) return arrivals;` | 방향 제한 무효화 |
| backend | `scheduled.ts:7656` | `(direction === null \|\| ...)` | leg-1 후보 |
| backend | `scheduled.ts:7657` | `directional.length > 0 ? directional : arrivals.filter(...)` | 0건이면 전체 복귀 |
| backend | **`boardingAnchorResolver.ts:214-216`** | `anchor.direction !== null ? positions.filter(...) : positions` | 🔴 **lock 승격 본체 — 10/9 lock이 이 경로** |
| backend | `arrivalsFromPositions.ts:106` | `if (direction !== null) { ... }` | 방향 필터 skip |
| **device** | **`pickCandidateTrains.ts:153`** | `direction !== undefined && train.updnLine !== direction` + `:15` `direction?: 0\|1` | 🔴 **옵셔널 미전달 시 필터 skip.** #2918이 이 파일을 건드렸으나 `undefined` 경로는 그대로 |
| **device** | `boardingPromptContext.ts:150` | `resolveTravelDirection(...)?.direction ?? inferLoopDirection(...)` | **#2455가 폐기한 "두 유틸 조합"** — `directionOnLine`을 쓰지 않음(device 내부 비일관) |

### fail-closed — backend 1곳 / device 7곳

backend: `boardingAnchorResolver.ts:254`(passed-anchor 확장만)
device: `isBoardableCandidate:66` · `useBoardingLockController:384` · `usePrevTrainCandidate:174` · `lastTrainAlarm:84` · `boardingPromptAutoLock:37` · `useBoardingPromptResponder:541` · `computeBoardableWaitsForRoute:85`

**1차 결론("device는 fail-closed")은 절반만 맞았다.** device는 **소비 지점에서 막고 생산 지점(`boardingPromptContext`·`pickCandidateTrains`)은 열려 있다.**

### 🔴 거짓 근거가 양 레이어 주석에 박혀 있다 (confirmed)

두 곳이 같은 말로 fail-open을 정당화한다:

- backend `lockSwap.ts:16-17`: *"추론 불가 노선(1/5/gyeongui)에서는 direction=null fallback → **stationName + segmentStations 인덱스 필터로 진행 방향 implicit 해소**(기존 동작 유지)"*
- device `boardingPromptContext.ts:148`: *"`pickAutoTrainCode`는 **stationName 필터로 implicit 방향 해소**(허용 가능한 false negative)"*

**그 implicit 해소의 실체**(`arrivalsFromPositions.ts:111-129`):
```ts
const currentIdx = segmentStations.indexOf(train.stationName);
if (currentIdx < 0) continue;              // leg 경로 밖이면 제외
if (currentIdx > targetIdx) { ...passed 창... }
const hops = targetIdx - currentIdx;        // 아직 안 온 열차
```

**경로상 "어느 역에 있는가"만 본다. 방향은 보지 않는다.** 5559는 군자(능동)에 있었고 군자는 `segmentStations[0]`이다 → `indexOf`=0 → `targetIdx` 이하 → **통과**. 반대 방향인데 걸러질 수가 없다.

→ **implicit 폴백은 "탑승역 그 자리에 있는 열차"의 방향을 원리적으로 구분할 수 없다.** 가장 중요한 순간에 무력하다. `legDirection.ts:31`이 `segmentStations.length < 2` 시 null을 "**안전**"이라 적은 것도 틀렸다 — null은 양방향 허용이다.

**조치**: 이 근거를 양 레이어에서 **제거**하고 `docs/agents/invariants.md`에 "거짓 근거 — 재사용 금지"로 기록한다. 주석이 남으면 다음 사람이 또 그걸 근거로 fail-open을 남긴다.

### #1719는 의도된 절반 fix였다 (confirmed)

`legDirection.ts:6-8` 헤더가 **10/9 실패 모드를 정확히 서술하고** 모듈을 만들었다:
> `lockSwap.attachTrainCodeForLeg`는 `direction=null`로 호출하므로, **양방향 trains가 같은 station에 있으면 wrong direction train도 candidate로 통과**한다. 2호선 외선/내선, 6호선 응암 방향 train 같은 사례에서 **silent push 정확도 회귀**.

그리고 `:24`에서 1/5/경의중앙을 **"현재 회귀 봉쇄 효과 0"** 으로 명시하고 남겼다. **10/9은 예고된 결과가 5호선에 착륙한 것이다.**

### J0 재실행의 결론

- H-6 범위: backend **4곳 → 6곳**. 특히 `boardingAnchorResolver.ts:214`(lock 승격)를 빼면 프롬프트만 막고 **device sync promotion이 여전히 반대 방향 lock을 만든다** — 10/9 lock이 그 경로다
- **H-7 신규 필요**: device `pickCandidateTrains.ts:153` + `boardingPromptContext.ts:150`(+ `directionOnLine`으로 통일)
- 거짓 근거 주석 제거 + invariants 기록

## 축 4 — 상태 매트릭스

| 상태 | 방향 판정 입력 | 비고 |
| --- | --- | --- |
| origin lock (leg-1) | `promptDisplay` 기반 | leg-2와 다른 경로 — 함께 고쳐야 편측 아님 |
| leg lock (leg-2+) | `currentLegAnchor` + `segmentStations` | 10/9 실패 지점 |
| lockless | 방향 필터 적용 여부 미확인(**candidate**) | |
| 지상/지하 | 방향은 route 파생이라 GPS 무관 | ADR-039 표시 축과 독립 |

## 축 5 — 시간축

| 구간 | 위험 |
| --- | --- |
| 환승 직후 | `currentLegAnchor` stamp 직후 — segmentStations 미완성 가능 |
| 트립 꼬리 | 마지막 1-hop에서 `segmentStations.length < 2` → 방향 판정 불가(doc에 caller fallback 명시) |
| route 재계산 후 | `route-signature-mismatch` 약 30회(10/9) → 방향 기준이 되는 segmentStations가 교체됨 |

---

# 2. WHOLE 체인 — 방향이 관여하는 전 구간

```
경로 확정 → 후보 열거 → 프롬프트 제시 → 사용자 탭 → lock 부착
         → 매역 arvlCd 확증 → 발사 → ETA/LA 표시 → 목적지 확정
```

| # | 단계 | 방향 사용 | 10/9 결과 |
| --- | --- | --- | --- |
| 1 | 후보 열거 | `pickAutoTrainCode` 방향 필터 | **비활성(null)** → 반대 방향 포함 |
| 2 | 프롬프트 제시 | 1의 결과 1개 | **반대 방향 열차 제시** |
| 3 | 사용자 탭 | — | 정상(11:37:39) |
| 4 | lock 부착 | `isLockConsistentWithRoute` / `lockSwap` | **반대 방향 lock 수용** |
| 5 | 매역 확증 | lock trainCode로 ETA 추정 | **매 역 `matched:false`** → vanish-swap |
| 6 | 발사 | swap 후 대체 열차 | **1~2정거장 지연** |
| 7 | ETA/LA | 같은 lock 기반 | 표시도 밀림(ADR-039 축과 중첩) |
| 8 | 목적지 | waypoints 소진 | 12:03:28 종료(실제 ~12:00 도착, +3.5분) |

**방향 오류 1건이 1→8 전 구간을 오염시킨다.** 단일 지점 수정이 아니라 체인 전체의 전제다.

---

# 3. 방안 (트레이드오프)

## H-1 — backend가 device의 `directionOnLine` 알고리즘을 채택

`legDirection.inferLegDirection`의 화이트리스트 분기를 버리고 `shortestLinePathIndices` 기반 단일 알고리즘으로 교체(device와 동일).

- **장점**: ①**전 노선 커버**(1·5·경의중앙 포함) ②레이어 비대칭 **원천 제거** — 두 레이어가 같은 알고리즘 ③device가 #2455에서 이미 "조합 방식의 wraparound 불일치"를 발견해 폐기한 접근을 backend에서도 버린다 ④신규 데이터 불필요(토폴로지는 이미 공유)
- **트레이드오프**: ①`shortestLinePathIndices`가 **지선 분기를 가로지르는 쌍**에서 올바른지 미검증(**candidate**) — 5호선 마천/하남 분기, 1호선 다중 종착 ②`getStationsOnLine` 순서에 의존 ③backend에 device util을 import할지(경계 룰) vs 이식할지 결정 필요 — 이식하면 **또 두 사본**이 된다
- **비용**: 2~4일 + 지선 교차 검증

## H-2 — Seoul `updnLine`을 1순위로, 경로 파생은 교차검증용

열차의 `updnLine`(실측값)과 사용자 진행 방향을 비교해 필터. `reversedOrientationLines` 주석에 **2026-10-06 전 노선 실측 프로브(표본 136건)** 로 `updn↔idx` 관계가 **1·5호선 포함 전 노선 확정**돼 있다.

- **장점**: ①**실측 ground truth 기반** — 추론이 아니다 ②화이트리스트 자체가 불필요 ③프로브 근거가 문서화돼 있어 "왜 이 매핑인가"에 답이 있다
- **트레이드오프**: ①`updnLine` **형식이 엔드포인트마다 다르다** — `reference_seoul_updnline_format_differs`: position=숫자('0'=상행), **arrival=한글**. 두 소스를 쓰는 코드가 많아 파싱 통일이 선행 ②`isUp`이 이미 그 정규화를 하는지 확인 필요 ③Seoul 피드가 틀릴 때 폴백이 없다(경로 파생을 폴백으로 남겨야 함) ④사용자 진행 방향 자체는 여전히 경로에서 와야 한다 — H-2는 **열차 쪽만** 해결
- **비용**: 2~3일 + 파싱 전수 점검

## H-3 — 두 소스 교차검증 (경로 파생 AND `updnLine`)

둘이 일치할 때만 후보 인정. 불일치면 **보수적으로 배제**하고 계측.

- **장점**: ①오수용 위험 최소 ②불일치 자체가 **관측 신호**가 되어 어느 소스가 틀리는지 데이터가 쌓인다 ③#2877 프로브 방식의 상시화
- **트레이드오프**: ①**과차단 위험 최대** — 한 소스만 null이어도 배제하면 10/9 같은 trip에서 후보 0건이 될 수 있다(ADR-010 위반 방향) ②불일치 시 처분 정책이 또 하나의 결정 ③두 소스 모두 구현해야 하므로 비용이 H-1+H-2
- **비용**: 4~6일

## H-4 — 화이트리스트를 유지하되 **1·5·경의중앙을 실측 기반으로 추가**

`monotonicLines`에 추가하지 않고, `lineTopology.json`에 **분기 인식 메타**(trunk 구간 + 분기별 ID 범위)를 새로 넣어 그 안에서 단조 비교.

- **장점**: ①기존 구조 보존 — 수정 범위 최소 ②분기 문제를 **데이터로** 명시 해결(CLAUDE.md "데이터 주도" 정합) ③`closedLoops`가 이미 `mainIdRange`로 같은 패턴을 쓴 선례
- **트레이드오프**: ①**노선 추가/연장 때마다 데이터 갱신 의무** — `_endpoints_comment`가 이미 "노선 연장 시 본 endpoints 먼저 갱신"이라 적었고 그게 지켜지지 않아 "신규 연장(석남/진접/별내/중앙보훈병원 등)을 미반영"이라고 자백한다 ②레이어 비대칭은 **그대로 남는다**(device는 화이트리스트를 안 보니까) ③"전 노선"을 데이터로 열거하는 건 영구 유지보수 부담
- **비용**: 3~5일 + 분기 메타 작성

## H-5 — 정확성 게이트 보강 선행 (신규, 현재 코드에 없음)

방향 판정을 고치기 전에 **전 노선 × 양방향 방향 판정 진실표**를 실측으로 만들고(2026-10-06 프로브 재현·확장), 그 표를 **불변 fixture**로 박아 CI에서 상시 검증. 그 위에서 H-1~H-4 중 하나를 고른다.

- **장점**: ①"전 노선에서 정확"을 **측정 가능한 명제**로 만든다 — 지금은 판정할 수단이 없다 ②어느 안을 고르든 **회귀 안전망**이 먼저 생긴다 ③#2877 프로브가 선례이고 그 데이터가 주석에 남아 있어 재현 가능
- **트레이드오프**: ①**가장 느리다**(1~2주) — 사용자가 다음 라이드에서 또 겪는다 ②프로브는 운행 시간대 실측이 필요(새 라이드는 아니지만 실 API 스냅샷) ③진실표가 완성돼도 fix는 별도 작업
- **비용**: 1~2주

---

## H-6 — backend fail-open → fail-closed (device #2696 정책과 정합) 🔴 **H-1의 필수 짝**

J0에서 확정된 backend 4곳을 "방향 모르면 배제"로 전환한다. device가 이미 그 정책이다.

- **장점**: ①**잔여 null 경로까지 봉합** — H-1이 못 덮는 4개 경로(지선 교차·꼬리·재계산·역 부재)에서도 반대 방향 유입 차단 ②**레이어 정책 통일** — 같은 상황에 두 레이어가 반대로 행동하는 것 자체가 결함 원천 ③#2696 결정의 미반영을 해소
- **트레이드오프**: ①**단독 머지 시 과차단** — H-1 없이 H-6만 들어가면 5호선에서 후보 0건 → **프롬프트가 아예 안 뜬다**(10/9보다 나쁨) ②`scheduled.ts:7657`의 "0건이면 전체로 되돌림"을 제거하면 **의도적 폴백을 없애는 것**이라 그 폴백이 왜 있었는지 확인이 선행 ③방향 판정 실패율이 높은 노선에서 후보가 줄어든다 → 계측 필요
- **비용**: 2~3일 + `:7657` 폴백 근거 조사

### H-6 선행 조사 결과 (2026-10-10 완료) — **단순 삭제가 아니다**

`scheduled.ts:7657`의 폴백은 **#1739(2026-06-24, "boardingPrompt push 메시지 방면 + 시간 명시")** 에서 도입돼 #2531·#2847 리팩터를 거쳐 남았다. `pool`이 **세 용도를 동시에** 먹인다:

```
pool = directional.length > 0 ? directional : arrivals.filter(matchLine)   ← :7657 폴백
  → etaSeconds        (:7659)  메시지의 "HH:MM 진입"
  → candidateTrains   (:7663)  푸시 payload 후보 목록
  → selectedTrainCode (:7696)  pickAutoTrainCode(pool, line, direction) ← lock 대상
```

**이중 fail-open (confirmed)**: `:7696`이 `pool`(이미 폴백으로 방향 무시 전체일 수 있음)과 `direction`(null이면 `:468`에서 또 전부 허용)을 함께 넘긴다 — **같은 방향 가드가 두 겹 모두 열려 있고 10/9에 둘 다 열렸다.**

**따라서 `:7657`을 통째로 지우면 #1739의 원래 목적(ETA 표시)이 깨진다.** 용도별로 분리해야 한다:

| 용도 | 방향 미상 시 | 근거 |
| --- | --- | --- |
| `etaSeconds` (표시) | **폴백 허용** | 시간 표시 오차는 피해가 작고 #1739의 본래 목적 |
| `candidateTrains` (payload) | **fail-closed** | 사용자에게 반대 방향 열차를 보여준다 |
| `selectedTrainCode` (**lock 대상**) | **fail-closed 필수** | 반대 방향 lock = 10/9 사고 본체 |

→ H-6은 "폴백 삭제"가 아니라 **`pool`을 표시용/판정용 두 개로 쪼개는 것**이다.

**순서 제약 (hard)**: **H-1을 먼저 머지한다.** H-1 단독은 회귀가 없다(현재 fail-open이 유지될 뿐 악화 없음). H-6 단독은 과차단 회귀다. **H-6은 H-1 머지 후에만 머지한다.**

## K-1 — `stations.json` 지선·연장 보강 🔴 **"전 노선 정확"의 전제**

#2945 머지 후 **지선 교차 검증이 여전히 불가능**하다 — 검증할 데이터가 없다. 직접 조회(2026-10-10) 결과:

| 노선 | 역 수 | 전 노선에서 0건 매칭인 역 | 성격 |
| --- | --- | --- | --- |
| **5** | 46 (마천 5-046에서 끝) | 고덕·상일동·강일·미사·하남풍산·하남시청·하남검단산 | **상일동/하남 지선 전체** |
| **2** | 45 | 신답·용답·도림천·양천구청 | **성수지선·신정지선 — 연장이 아니라 운행 중 기존 지선** |
| 7 | 51 | 석남·산곡 | 2021 연장 |
| 4 | 48 | 진접·오남·풍양 | 2022 연장 |
| 8 | 18 | 별내·다산·동구릉 | 2024 연장 |
| 1 | 63 | 서동탄·광명·신창·연천 | 지선/연장 |

(정정: 청량리는 `청량리(서울시립대입구)`, 서울역은 `서울역`으로 **존재**한다 — 단순 이름 비교 오류였다)

`lineTopology.json` `_endpoints_comment`가 연장 누락은 **이미 자백**했다:
> stations.json은 stationId 정렬용으로만 쓰이며 **신규 연장(석남/진접/별내/중앙보훈병원 등)을 미반영한 상태**

**그러나 2호선 성수지선·신정지선은 연장이 아니다.** 10/9 트립의 `trainLineNm`에 `성수지선` 센티널이 실제로 나왔다 — **운행하는 지선인데 역 데이터가 없다.**

### 이것이 #2945의 ⓒ 판정을 무효화한다

#2945 보고는 *"5호선 하남 교차 쌍은 표현 불가 → **안전**"* 이라 했다. **"안전"이 아니라 "그 사용자를 아예 서비스하지 못한다"** 는 뜻이다. 방향 판정이 안전한 이유가 **데이터 부재**다.

→ `shortestLinePathIndices`의 지선 교차 정확성은 **여전히 미검증**(검증 불가). 2호선 지선도 같은 이유로 테스트 불가.

- **트레이드오프**: ①역 추가는 `stationCodes`·`stationDistances`·`stationTravelTimes`·`firstLastTrainTimes`·`platformExitSide`·`quickExit` 등 **파생 데이터 동반 갱신**이 필요(CI `Data Validation`이 정합성을 검사) ②id 삽입이 기존 id 정렬 가정을 깨뜨릴 수 있다(단조 비교가 id 기반) ③운행 지선(2호선)과 미반영 연장(4·7·8)의 우선순위가 다르다
- **비용**: 2호선 지선만 1~2일 / 전체 1~2주

## K-2 — 1호선 분기 부호 의존을 명시 계약으로 고정

#2945 보고: *"1호선 구로(1-042)↔가산디지털단지(1-100) … forward slice 경로 자체는 **틀리지만**(인천 경유), 방향은 `path[1]` vs `fromIdx` **부호만 보므로** 양쪽 모두 구로보다 id가 커서 부호 일치 → 안전"*

**경로가 틀린데 부호가 우연히 맞는 것이다.** 분기 양쪽이 둘 다 구로보다 id가 크다는 **데이터 배치의 우연**에 의존한다 — 역 추가(K-1)나 id 재정렬 시 **조용히 깨진다**.

- **조치**: 그 우연을 **테스트로 고정**해 계약으로 바꾼다. 데이터가 바뀌면 테스트가 깨지도록. `docs/agents/invariants.md`에 "id 배치 의존 — 기계적 강제: 테스트"로 기록
- **트레이드오프**: 우연 자체를 제거하지는 않는다(제거하려면 분기 인식 알고리즘 = H-4 계열, 범위 큼). 깨짐을 **감지 가능하게** 만드는 데까지
- **비용**: 반나절

# 4. 추천

**H-1 → H-6 순차** + H-5 축소판. (2026-10-10 사용자 확정)

J0 전수 판정으로 **H-1 단독이 편측임이 확정**됐다 — backend fail-open 4곳 중 H-1이 덮는 건 "노선 화이트리스트" 원인뿐이다. H-6이 잔여 null 경로를 봉합한다. **순서는 고정**: H-1 먼저(회귀 없음) → H-6(단독이면 과차단 회귀).

- **H-1이 본체**다. 레이어 비대칭이 confirmed된 편측이고, device가 이미 같은 문제(#2455 wraparound 불일치)를 겪고 폐기한 접근을 backend가 쓰고 있다. "전 노선 커버"를 **화이트리스트 유지 없이** 달성하는 유일한 안이다. H-4는 비대칭을 남기고 유지보수 부담을 영구화한다.
- **H-2는 폴백으로 흡수**한다 — 1순위로 올리면 `updnLine` 형식 이원화(position=숫자/arrival=한글)를 전수 정리하는 선행 작업이 생긴다. 경로 파생이 null일 때의 2순위로 두는 게 비용 대비 효과가 낫다.
- **H-3는 지금 기각** — 과차단 위험이 10/9와 같은 trip을 더 망칠 수 있다. 다만 **불일치 계측만** H-1에 얹는다(배제하지 않고 기록만) → 데이터가 쌓이면 나중에 H-3로 승격 가능.
- **H-5 축소판**: 전 노선 진실표를 1~2주 들여 만들기 전에, **10/9 트립을 replay fixture로 박는 것**부터 한다(반대 방향 lock이 재현되는 red). 그게 H-1의 red이고 동시에 회귀 앵커다. 전 노선 진실표는 H-1 머지 후 별도 트랙.

**선행 필수 — 축 3 전수 판정**: `direction === null`을 "전부 허용"으로 처리하는 소비자가 `pickAutoTrainCode` 외에 더 있는지 backend 12 / device 16 파일 전수 확인. 하나라도 남으면 H-1이 편측이 된다.

---

# 5. Acceptance (양방향 · WHOLE)

| # | 축 | 조건 | 판정 |
| --- | --- | --- | --- |
| AC1 | 오수용 | 사용자 진행 방향과 **반대인 열차가 프롬프트에 제시되지 않는다** — 전 노선 | 10/9 replay red→green + 노선별 양방향 단위 테스트 |
| AC2 | **과차단(역방향)** | 정답 열차가 방향 판정 때문에 배제되지 않는다 — 특히 **지선 교차·트립 꼬리·route 재계산 직후** | 거부 케이스 replay. **후보 0건이 되면 fail** |
| AC3 | 레이어 | backend·device가 **같은 입력에 같은 방향**을 낸다 | 두 레이어 교차 테스트(동일 station 쌍 × 전 노선) |
| AC4 | WHOLE | 10/9 트립 replay에서 `leg2-estimate matched:false` **0건**, `vanish-swap estimate-null` **0건** | D1 이벤트 기반 replay assert |
| AC5 | WHOLE | 같은 replay에서 매역 발사 지연이 **1정거장 이내** | 발사 시각 ↔ 실제 통과 추정 대조 |
| AC6 | 소비자 | `direction === null`을 "전부 허용"으로 처리하는 소비자 **0건** | 축 3 전수 판정 결과를 테스트로 고정 |
| AC7 | 회귀 | 기존 방향 판정이 맞던 노선(3·4·7·8·9·2·6·공항·분당·신분당)의 판정 **불변** | 전 노선 양방향 회귀 테스트 |

**close 조건**: PR 머지 ≠ close. AC1·AC4·AC5는 **10/9 실측 replay**로, AC3·AC7은 전 노선 교차 테스트로, AC6은 전수 판정으로 판정한다. 배포 후 D1에서 `vanish-swap estimate-null` 발생률 하락을 1주 측정.

---

# 6. TDD 순서

| # | 작업 | 상태 | 의존 |
| --- | --- | --- | --- |
| ~~J0~~ | 축 3 전수 판정 | **완료** (2026-10-10, §축 3) | — |
| **J1** | **10/9 반대 방향 lock replay fixture** — red 확인(5559가 후보에 포함됨) | | — |
| **J2** | **H-1** — backend가 `shortestLinePathIndices` 기반 단일 알고리즘 채택(화이트리스트 제거) | | J1 |
| **J3** | 지선 교차·꼬리·재계산 거부 케이스(AC2 과차단 방어) | | J2 |
| **J4** | 레이어 교차 테스트(AC3) + 전 노선 양방향 회귀(AC7) | | J2 |
| **J5** | **H-6** — backend fail-open 4곳 → fail-closed. `:7657` 폴백 근거 조사 선행 | | **J2 머지 후** |
| J6 | 불일치 계측(H-3 씨앗 — 배제하지 않고 기록만) | | J5 |
| **K-2** | 1호선 분기 부호 의존을 테스트로 고정 + invariants 기록 | | J2 머지 후(완료) — 즉시 가능 |
| **K-1** | `stations.json` 지선·연장 보강(2호선 운행 지선 우선) | | 독립. **"전 노선 정확" acceptance의 전제** |
| J7 | 전 노선 진실표(H-5 전체) | | K-1 후 |

J1이 red → J2가 green. **커밋 순서가 증거**(CLAUDE.md TDD 필수).

**J2와 J5를 한 PR로 묶지 않는다** — J5 단독 머지 시 과차단 회귀이므로 J2 머지 확인 후 J5를 올린다.

# 7. 기존 plan/이슈 연계

- `plan-2026-10-10-leg2-chain-single-fire.md` — **G-1이 그 plan의 5′보다 선행**이어야 한다. 5′는 "제시한 열차를 조회해 lock"이므로 **제시가 반대 방향이면 오류를 고정**한다
- `plan-2026-10-03-selfprogress-fastforward.md` — F-3(`trips.ts:403` 순방향 수용). **lock 타이밍·방향과 무관하게 위치를 자가 치유**하므로 G-1과 독립 병행 가능. 사용자 요구("한 번 늦었다고 서비스를 못 누리면 안 된다")의 구조적 답
- **#2780** leg-2 전이 확증이 사용자 증거 없이 lock / **#2754** 오탑승 lock 계보 / **#2696** 잘못된 lock 하나가 trip 전체 알림을 죽인다 — 전부 같은 계열. G-1이 그 상류
- **#2877** 전 노선 orientation 실측 프로브 — H-2/H-5의 데이터 선례
- **#2455** `directionOnLine` 추출(wraparound 불일치 해소) — H-1의 설계 근거
- ADR-039 표시 축 미결 — WHOLE 체인 7단(ETA/LA)과 중첩. 별도 결정

---

# 8. 범위 밖

- ADR-039 표시 축 권한(옵션 a~d 미결)
- `boardedAt` 기준점
- `MINIMAL_ALARM` dormant 코드 처분(ADR-040 §열려있는 결정 7)
- 릴리스 파이프라인(main 마지막 커밋 2026-05-14, 미출시 2,440 커밋)
