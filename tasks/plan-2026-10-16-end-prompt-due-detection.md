# plan 2026-10-16 — #3007 PR-A: 정지 15분 "종료 제안 시점"을 backend가 판정 + D1 계측

> **스코프**: backend only. **동작 변경 0** — 판정 + D1 적재만. LA content 필드·Swift 버튼은 PR-B,
> device pause backstop 제거는 PR-C.
>
> **왜 content 필드를 먼저 넣지 않는가**: Swift ContentState에 그 필드가 없으면 보내도 렌더되지
> 않는 inert wire가 된다(#3000은 위젯이 **이미 렌더하던** `boardingPhase`를 채운 것이라 달랐다).
> 판정+계측을 먼저 깔면 **실데이터로 발동 빈도를 먼저 확인**할 수 있고 dead wire가 생기지 않는다.

## 확정 조건 (#3007, 사용자 승인 2026-10-16)

**트립 활성 + 이동 없음 15분** — `pausedAt` 무관(②). `pausedAt`은 표시 차이로만 쓴다.

## 설계 — 상태 저장 0, KV 쓰기 0

### 1. 정지 판정은 **기기 모션 플래그가 아니라 변위**로 한다

`motionEvidence[].signal = { lat, lng, motion }`(`motionState.ts:228-236`)에 **좌표가 들어 있다.**
`motion`(CMMotionActivity)만 쓰면 안 된다 — `lesson_motion_activity_intermittent_signal` +
#2763이 *"CMMotionActivity가 승차 중에도 간헐적으로 'stationary'를 보내는 실측 패턴"*을 이유로
이미 그 신호를 완화했다. 따라서 **GPS 변위**로 판정하고 기존 자산을 그대로 재사용한다:

| 재사용 | 출처 |
| --- | --- |
| `maxDisplacementMeters(samples)` | `motionState.ts:86` — 이미 export, 임의 sample 배열을 받는다(윈도우 자유) |
| `MOTION_STATIONARY_DISPLACEMENT_M = 10` | `motionState.ts:51` |
| `MOTION_MIN_SAMPLES = 10` | `motionState.ts:48` — 샘플 부족 시 판정 불가 |
| `SSOT_MOTION_WRITE_MIN_INTERVAL_MS = 25_000` | `motionState.ts:64` — 윈도우 커버리지 tolerance |
| `CRON_INTERVAL_MS = 60_000` | `cronConstants.ts:13` — due-tick 마진 |

**신규 상수 1개** — `END_PROMPT_STATIONARY_MS = 15 * 60_000`. device `PAUSE_AUTO_END_MS`
(`src/shared/constants/realtime.ts:298`)와 **같은 값의 backend 미러**다(backend는 device 상수를
import할 수 없다). 새 임계를 만드는 게 아니며, 한쪽을 바꾸면 다른 쪽도 바꿔야 한다는 사실을
주석에 박는다.

### 2. "방금 15분을 채웠다"를 **상태 없이** 판정한다

마커를 SSoT/trip에 저장하면 **KV 쓰기가 생겨 쿼터 문제를 쿼터로 고치는 꼴**이 된다. 대신:

```
hasBeenStationaryFor(ssot, now, D) =
  evidence 중 source==='device-position' && ts ∈ [now-D, now]  → slice
  slice.length >= MOTION_MIN_SAMPLES                            (샘플 부족 → false)
  && oldest(slice).ts <= now - D + SSOT_MOTION_WRITE_MIN_INTERVAL_MS   (윈도우 실제 커버)
  && maxDisplacementMeters(slice) < MOTION_STATIONARY_DISPLACEMENT_M

isEndPromptDue(ssot, now) =
  hasBeenStationaryFor(15분) && !hasBeenStationaryFor(15분 + CRON_INTERVAL_MS)
```

cron이 1분 주기(`crons = ["*/1 * * * *"]`)이므로 **정확히 한 tick**만 이 조건을 만족한다 →
중복 적재 없음, 저장 없음. 정지가 20분째 이어지면 둘 다 true → 적재 안 함(due 시점이 이미 지남).

**fail-safe**: evidence ring이 윈도우를 못 덮으면(cap 50 × 25s ≈ 20.8분이 상한) `false` →
**제안하지 않는다**. 잘못된 종료 제안보다 침묵이 낫다.

### 3. 훅 — 추가 KV read 0

`scheduled.ts:1732`가 이미 `stationarySsot`을 읽는다(`cacheTtl` 캐시 공유). 그 **직후**,
stationary-skip `continue`(`:1745`) **앞**에 배치한다 — 뒤에 두면 정지 트립이 `continue`로
빠져나가 판정 자체가 실행되지 않는다.

### 4. 적재

`trip_events` 신규 kind `'end-prompt-due'` 1건. `meta = { displacementM, sampleCount, windowMs }`.
D1 write만(KV 0). `cleanupTripEvents`가 7일 초과분을 삭제.

## acceptance

1. **test-first**(backend vitest) — 아래 전부 분리 assert(합산 카운트 금지):
   - 15분 정지 due tick → `end-prompt-due` 1건
   - 20분 정지(due 지남) → **0건**
   - 15분 미만 → 0건
   - 윈도우 내 변위 50m → 0건
   - 샘플 9건(부족) → 0건
   - evidence가 윈도우 미커버 → 0건 (fail-safe)
2. **revert-red** — 판정 본체를 되돌리면 위 "1건" 케이스가 red가 되는 것을 눈으로 확인.
3. **동작 불변** — 기존 stationary-skip / 발사 / advance 동작 무변경(기존 테스트 전부 green).
4. **측정** — 배포 후 `SELECT COUNT(*) FROM trip_events WHERE kind='end-prompt-due'`가
   좀비 트립 발생 시 1 이상. #3006의 `expired` 종료 비율과 교차 확인.

## 범위 밖
- LA content 필드 + alert + Swift `EndTripIntent` → PR-B
- `useStateRehydration.ts:288` pause backstop 제거 → PR-C
- 실제 종료 실행(사용자가 버튼을 눌렀을 때) → 기존 `useAlarmEndTripResponder`/
  `tripEndedCleanupSequence` 재사용, 진입 채널만 LA로 바뀜(PR-B)
