# plan — `trip_metrics` 구간 절단: 측정 신뢰도 복구

## 1. 확정된 사실

### 1-1. 실측 — 10/13 행이 23분 트립의 75초만 담았다

```
10-13 20:36:53 → 20:53:36  user-delete         성수  ["2"]      f=0   ← 유령 트립(#2973이 차단)
10-13 06:45:41 → 06:46:56  destination-arrived 성수  ["2"]      f=1   ← 절단. 7호선 구간 없음
10-09 11:30:15 → 12:03:24  destination-arrived 중곡  ["7","5"]  f=12  ← 33분 2노선, 정상
10-07 19:21:44 → 19:37:05  destination-arrived 뚝섬  ["2","7"]  f=2   ← 정상
```

실제 10/13 트립은 **06:23:50 시작(7호선 용마산)** 이고 D1 `trip_events`에 22건이 남아 있다. metrics는 **마지막 2호선 구간만** 담았고 7호선 구간은 **행이 아예 없다**.

### 1-2. 기전 — 두 컬럼이 같은 하한을 쓴다

`d1TripMetrics.ts`
```
:90  startedAt: trip.createdAt
:78  firedCount      = countFireAttemptsByOutcome(db, tokenHash, trip.createdAt, endedAt, 'sent')
:82  suppressedCount = countFireAttemptsByOutcome(db, tokenHash, trip.createdAt, endedAt, 'skipped-reason')
```

`trip.createdAt`이 뛰면 **`started_at` + `fired_count` + `suppressed_count` 세 컬럼이 동시에 망가진다.** 10/13: window 하한 06:45:41 → 06:45:32의 성수 발사가 **1초 차이로 창 밖**, 06:36:16 어린이대공원도 밖 → `f=1`(실제 sent 3건).

### 1-3. 미커버 선언 (검사 #4) — **상속, 정당성 없음**

`d1TripMetrics.ts:76`
> *"window 하한(`trip.createdAt`)은 `index.ts`의 **same-session 재등록 merge가 `existing.createdAt`으로 명시 고정한다**(리뷰 P1-3)."*

**#2628이 `same-session` 분기만 보장한다고 적어놨고 새 세션 분기는 언급하지 않는다.** `index.ts:1240`의 `{...incoming}` 분기는 `createdAt`을 교체한다. #2673(clear만)·#2958(환승만)·#2628(same-session만) — **같은 모양 세 번째.**

### 1-4. 왜 10/09는 정상이고 10/13만 절단인가 — #2975의 2차 피해

`isSameSession`(`index.ts:3804`) 판정은 2단이다:
1. 양쪽 `boardingLock.trainCode` 일치 → 같은 세션 (cold restart로 createdAt이 바뀌어도 유지)
2. trainCode 미사용 단계면 `createdAt` drift ≤ `SESSION_DRIFT_WINDOW_MS`

- **10/09**: lock 있음(`f=12`) → 1번 조건 성립 → `createdAt` 보존 → 33분 2노선 한 행
- **10/13**: **leg-1 lock 없음(= #2975 결함)** → 1번 불가 → 2번으로 떨어짐 → 환승 route 변경으로 drift 초과 → 새 세션 → `createdAt` 교체

→ **#2976이 lock을 복구했으므로 이 절단의 발생 조건도 좁아졌다.** 빈도가 얼마나 줄었는지는 **아직 모른다**(배포 전).

## 2. 피해 — 내 측정 plan들이 이 테이블에 의존한다

- **#2795**(CLOSED) 자동 감시가 `trip_metrics`를 읽는다(규칙 `lock=1 && fired=0`). 절단이 `fired_count`를 과소 보고하므로 **임계값 기반 규칙 전체가 불안정**하다.
  (정직: 10/13은 `lock=1, fired=1`이라 그 **특정 규칙**으로는 애초에 안 걸렸다 — `fired=0`이 아니었다. 과소 보고가 그 규칙을 무력화했다고는 말할 수 없다.)
- 내가 오늘 여러 PR의 "측정 plan"에 이 테이블을 썼다. 절단이 조용히 일어나면 그 plan들이 **거짓 음성**을 낸다.

## 3. 축 교차 (검사 #3)

주어진 축은 "started_at이 틀렸다" 1개다. 교차 축 = **세션 상태** × **컬럼**.

| 세션 | `started_at` | `fired_count` | 앞 구간 행 | 비고 |
| --- | --- | --- | --- | --- |
| 단일 세션 | 정확 | 정확 | 해당없음 | 10/09·10/07 |
| 같은 세션 재등록 | 보존(#2628) | 보존 | 해당없음 | ✓ 이미 고쳐짐 |
| **새 세션 교체** | **교체(뜀)** | **과소** | **없음**(종료 안 됨) | ❌ 10/13 |
| 유령 트립 | 기록됨 | 0 | — | #2973이 차단 |

셀 8개 > 주어진 축 1개. ✓

## 4. 결정 필요 — 4안

| | 안 | 하는 일 | 보장 | 비용·위험 |
| --- | --- | --- | --- | --- |
| **A** | `createdAt` 보존 확대 | 새 세션 분기에서도 `existing.createdAt` 유지 | 한 행이 전 구간 | **#704/#916 세션 의미와 충돌.** backend가 "새 trip"으로 보기로 한 결정을 뒤집는다 |
| **B** | 세션 교체 시 이전 세션 종료 | 교체 직전 `recordTripMetrics` 호출 → 트립당 2행 | 앞 구간도 기록됨. `UNIQUE(token_hash, started_at)`·append-only와 정합 | 교체 경로에 종료 처리 추가 = **정책 변경**. 종료 사유 신설 필요. 집계 쿼리가 "트립당 1행" 전제면 깨진다 |
| **C** | window 하한을 D1에서 산출 | `trip.createdAt` 대신 `MIN(ts) WHERE token_hash=? AND ts > 직전 ended_at` | `fired_count`가 전 구간 커버. `trip_events`가 이미 SSoT(#2628 본인 주장) | `started_at` 자체는 그대로(행은 여전히 1개·절단). 쿼리 1회 추가. 하한 경계(직전 ended_at 부재 시 폴백) 설계 필요 |
| **D** ✅ | **절단 탐지 계측만** | write 직전 전 구간 최초 ts와 `started_at`을 비교해 다르면 `trip_events`에 1건 | **정책 변경 0.** "이 행을 믿을 수 있는가"가 행 밖에서 판정된다. #2976 이후 빈도가 줄었는지 측정된다 | 절단 자체는 안 고친다. 과거 데이터는 소급 안 됨 |

**권고: D 먼저.** 근거:
1. **#2976이 발생 조건을 좁혔는데 얼마나 좁혔는지 모른다.** 빈도를 모르는 채 A/B/C를 고르면 또 추측 수정이다.
2. A·B·C는 전부 **정책 변경**이고 A는 기존 결정과 정면 충돌한다 — 사용자 결정 사안이다.
3. D는 **측정 신뢰도를 즉시 복구**한다 — 내 측정 plan들이 "절단 0건"을 확인할 수 있게 된다.
4. D 결과가 A/B/C 선택의 입력이 된다(절단이 계속 나면 C, 앞 구간 보존이 필요하면 B).

**이 plan의 범위는 D뿐이다.** A/B/C는 D의 측정 결과를 받아 별건으로 결정한다.

## 5. D 설계

`recordTripMetrics`(`d1TripMetrics.ts:57`) 안, INSERT 직전:

1. 이번 트립 구간의 **하한**을 구한다:
   `SELECT MAX(ended_at) FROM trip_metrics WHERE trip_token_hash=? AND ended_at < ?` → `prevEndedAt`
   (없으면 `endedAt - TRUNCATION_SCAN_MAX_MS` 폴백 — 같은 기기가 다른 날 트립을 하므로 무한 소급 금지)
2. `SELECT MIN(ts) FROM trip_events WHERE token_hash=? AND ts > ? AND ts <= ?` → `firstEventTs`
3. `firstEventTs < startedAt`이면 `trip_events`에 `metrics-window-truncated` 1건:
   `meta: { startedAt, firstEventTs, lostMs, firedCountInRow }`

**조건부 실행** — `firstEventTs`가 없거나 `>= startedAt`이면 적재하지 않는다(정상 트립에 노이즈 0).

## 6. 전제 검증 (검사 #6)

| 전제 | 확인 | 상태 |
| --- | --- | --- |
| `startedAt = trip.createdAt` | `d1TripMetrics.ts:90` | **확인** |
| `fired_count` 하한도 `trip.createdAt` | `:78`, `:82` | **확인** |
| `token_hash`가 세션 교체와 무관하게 같다 | `hashTripToken(trip.token)` — token은 APNs 토큰 | **확인**(10/13 두 행이 같은 `b00dd879`) |
| 새 세션 분기가 `createdAt`을 교체한다 | `index.ts:1240` `{...incoming}` | **확인** |
| `trip_metrics`에 `ended_at` 컬럼이 있다 | `pragma_table_info` 실측 — `started_at/ended_at` 존재 | **확인** |
| `recordTripMetrics` 호출부 1곳(trip 종료) | `liveActivity.ts:479`만 | **확인** |
| `trip_events` kind union에 신규 kind 추가 가능 | `tripEventLog.ts:152` union | **확인**(#2977에서 2종 추가) |

## 7. acceptance — revert-red (검사 #10)

- **고정**: 10/13 상황 재현(`trip_events`에 `started_at`보다 이른 ts가 있는 trip) → `metrics-window-truncated` 1건 적재. **탐지 로직을 제거하면 0건으로 떨어져야 한다.**
- **거부 ①**: `firstEventTs >= startedAt`(정상 트립) → **0건**(노이즈 금지).
- **거부 ②**: `trip_events`가 비었거나 조회 실패 → **0건 + 예외 전파 없음**(기존 `try/catch` swallow 유지).
- **거부 ③**: 기존 컬럼 값(`started_at`/`fired_count`/`suppressed_count`) **무변경** — D는 계측만이다.
- **거부 ④**: `prevEndedAt` 폴백 창 밖의 과거 이벤트는 집계하지 않는다(같은 기기 다른 날 트립이 섞이지 않는다).

## 8. 기존 이슈 대조 (검사 #7)

검색: `trip_metrics started_at` / `fired_count window` / `trip_metrics 절단` / `세션 교체 createdAt` → **이 절단에 대한 기존 이슈 없음.**
- **#2795**(CLOSED) — `trip_metrics` 자동 감시. 이 테이블의 신뢰도에 의존하므로 **D의 수혜자**다(충돌 없음).
- **#2628**(CLOSED) — `fired_count`를 D1 집계로 전환하고 same-session 하한을 고정. **그 선언이 새 세션 분기를 비워뒀다**(§1-3).
- **#2783**(CLOSED) — `suppressed_count` 추가. 같은 window를 쓴다.

## 9. 기존 결정 충돌 (검사 #9)

- `#704`/`#916` 세션 동일성 판정 — **D는 건드리지 않는다**(A가 충돌하는 지점).
- `#2283` append-only 관측 원칙 — D는 `trip_events` append 1건. 정합.
- `lesson_cf_free_quota_cron_kv_burn` — trip 종료 시 1회(하루 몇 건)이고 조건부다. quota 무해.

## 10. 범위 밖

- **A/B/C** — §4 근거로 D의 측정 결과를 받아 별건 결정.
- 과거 데이터 소급 정정 — append-only 원칙상 하지 않는다.
- `trip_metrics` 스키마 변경(컬럼 추가) — D는 마이그레이션 없이 `trip_events`로 해결한다.
