# plan 2026-10-16 — #3006 D: KV 실패가 트립을 죽이지 않게 (관측 + degrade)

> **스코프**: backend only(`index.ts`). 사용자 노출(4번)은 PR-B로 분리(사용자 결정: **상태만 노출**).

## 문제 (10/15 실측)

KV 무료 write 쿼터가 바닥나자 `POST /position` **500 × 63**, `POST /trips` **500 × 9**,
**2시간 넘게 회복 0**. 쿼터 상한을 올려도(옵션 A) 이 구조는 그대로 남는다 — **KV가 흔들리면
트립 전체가 조용히 죽는다.**

| 끊긴 것 | 왜 치명적인가 |
| --- | --- |
| `/position` 응답의 `lockSuggestion`/`originStationId` | #1534가 **primary transport**로 지정한 경로. silent push가 OS suspend/kill로 못 와도 이걸로 lock을 인계받는데, 500이면 그 대안까지 함께 죽는다 |
| `POST /trips` | trip이 backend에 안 생김 → LA 토큰 404 → LA 영구 부재 |
| 관측 | `backend_errors` **0행**. 2시간 장애가 한 줄도 안 남았다 |

## 원인 — 자산은 있는데 안 붙어 있다

`captureBackendException(env, err, ctx)`(`sentry.ts:102`)가 Sentry + `backend_errors` 양쪽에
적재하고 **이미 9곳에서 쓰인다**(`index.ts:504`·`1715`·`1868`·… ). 그런데:

- `/position`·`POST /trips`에는 **호출이 없다**
- **`app.onError`가 아예 없다** → Hono 기본 500, 적재 0

## 설계 — 에러 문자열 sniffing 금지

쿼터 에러(코드 10048)의 Worker 런타임 메시지 형태를 **확정할 수 없다.** 따라서 "쿼터인지"를
문자열로 판별하지 않고, **쓰기 실패 자체를 실패로 다룬다**(분류는 호출 지점이 안다).

| | 변경 | 결과 |
| --- | --- | --- |
| **1. 관측** | `app.onError` 추가 → `void captureBackendException(c.env, err, { path })` 후 **500 유지** | 모든 라우트의 uncaught 에러가 `backend_errors`에 남는다. **동작 변경 없음**(상태코드 동일) |
| **2. `/position` degrade** | 쓰기 4종(`appendPositionPoint`/`appendAccelSample`/`stampOriginProximityIfNeeded`/`updateSsotMotion`)을 try/catch로 감싸 실패 시 capture + `degraded` 플래그. **읽기는 계속** → `readSsot`로 `lockSuggestion` 회신 | 500 → **200 + `degraded:true` + lockSuggestion 유지**. primary transport 생존 |
| **3. `POST /trips`** | `putTrip`(`index.ts:1323`) 실패 시 **503 + `Retry-After`** + capture | 등록이 실제로 실패했으므로 200은 거짓말이다. 500(영구 실패처럼 취급, #1960 재시도 로직)이 아니라 **재시도 가능한 실패**로 바꾼다 |

`/position`의 `readSsot`까지 실패하면 `lockSuggestion` 없이 200 + `degraded`를 반환한다 —
device는 문서화된 9-AND gate fallback으로 내려간다(기존 "SSOT 부재 시 graceful" 계약과 동일).

## acceptance

1. **test-first** — `put`이 throw하는 KV stub으로:
   - `/position`: 현재 500 → fix 후 **200** + `degraded:true` + `originStationId`/`lockSuggestion` 유지
   - `POST /trips`: 현재 500 → fix 후 **503** + `Retry-After` 헤더
   - 두 경우 모두 `backend_errors` INSERT **1건 이상**
   - `app.onError`: 임의 라우트에서 throw → `backend_errors` 1건 + **500 유지**(동작 불변 assert)
2. **revert-red** — 각 변경을 되돌리면 해당 테스트가 red. 케이스별 **분리 assert**(합산 금지).
3. **정상 경로 무회귀** — KV 정상이면 `degraded` 필드가 **없다**(응답 계약 불변), 기존 테스트 전부 green.

## 범위 밖
- 쿼터 상한(A 유료) / 좀비 트립 제거(E=#3007) — 별 건.
- 사용자 노출("추적 정확도 저하" 상태) → PR-B(#2997 S4-b와 같은 표면).
