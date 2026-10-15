# Spec — boarding-prompt 조기 발사 봉합: arvlCd 임박 게이트(OR-fallback) + candidateArvlCds 계측

작성 2026-09-30. 근거 = 9/30 실측 트립 `e25e1158…35b3502c` D1 RCA.
관련 handoff: `memory/lesson_2026_09_28_backend_tracks_already_built_device_display_gaps.md` (B root).

---

## 0. 배경 / 근거 (D1 authoritative, 추정 없음)

9/30 트립(용마산7→건대입구 환승→line2→뚝섬), leg-2 건대입구 발사 실측:

```
06:42:11 leg-boarding-prompt outcome=fired     ← 조기 (열차 미도착)
06:43:08 leg-boarding-prompt outcome=silenced
06:44:10 leg-boarding-prompt outcome=fired     ← 반복 (5분 게이트 우회)
06:46:08 leg-resolve candidate 3056 trainSttus=1(도착)   ← 열차는 여기서야 도착
06:48:10 leg-resolve confirmed 3056 trainSttus=2(출발)
```

- **root (a) 조기 [이 PR 대상]**: 발사 요구사항이 코드 doc(`scheduled.ts:7405` — "임박 열차 있으면 발사")에 명시돼 있으나 구현이 미강제. `fireBoardingPromptForAnchor`(7466-7496)의 유일 게이트는 `candidateTrains.length===0`(7493) — `candidateTrains`는 노선/방향만 필터한 **아무 열차**(전역출발3·운행중99 포함, arvlCd 필터 없음). `#2801`이 walk-gate(`legBoardingEligibleAt`, 시간 기반) 제거 → "너무 늦음" 고치려다 "너무 이름"으로 뒤집힘.
- **root (b) 반복 [별개, 이 PR 아님]**: cron이 trip을 `listTrips`에서 `cacheTtl:30s`(KV 최소값, 0 불가 #1364)로 읽어 직전 cycle `putTrip`한 `legBoardingPromptState.lastFiredAt`이 KV eventual-consistency로 간헐 불가시 → repeat gate 우회. 후속 PR(정합성-안전 dedup).
- **root (c) 마커 스팸 [진단용, 무해]**: (b)와 동일 root의 `readSsot` 버전. 이 PR에서 안 건드림.

---

## 1. 이 PR이 강제하는 불변식

> **"탑승하셨나요?" 프롬프트는 탑승 가능한 열차가 승강장에 있을(임박) 때만 발사한다. 그 전에는 발사 금지.**
> **단, arvlCd 관측 불가(지하/API 부재)면 기존 동작을 보존한다(막지 않는다) — equal-protection.**

임박 정의(코드베이스 기존 정의 확장): `ENTERING(0)`, `ARRIVED(1)`, `DEPARTED(2)`.
- 0/1 = 승강장 진입/도착.
- 2(출발) 포함 이유: cron 60s 폴링 > 도착 창(~30s)이라 진입→도착→출발이 한 폴링 갭에 지나갈 수 있음 + `pickAutoTrainCode`(boardingPrompt.ts:513) lock-pick 우선순위가 이미 `2>1>0`(회고형: 푸시 도착·탭 시점엔 열차가 출발함 = 사용자가 그 열차에 탐). 발사 게이트와 lock-pick 의미 정합.
- 제외: `PREV_DEPARTED(3)`, `PREV_ARRIVED(5)`, `RUNNING(99)`, `PREV_ENTERING(4)` = 정거장 밖 = 조기.

---

## 2. 게이트 로직 (pure 함수)

```ts
// 상수 (SSoT: shared/constants/arrivalCodes.ts ARRIVAL_CODE 재사용)
const IMMINENT_BOARDING_ARVLCD = new Set([
  ARRIVAL_CODE.ENTERING, // 0
  ARRIVAL_CODE.ARRIVED,  // 1
  ARRIVAL_CODE.DEPARTED, // 2
]);

type BoardingFireDecision =
  | { fire: true;  decision: 'imminent' }
  | { fire: true;  decision: 'fallback-unobservable' }
  | { fire: false; decision: 'suppressed-not-imminent' };

function decideBoardingPromptFire(pool: readonly {arvlCd: number|null}[]): BoardingFireDecision {
  const imminent = pool.filter(a => a.arvlCd !== null && IMMINENT_BOARDING_ARVLCD.has(a.arvlCd));
  if (imminent.length > 0) return { fire: true, decision: 'imminent' };
  // 관측 불가(arvlCd null)가 하나라도 있으면 임박을 배제할 수 없음 → 기존 동작 보존(지하 fallback)
  if (pool.some(a => a.arvlCd === null)) return { fire: true, decision: 'fallback-unobservable' };
  // 모든 후보가 관측됨 AND 임박 0 → 조기 확실 → 억제 (이 PR의 유일한 신규 억제)
  return { fire: false, decision: 'suppressed-not-imminent' };
}
```

**핵심 안전장치**: suppress는 "**모든** 후보 arvlCd가 non-null **이고** 임박이 하나도 없을 때"만. arvlCd가 하나라도 null이면(지하 특성) fire — miss 재발 방지 = equal-protection.

device(-1=미관측)는 `arvlCd === null` 대신 `arrivalCode < 0`으로 동일 판정.

배치 위치(중복 방지): `backend/alarm-worker/src/boardingPrompt.ts`에 pure export. device는 features→backend import 금지 룰이라 `src/features/alarm/utils/localBoardingPromptGate.ts`에 값 동기 포팅(기존 `LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M` 선례와 동일 주석 규약).

---

## 3. 변경 파일 & 적용 지점

1. **`backend/alarm-worker/src/boardingPrompt.ts`** — `IMMINENT_BOARDING_ARVLCD` 상수 + `decideBoardingPromptFire` pure export.
2. **`backend/alarm-worker/src/scheduled.ts`** `fireBoardingPromptForAnchor`(7466-7500):
   - `candidateTrains.length === 0` 게이트(7493) **다음**에 `const gate = decideBoardingPromptFire(pool);`.
   - `!gate.fire`이면 신규 콜백 `onSuppressedNotImminent(gate.decision, arvlCds)` 호출 후 `return`(발사 전).
   - 각 caller(`maybeFireOriginBoardingPromptGpsFree` / `maybeFireLegBoardingPrompt`)가 콜백에서 stats(`*Blocked`) + D1 라벨 기록.
3. **`src/features/alarm/utils/localBoardingPromptGate.ts`**(:75):
   - `hasArrivingTrain` 계산을 `decideLocalBoardingPromptFire(directionSlice, line)`로 교체 — 동일 로직, `arrivalCode < 0` = 미관측 fallback.
   - skip reason에 `'suppressed-not-imminent'` 추가(기존 union 확장).
4. **계측 (신규 KV write 0 — 기존 meta 확장만)**:
   - `leg-boarding-prompt` / origin gps-free의 기존 `trip_events` meta에 `candidateArvlCds: number[]`, `gateDecision` 필드 추가.
   - suppress 경로도 outcome을 기록해 D1에서 조기-억제 관측 가능하게(기존 transition 기록 재사용, 신규 per-cycle write 금지 — #2073 quota).

---

## 4. 금지사항 (하드)

- **arvlCd 하드 필터 금지** — `pool.filter(imminent)` 후 그걸 candidateTrains로 쓰면 지하(null)가 전부 탈락해 miss 재발. 반드시 §2 OR-fallback decision으로 fire 여부만 판정하고, candidateTrains(payload용)는 **기존 pool 그대로** 유지.
- **repeat gate(b) / SSoT cacheTtl(c) 손대지 말 것** — 별개 PR.
- **새 GitHub 이슈 남발 금지** — 기존 이슈 매핑(§8).
- **fixture 실측값 조정 금지** — 통과시키려 기존 replay fixture 수정 X.
- **GPS 9단 경로 코드 이번 PR에서 구현 변경 금지** — §7 audit 결과만 문서화(스코프 통제).

---

## 5. 테스트 (TDD red-first — test 커밋이 fix 커밋보다 앞서야 함)

pure 함수 red 케이스 (`decideBoardingPromptFire` / device 버전):
1. 지상 임박(arvlCd=1 존재) → `fire:true, imminent`.
2. **지상 먼 열차만(arvlCd=[3,99]) → `fire:false, suppressed-not-imminent`** ← 조기 회귀 재현 red (현 코드는 fire).
3. 지하 전부 null(arvlCd=[null,null]) → `fire:true, fallback-unobservable` (miss 방지).
4. 혼합(arvlCd=[99, null]) → `fire:true, fallback-unobservable` (관측 불가 우선, miss 방지).
5. 출발만(arvlCd=[2]) → `fire:true, imminent` (회고형 정합).
6. device -1 미관측(arrivalCode=[-1]) → `fire:true, fallback`.
- **결과값 + decision 사유까지 assert**(다른 이유로 통과 금지).

whole-trip 시나리오(기존 `whole_trip_3leg_e2e` / `replay_*` 확장 — 신규 gate의 신규 시나리오이지 실측 fixture 조정 아님):
- leg-2 arrivals feed에 far-only(arvlCd=3) 주입 → `leg-boarding-prompt fired` **0건** assert (06:42/06:44 조기 봉합 증명).
- 이어 arvlCd=1 주입 → fired 1건 assert (열차 도착 시 정상 발사).
- 지하 시나리오: arvlCd=null feed → fired 유지 assert (기존 보존).

---

## 6. 검증 한계 (정직 — 라이드 검증에 의존하지 않기 위한 명시)

- 9/30 실측 arrivals feed(발사 시점 arvlCd)가 D1에 **없어** 그 트립을 exact replay 불가. → 이 PR의 §3.4 계측(`candidateArvlCds`)이 **다음 트립부터 exact replay를 가능케 하는 선행 장치**.
- 따라서 이 PR의 whole-trip 테스트는 gate **계약 시나리오**(far→suppress / imminent→fire / null→fire)로 성립하며, 이는 "실측-불변 fixture 조정"이 아니라 신규 게이트의 신규 계약 검증이다.
- 실기기 라이드는 배포+재빌드 후 최종 sanity — 1차 검증 아님.

---

## 7. GPS 9단 경로 audit (구현 변경 X, 문서화만)

`evaluateAndMaybeFireBoardingPrompt`(scheduled.ts:6883)는 공유 본체를 쓰지 않고 **자체 `sendBoardingPromptPush`@7271**로 발사(발사 경로 3개 중 ①). 불변식은 3경로 전부 적용돼야 하므로:
- 확인 항목: 이 경로가 arrivals(arvlCd)를 fetch하는지 / 임박 precondition이 있는지.
- 있으면 "커버됨"으로 문서화, 없으면 **후속 PR**로 동일 게이트 적용(이 PR에서 구현 X — 스코프 통제).
- PR 본문에 audit 결론 명시.

---

## 8. Wire-completion 5단

1. **Orphan**: 신규 export(`decideBoardingPromptFire`, `IMMINENT_BOARDING_ARVLCD`, device 버전) caller 존재. `npm run lint:orphan` pass.
2. **V/X dashboard**: `gateDecision`/`candidateArvlCds` → D1 `trip_events` meta + wrangler tail. 조회: `SELECT ts,kind,meta FROM trip_events WHERE kind IN ('leg-boarding-prompt') AND meta LIKE '%suppressed-not-imminent%'`.
3. **의존 PR**: 없음(backend+device 한 PR). backend=배포, device=재빌드.
4. **측정 plan**: 배포 후 1주 D1로 `gateDecision` 분포 조회 — (i) suppressed-not-imminent 발생(조기 차단 작동), (ii) fallback-unobservable 비율(지하 보존), (iii) leg-boarding-prompt fired 반복(b) 잔존 빈도(→ (b) PR 필요성 판단 근거).
5. **Device verify**: device 게이트는 FG only 재빌드 필요. backend 게이트는 배포만. 시나리오: 지상역 승강장 도착 전 프롬프트 안 뜸 / 지하 승차 시 여전히 뜸.

---

## 9. 회귀 안전 ("되던 게 안 되지 않게")

| 대상 | 영향 |
|---|---|
| lock 활성 trip | 프롬프트 발사 경로 미사용 → 무영향 |
| 지하 / arvlCd 부재 | **fallback fire로 기존 동작 보존** — miss 재발 방지(핵심) |
| 명시 의향(promptOptIn/infoModeEnabled) | 상위 게이트(7829) 유지, equal-protection 보존 |
| leg-1 gps-free + leg-2 | 공유 본체라 동시·일관 적용 |
| GPS 9단 경로(@7271) | 이 PR 미변경, §7 audit로 후속 판단 |
| 취침 모드 | 프롬프트는 취침 알람과 독립 경로 → 무영향 |

환경 매트릭스: 지상(조기 차단)·지하(보존)·환승 leg-2(동일). 권한 매트릭스: backend cron=서버측(권한 무관), device 게이트=FG only.

---

## 10. 커밋 순서 (TDD 증거)

1. `test(#N): red — boarding-prompt 조기 발사(먼 열차만 arvlCd 3/99) 억제 미구현`
2. `feat(#N): boarding-prompt arvlCd 임박 게이트(OR-fallback) + candidateArvlCds 계측`
3. `test(#N): device localBoardingPromptGate 임박 parity`

PR 본문에 **test-first 명시**(커밋 순서로 검증 가능).
