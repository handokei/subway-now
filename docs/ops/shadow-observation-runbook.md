# TripDO Shadow 관측 런북 (#2324, O1-F, ADR-031 Phase 1)

Phase0(#2261)/Phase1(#2264) dual-write 코드는 머지되어 배포됐지만, production KV에
`arch:trip-do-shadow-v1` 키가 없어 dual-write가 0회 실행됐다(404 확인, #2324 배경).
2b(fire의 per-trip DO cutover) hard-gate는 "실 trip 수 주 divergence 0"이므로, 이
런북은 그 관측을 시작·유지·롤백하기 위한 절차를 고정한다.

관련 코드:
- `backend/alarm-worker/src/tripDoFlag.ts` — flag KV read/write 어댑터
- `backend/alarm-worker/src/index.ts:568-614` — `dualWriteTripDo()` (POST /trips dual-write + shadow-compare divergence 로그)
- `backend/alarm-worker/src/tripDo.ts` — `TripDO` scaffold (state 보관만, fire 로직 없음)
- `backend/alarm-worker/wrangler.toml` — `TRIPS` KV binding, `TRIP_DO` durable_objects binding

## 1. Flag on/off 명령

flag는 `TRIPS` KV namespace(바인딩 `TRIPS`, 프로덕션 id
`8d10a57ffe4c46e28a6df33ef0c86b68`)에 키 `arch:trip-do-shadow-v1`로 저장한다. 값은
`on` / `off` 문자열만 유효(다른 값·미설정은 코드가 `off`로 정규화, `tripDoFlag.ts:22-27,37-44`).

**켜기 (관측 개시, 배포 불필요):**

```bash
npx wrangler kv key put "arch:trip-do-shadow-v1" "on" \
  --namespace-id 8d10a57ffe4c46e28a6df33ef0c86b68 \
  --remote
```

**끄기 (즉시 롤백, 배포 불필요):**

```bash
npx wrangler kv key put "arch:trip-do-shadow-v1" "off" \
  --namespace-id 8d10a57ffe4c46e28a6df33ef0c86b68 \
  --remote
```

**현재 값 확인:**

```bash
npx wrangler kv key get "arch:trip-do-shadow-v1" \
  --namespace-id 8d10a57ffe4c46e28a6df33ef0c86b68 \
  --remote
```

> `--remote`를 빠뜨리면 로컬 preview namespace(`preview_id`)에 write되어 production에
> 반영되지 않는다. 반드시 `--remote` 포함.

이 명령들은 **KV write이므로 본 PR/에이전트가 직접 실행하지 않는다** — 운영자(사용자)가
필요 시점에 직접 실행한다.

## 2. Divergence 관측 지점

- `dualWriteTripDo()`가 flag on일 때 `POST /trips` 처리마다: 기존 DO row를 읽어 신규
  `trip`과 문자열 비교 후 다르면(divergence) `console.log`로
  `trip-do: shadow-compare divergence (#2264)` 메시지 + `tokenPrefix`를 남긴다
  (`index.ts:592-601`). DO 호출 자체가 실패하면 별도로
  `trip-do: dual-write failed (graceful, #2264)`를 남긴다(`index.ts:607-613`).
- 조회처: **Cloudflare Dashboard → Workers & Pages → subway-now-alarm-worker → Logs**
  (Workers Logs, `wrangler.toml`의 `[observability.logs] persist = false`이므로 장기
  보관은 안 됨 — 실시간/최근 윈도우만). 필터: 메시지 텍스트 `trip-do: shadow-compare
  divergence` 또는 `trip-do: dual-write failed`.
- 실시간 tail(단발 확인용, `wrangler tail`은 v4 불안정 — 짧게만 사용):

```bash
npx wrangler tail subway-now-alarm-worker --format pretty --search "trip-do:"
```

### 주 1회 확인 체크리스트

1. flag가 여전히 `on`인지 확인 (`wrangler kv key get`, 위 §1).
2. Cloudflare Dashboard Logs에서 지난 1주 `trip-do: shadow-compare divergence` 검색 —
   0건인지 확인. 1건이라도 있으면 §3 롤백 절차 즉시 진행.
3. `trip-do: dual-write failed` 건수 확인 — graceful no-op이라 trip 등록 자체는
   막히지 않지만, 지속 실패는 DO 바인딩/eviction 이상 신호이므로 별도 diagnose.
4. §4 quota 대시보드에서 DO/KV read 증분이 예상 범위(§4) 내인지 확인.
5. 결과를 이슈(#2324 후속 또는 신규 관측 로그 이슈)에 주차별로 기록.

## 3. Divergence 발생 시 즉시 롤백 절차

1. 즉시 flag off (§1 "끄기" 명령) — dual-write 즉시 중단, 배포 불필요.
2. divergence 로그의 `tokenPrefix` + 발생 시각으로 Cloudflare Logs에서 해당 trip의
   `POST /trips` 요청 본문(가능하면) + cron 처리 로그를 교차 확인.
3. 원인이 `TripDO`(`tripDo.ts`) row read/write 로직 결함인지, 아니면 trip 갱신 타이밍
   race(예: dual-write 도중 KV 쪽 trip이 먼저 갱신)인지 판정 — cron/KV 경로는 이 시점에도
   변경 없이 authoritative로 계속 작동 중이므로 사용자 영향은 없다.
4. 원인 수정 PR 머지 후에만 §1 "켜기"로 재개. 재개 시점부터 새로 N주 divergence 0 카운트
   시작(직전 관측 기간과 합산하지 않음).

## 4. KV / subrequest quota 증분 예상

`dualWriteTripDo()`는 cron tick이 아니라 **`POST /trips` 호출당** 1회 실행되므로,
[[lesson_cf_free_quota_cron_kv_burn]]가 지적한 "tick × 1,440/일" 폭증 패턴과는 다르다.
`POST /trips`는 기존에 `checkTripRegisterRateLimit`로 토큰당 10 req / 10 min으로 이미
제한돼 있다(`index.ts:631-634`).

- flag on일 때 요청당 증분:
  - KV read 1회 (`getTripDoFlag`가 매 호출마다 `TRIPS.get()`) — KV 무료 한도는
    read 100,000/일로 여유 큼.
  - Durable Object subrequest 2회 (`stub.fetch` GET 1 + POST 1) — DO 무료 한도는
    요청 100,000/일 · 행 read 5,000,000/일 · 행 write 100,000/일(`wrangler.toml` 주석
    확인, 2026-08-09 durable-objects 스킬 문서 기준).
- KV **write**는 `dualWriteTripDo()` 경로에서 발생하지 않는다(DO storage write이지 KV
  write가 아님) — KV 무료 write 1,000/일 한도에는 영향 없음.
- 현재 사용자 규모(수 명~수십 명, 토큰당 10 req/10min 상한)에서는 DO 100,000
  요청/일 한도에 근접할 가능성이 없다. 사용자가 수백 명 규모로 늘어나는 시점에
  재계산 필요.

## 5. Phase2b 착수 자격 판정 기준

- §2 체크리스트를 **연속 N주**(N은 별도 이슈에서 확정, 기본값 후보 2주) 수행해
  `trip-do: shadow-compare divergence` 로그가 **0건**이어야 한다.
- 판정 기간 중 §3 롤백이 1회라도 발동하면 카운트를 리셋하고 원인 수정 후 재시작한다.
- `trip-do: dual-write failed`(DO 호출 자체 실패, graceful no-op)는 divergence와
  별개 지표다 — 빈번하면(예: 주간 두 자릿수) Phase2b 착수 전 별도 안정화 이슈로 분리한다.
- 본 이슈(#2324)의 acceptance는 "관측 개시"까지다. N주 divergence 0 최종 판정과
  Phase2b(fire의 per-trip DO cutover) 착수 여부는 별도 이슈에서 결정한다.
