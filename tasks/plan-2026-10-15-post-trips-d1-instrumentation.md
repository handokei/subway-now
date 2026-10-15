# plan 2026-10-15 — `POST /trips` 결과가 D1에 0건: 오늘 400×30을 덤프로만 알 수 있었다

## 문제 (실측)

2026-10-15 16:25~16:43 트립에서 `POST /trips`가 **400 × 30**이었고 그 결과 backend에 trip이
없어 LA 토큰 등록이 404 × 12, 모든 역 `backend=[none]`, LA 영구 부재였다.

그런데 **이 사실을 D1으로는 알 수 없다.** 같은 24h D1 `trip_events`에 register 관련 kind가 0건이고,
400이라는 사실은 **device 덤프**(`~/.claude/uploads/.../d50c8992-1015.txt`)로만 확인됐다
(`alarmBackend.test.ts:96` #2998 테스트 주석이 그 수치의 출처다).

CLAUDE.md "검증은 새 실기기 라이드에 의존하지 않는다" 룰의 전제(D1이 authoritative)가
register 경로에서는 성립하지 않는다.

## 전수 열거 — `POST /trips` exit 분기 6개 중 D1 기록 1개

| # | file:line | 응답 | console.log | **D1** |
| --- | --- | --- | --- | --- |
| 1 | `index.ts:800` | 400 `invalid_json` | ✗ | **✗** |
| 2 | `index.ts:809` | 400 `invalid_trip` + `reason` | ✗ | **✗** ← **오늘 30회가 이 분기** |
| 3 | `index.ts:848` | 429 `rate_limited` | O | **✗** |
| 4 | `index.ts:1040` | 400 `trip-recently-ended` (bypass 초과) | O | **✗** |
| 5 | `index.ts:1055` | 400 `trip-recently-ended` (reject) | O | **✗** |
| 6 | `index.ts:1366` | 200 `ok` | ✗ | **✗** |
| — | `index.ts:1016` | (bypass 허용) | O | O `cooldown-bypass` |

`console.log`는 `wrangler tail` 실시간 전용이라 사후 조회가 불가하다
(`memory/reference_backend_d1_query.md` — "AE no-op, tail 실시간만").

## 해결 — kind `'trip-register'` 1종 추가, 로직 변경 0

`recordTripEvent`(`tripEventLog.ts:320`)로 6개 분기 전부에 `meta.outcome`을 적재한다.

| outcome | meta | tokenHash 출처 |
| --- | --- | --- |
| `stored` | `{ isNew }` | `incoming.token` |
| `invalid-trip` | `{ reason: rejectReason }` | **raw body의 `token`이 string이면** hash, 아니면 skip |
| `rate-limited` | `{ count, retryAfterSeconds }` | `incoming.token` |
| `recently-ended-rejected` | `{ endReason, ageMs }` | `incoming.token` |
| `invalid-json` | — | **기록 불가** (아래 참고) |

`invalid-json`은 body 자체가 파싱 불가라 hash할 token이 없다 — #2977이 `invalid_payload`를
같은 이유로 제외한 선례를 따른다. **다만 그 사실을 주석으로 남긴다**(후속 발생 시 "0건"을
"안 일어났다"로 읽지 않도록).

### 왜 success(`stored`)도 적재하는가

오늘 사슬의 1차 분기가 "등록이 **성공한 적 있나**"였다. `stored` 이벤트가 0건이면 등록 경로
자체가 끊긴 것이고, 있으면 그 뒤(LA 토큰/cron 발사)가 끊긴 것이다 — #2977이 LA 토큰에서
쓴 것과 같은 1차 분기 구조다.

### write 볼륨

register는 effect deps에 `subsurface`가 있어 트립당 수십 회 재실행된다(#2699 실측 29·37·24,
오늘 23). 트립당 최대 ~40행 × 하루 몇 트립 = **수백 행/일**. D1 free tier(10만 write/일) 대비
무해하고, `cleanupTripEvents`가 7일(`TRIP_EVENT_RETENTION_MS`) 초과분을 삭제한다.
`cooldown-bypass`가 이미 같은 라우트에서 같은 패턴으로 적재돼 있다(선례).

## acceptance

1. test-first(backend vitest): 6개 분기 각각에 대해 `recordTripEvent`가 기대 `outcome`으로
   호출되는지. 구현 전 red 확인.
2. **revert-red**: 적재 코드를 되돌리면 각 테스트가 실패하는 것을 눈으로 확인한다.
   outcome별로 **분리해서** assert한다 — 합산 카운트(`toHaveBeenCalledTimes`)만 보면 한 분기가
   죽어도 다른 분기가 수를 채워 통과한다(검사 #10 실측 함정).
3. 로직 불변: 기존 응답 코드/body/저장 동작이 바뀌지 않는다(기존 테스트 전부 green).
4. 측정: 배포 후 다음 트립에서 `SELECT json_extract(meta,'$.outcome'), COUNT(*) FROM trip_events
   WHERE kind='trip-register' GROUP BY 1`이 비어 있지 않다.

## 더블체크 (메인 직접, 2026-10-15)

### 확인
- **[#1]** `recordTripEvent`는 `index.ts:123`에 이미 import돼 있고 같은 라우트(`:1016`)에서 쓰인다 — 배선 추가 불필요.
- **[#2]** `recordTripEvent` 동명 export 0건. `tripEventLog.ts:320` 단일.
- **[#3]** exit 분기 전수는 위 표 6개 + bypass 1개. `awk`로 핸들러 범위(795~1366)의 `return c.json`을 전수 추출해 얻었다.
- **[#5]** `trip_events`는 `cleanupTripEvents`(`scheduled.ts:1565`)가 **7일**(`TRIP_EVENT_RETENTION_MS`) 초과분만 삭제 — 진단 창 충분, 신호가 조기 삭제되지 않는다.
- **[#6]** `rejectReason`은 `validateTrip`의 `onReject` 콜백으로 `:805-807`에서 채워진 뒤 `:809`에서 응답에 실린다 — 적재 시점에 값이 있다.
- **[#7]** 선행 이슈 비충돌: #2893(종료 경로·confirm·push 식별자 3종)은 register를 스코프에 넣지 않았고, #2977은 `/live-activity/register`만 덮었다. #2998은 **응답 body**에만 사유를 넣었고 D1에는 넣지 않았다.
- **[#9]** CLAUDE.md "검증은 새 실기기 라이드에 의존하지 않는다"와 **같은 방향**(D1 authoritative를 실제로 성립시킨다). 로직 변경 0이라 ADR 충돌 없음.

### 반증 → plan 수정
- **[#6] `isNew` 산출 불가** — 성공 분기(`:1366`)에서 `existing`은 스코프 밖이다(`:1108 routeReset.existing`은 블록 지역). **수정**: `:832 existingForRateLimit`(이미 읽어둔 값)을 쓴다 — 추가 KV read 0. 의미는 **"요청 시작 시점에 trip이 있었나"**이며 직렬화 구간에서 동시 생성이 끼면 어긋날 수 있다 → meta 키를 `existedAtRequestStart`로 두고 그 정의를 주석에 박는다(`isNew`라고 쓰면 거짓이 된다).

### 미확인
- 성공 응답이 `:1366` 하나인지는 `return c.json` 전수 추출로 확인했으나, `app.post('/trips')` 내부에서 호출되는 **헬퍼가 조기 응답을 만드는 경로**는 추적하지 않았다 → 구현 시 테스트가 6분기 전부를 실제로 타는지로 확인한다.

## 범위 밖

- register 재실행 빈도 자체(#2699 계보, `subsurface` dep) — 본 plan은 관측만 추가한다.
- device측 400 사유 노출은 #2998이 이미 응답 body에 넣었다(`index.ts:803-805`).
