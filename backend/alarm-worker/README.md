# subway-now alarm-worker

Cloudflare Worker가 활성 트립을 KV에 저장하고, 1분마다 cron으로 서울 열린데이터 API를 폴링한다. 알람 단계(`early`/`imminent`)에 도달하거나 ETA가 60초 이상 변동하면 APNs HTTP/2로 silent push를 발사한다.

이슈: [#338](https://github.com/handokei/subway-now/issues/338) — BG 알람 Phase 2 (백엔드).

## 아키텍처

```
앱 (POST /trips, DELETE /trips/:token)
  → Worker KV (trip:<token> → Trip JSON, TTL=expiresAt+30분)

cron */1 * * * *
  → enumerate trips
  → 알람 윈도우(5분 이내) 트립만 폴링
    → Seoul Arrival API (15s 캐싱, station 단위 dedup)
  → ETA 평가 (early ≤180s, imminent ≤30s)
  → APNs silent push (content-available: 1, data: {nextWaypoint, etaSeconds, phase})
```

## 환경변수

`wrangler secret put`으로 등록한다.

| 키 | 설명 |
| --- | --- |
| `SEOUL_API_KEY` | 서울 열린데이터 API 키 |
| `APNS_KEY_ID` | APNs `.p8` 키의 Key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_PRIVATE_KEY` | `.p8` PEM 본문 (BEGIN/END 라인 포함) |
| `APNS_BUNDLE_ID` | 앱 번들 ID (예: `com.handokei.subwaynow`) |

`wrangler.toml`의 `[vars]`에 정의된 `APNS_HOST`, `SEOUL_API_HOST`는 공개 값.

## 배포

```bash
# 1) 의존성 설치
cd backend/alarm-worker
npm install

# 2) KV 네임스페이스 생성 (production / preview 각각)
npx wrangler kv:namespace create TRIPS
npx wrangler kv:namespace create TRIPS --preview
# 위 명령 출력의 ID들을 wrangler.toml에 채워넣는다.

# 3) 시크릿 등록
npx wrangler secret put SEOUL_API_KEY
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_PRIVATE_KEY  # .p8 PEM 전체 (BEGIN/END 포함) 붙여넣기
npx wrangler secret put APNS_BUNDLE_ID

# 4) 배포
npm run deploy       # #2698 — 배포 전 바인딩 7종 dry-run 확인 + 배포 후 worker명/cron 확인을 자동 수행한다.
                      # bare `wrangler deploy`는 절대 직접 실행하지 말 것 — 상위 디렉토리의
                      # 루트 wrangler.jsonc(웹 export용)를 잘못 채택하는 사고가 실제 발생했다.
```

## 개발

```bash
npm run dev          # local dev (wrangler dev)
npm test             # vitest 단위 테스트
npm run type-check   # tsc --noEmit
```

## HTTP API

### `POST /trips`

트립을 등록한다. 같은 token으로 재호출하면 덮어쓴다.

```json
{
  "token": "<APNs device token (hex)>",
  "route": { /* Route */ },
  "destination": "<station id>",
  "waypoints": [
    { "stationName": "신도림", "line": "2", "kind": "transfer" },
    { "stationName": "강남", "line": "2", "kind": "destination" }
  ],
  "expiresAt": 1736912000000,
  "alarmAtEpochMs": 1736910000000
}
```

### `DELETE /trips/:token`

트립을 해제한다 (사용자가 알람 끄기 / 목적지 도착).

### `GET /health`

`{ ok: true }` 반환.

## 폴링 최적화

- 트립의 `alarmAtEpochMs`까지 5분 초과 남은 경우 폴링 스킵
- station 이름 단위로 결과를 15초 캐싱 (같은 사이클 내 dedup)
- imminent 발사 후 트립 자동 종료
- `BadDeviceToken` (HTTP 400) / `Unregistered` (HTTP 410) → 트립 자동 삭제
- 로깅: `seoulCalls`, `scanned`, `polled`, `pushed`, `errors`를 매 cron 실행 종료 시 JSON으로 출력

## 범위 밖

- 앱 측 push handler (이슈 #337)
- 통합 테스트 (#339)
- Seoul API 트래픽 증설 신청 (#341)

## Analytics Engine — trip_metrics (Phase 0 #1577 / Epic #1576)

ADR-017 / ADR-016의 V/X acceptance를 SQL로 직접 검증하기 위한 시계열 dataset.

### Binding

```toml
# wrangler.toml
[[analytics_engine_datasets]]
binding = "TRIP_METRICS"
dataset = "trip_metrics"
```

> Workers Paid plan 필수. Free plan은 binding 선언만으로도 deploy 실패 (Cloudflare API 10089).
> 코드는 `if (env.TRIP_METRICS)` 분기로 graceful — binding 미바인딩 시 모든 적재 경로가 no-op.

### Event 어휘 (6종)

| eventType | 적재 site | 용도 |
| --- | --- | --- |
| `advance` | `tryAdvanceAndFireArvlcd` / `advanceBoardingLockWaypoint` 통과 | V8 적재 카운터 |
| `fire` | `fireArvlCdStationPush` / `fireVanishFallbackStationPush` 성공 | X3 stale fire 검증 |
| `suppress` | advance blocked / fire dedup / cross-station dedup | V9 suppress rate |
| `motion-transition` | `updateSsotMotion` state 전환 | motion 정확도 진단 |
| `position-upload` | `POST /position` 수신 | V8a `/position` rate |
| `trip-mutation` | `POST /trips` 수신 | V8b `/trips` rate |

Dimensions(blobs): `eventType`, `station:<id>`, `reason:<r>`, `env:<surface|underground|hybrid|unknown>`
Metrics(doubles): `staleMs`, `hopIndex`, `motionConfidence`
Index: `tripToken` 8자 prefix (full token 노출 안 함)

### SQL query examples

```sql
-- V8a: /position 업로드 ≤ 100건/10min/trip 확인
SELECT index1 AS tokenPrefix, COUNT(*) AS cnt
FROM trip_metrics
WHERE blob1 = 'position-upload' AND timestamp > NOW() - INTERVAL '10' MINUTE
GROUP BY index1
HAVING cnt > 100;

-- V9: suppress rate < 100건/시간/trip
SELECT index1 AS tokenPrefix, COUNT(*) AS suppress_cnt
FROM trip_metrics
WHERE blob1 = 'suppress' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY index1
HAVING suppress_cnt >= 100;

-- X3: stale fire (SSoT lastAdvanceAt 기준 5분+ 경과 후 fire)
SELECT index1 AS tokenPrefix, blob2 AS station, double1 AS staleMs
FROM trip_metrics
WHERE blob1 = 'fire' AND double1 > 300000;

-- 6 event type 적재 1주 분포 (dashboard 첫 화면용)
SELECT blob1 AS eventType, COUNT(*) AS cnt
FROM trip_metrics
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY blob1
ORDER BY cnt DESC;
```

## Seoul capture → replay fixture (Epic #2239 P0-a/P0-b)

Seoul API raw 응답이 `seoul-capture/{YYYY-MM-DD}/{cycleStartMs}.json` (`SeoulCaptureCycle`)로 R2에 쌓인다. 과거 trip 재생용 fixture로 만들려면:

`node scripts/buildReplayFixture.mjs`가 소스를 직접(`.ts` 그대로) import하므로 **Node >=23.6**(타입 스트리핑 기본 활성화 버전) 필요 — `package.json`의 `engines.node` 참고.

```bash
# 0) wrangler CLI(4.105 기준)는 r2 object get/put/delete만 지원하고 목록 조회(list)가
#    없다 — prefix로 키를 나열하려면 R2의 S3 호환 API(aws-cli)를 쓴다.
#    자격증명: Cloudflare dashboard → R2 → Manage R2 API Tokens.

# 1) 해당 날짜의 cycle 키 나열 (S3 호환 API)
aws s3api list-objects-v2 \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --bucket subway-now-telemetry \
  --prefix seoul-capture/2026-09-13/ \
  --query 'Contents[].Key' --output text | tr '\t' '\n' > /tmp/capture-2026-09-13-keys.txt

# 2) 키마다 wrangler로 다운로드 (R2 IO 자체는 wrangler CLI가 담당, 파일명 = key의 basename)
mkdir -p /tmp/capture-2026-09-13
while read -r key; do
  wrangler r2 object get "subway-now-telemetry/${key}" --file "/tmp/capture-2026-09-13/$(basename "$key")" --remote
done < /tmp/capture-2026-09-13-keys.txt

# 3) 병합해 fixture 생성 (window 미지정 시 cycle 전체 범위 자동 산출, --from/--to는 한쪽만 줘도 됨)
cd backend/alarm-worker
node scripts/buildReplayFixture.mjs --in /tmp/capture-2026-09-13 --out src/__tests__/fixtures/capture_2026-09-13.json
```

## trip 토큰 1개 → fixture 자동 생성 (Epic #2239 P1 / #2586)

위 수동 절차를 trip 토큰(또는 token_hash) 1개로 원커맨드 실행하는 도구. 로직(SQL 생성/D1
응답 파싱/token_hash 산출/registry 스켈레톤)은 `src/fixtureFromTrip.ts`(vitest 커버),
wrangler CLI 실행 + `GET /admin/seoul-capture/keys`(#2595) 호출은
`scripts/fixtureFromTrip.mjs`(얇은 I/O 셸, `buildReplayFixture.mjs`와 동일 분리 원칙)에
있다. R2 키 나열에 aws CLI/R2 S3 호환 토큰이 더는 필요 없다 — worker 자신의 TELEMETRY_R2
바인딩으로 `ADMIN_TOKEN`만으로 조회한다.

인증 준비: env `ADMIN_TOKEN`을 설정하거나, repo 루트 `.env`에 `EXPO_PUBLIC_ADMIN_TOKEN`
(worker의 `ADMIN_TOKEN` secret과 같은 값)을 채워둔다 — env가 없으면 `.env`를 읽는다.

```bash
cd backend/alarm-worker
# trip이 이미 종료/삭제돼 KV 원본 토큰이 사라진 경우(이 도구의 전형적 사용 시점) —
# D1 trip_events에 남은 token_hash(8자리 소문자 hex)로 직접 조회
node scripts/fixtureFromTrip.mjs --token-hash <8hexTokenHash> [--out .fixture-staging/] [--force]

# trip이 아직 살아있어 원본 토큰을 알 때
node scripts/fixtureFromTrip.mjs --trip <tripToken> \
  [--worker-url https://subway-now-alarm-worker.handokei.workers.dev] \
  [--out .fixture-staging/] [--bucket subway-now-telemetry] [--db subway-now-db] [--force]
```

`--trip`/`--token-hash`는 정확히 하나만 준다(둘 다 없거나 둘 다 있으면 에러,
`resolveTokenHash`).

1. `trip_events`(token_hash 기준, read-only 조회 — 스키마 변경 없음)에서 시간창(min/max
   ts)·노선·segment 역 목록·실제 fire 이력(`kind='cron-fire-attempt'`)을 뽑는다. 이벤트가
   없으면(캡처 없음/토큰 오류) 명확한 에러로 즉시 중단한다.
2. `GET /admin/seoul-capture/keys?from=<ms>&to=<ms>`(#2595, Bearer `ADMIN_TOKEN`)로 시간창
   (±2분 margin + ±90초 preRoll)에 해당하는 R2 seoul-capture 키 목록을 받고, 그 키만
   `wrangler r2 object get --remote`로 다운로드한다(#2073 quota lesson — 날짜 전체를
   무조건 받지 않는다). 401/400 등 비정상 응답은 status+body를 그대로 노출한다(오진 방지
   — "캡처 없음"으로 뭉뚱그리지 않는다). 정상 응답 + 매칭 0건일 때만 "캡처 없음"으로 중단.
3. `buildReplayFixture`(#2580)로 병합해 기본적으로 `.fixture-staging/<slug>.fixture.json`
   (git-ignored)에 쓴다 — `src/__tests__/fixtures/replayLibrary/`(P2 PR 게이트 디렉토리)에
   바로 쓰지 않는다. 이미 같은 파일이 있으면 `--force` 없이는 에러로 중단한다(실수로
   기존 fixture를 덮어쓰지 않도록).
4. `src/__tests__/replayLibrary.ts`의 `REPLAY_LIBRARY` 배열에 붙여넣을 entry 텍스트
   스켈레톤을 stdout에 출력한다 — `cronIntervalMs`는 실 캡처 fixture이므로 항상
   `'recorded'`, `expect.firedStations`는 segment 역 전체로 채운다. `seedTrips`/
   `description`은 사람이 채워야 하는 후속 작업으로 남는다 — 사람은 등록 diff 확인만
   하면 된다. 검토가 끝나면 staging 파일을 `src/__tests__/fixtures/replayLibrary/`로
   옮기고 스켈레톤을 등록한다.
5. fixture가 캡처 유실 신호(`droppedEntries`/`failedCycleStartsMs`, `isLossyFixture`)를
   가지면 요약에 경고를 찍고 스켈레톤에 `allowLossy: true`를 자동으로 넣는다.

**Stage 2(nightly 자동 수집 workflow)는 이 이슈 범위에서 제외** — R2 키 나열은
`ADMIN_TOKEN`만으로 되지만(더는 aws/R2 S3 토큰 불필요), 다운로드(`wrangler r2 object
get`)와 D1 조회(`wrangler d1 execute`)는 여전히 wrangler CLI의 Cloudflare 인증이 필요하고
repo에 CI용 wrangler 인증 secret이 아직 없다. secret이 준비되면 후속 이슈로 분리해 nightly
cron이 전일 캡처를 trip별로 훑어 이 도구를 반복 호출 → `replay-fixture/<date>` 브랜치 + PR을
여는 자동화를 추가한다.

## Replay fixture 라이브러리 — PR 게이트 (Epic #2239 P2 / #2585)

`src/__tests__/fixtures/replayLibrary/`에 등록된 fixture는 매 PR(`npm test` → CI `Backend
Validation`, #1624)마다 전량 재생돼 회귀를 잡는다. 신규 workflow는 없다 — 테스트 파일로
존재하는 것 자체가 게이트다.

**새 fixture 추가 절차 (P1 자동 파이프라인 완성 전까지 수동 fallback):**

1. 위 "Seoul capture → replay fixture" 절차로 `ReplayFixture` JSON을 만든다.
2. 파일을 `src/__tests__/fixtures/replayLibrary/<slug>.fixture.json`로 저장한다(반드시
   `parseReplayFixture` 통과 — `replay_library.full.test.ts`가 로드 시 검증한다).
3. `src/__tests__/replayLibrary.ts`의 `REPLAY_LIBRARY` 배열에 entry를 추가한다:
   - `slug`/`fixturePath`: 파일명과 1:1.
   - `description`: 앵커하는 회귀/원 사건 이슈 번호.
   - `seedTrips`: 재생 시작 시점(cron tick 0) trip 상태를 만드는 함수.
   - `phaseOffsetsMs`: 위상 스윕(기본 `DEFAULT_PHASE_OFFSETS_MS`, cron 위상 무관성 검증).
   - `expect.firedStations`: **위상 무관 매역 발사돼야 하는 역 전체를 발사 순서대로** —
     부분집합이 아니라 정확히 일치해야 통과한다(하나라도 빠지면 red).
   - `expect.forbiddenStations` / `expect.minPushes`: 필요 시에만.
   - fixture가 `droppedEntries`/`failedCycleStartsMs`(캡처 유실)를 가지면 `allowLossy: true`를
     명시해야 한다 — 안 하면 테스트가 실패해 불완전 캡처의 조용한 등록을 막는다.
4. `npx vitest run src/__tests__/replay_library.full.test.ts`로 로컬 확인 후 PR.

디렉터리에 파일만 두고 registry에 등록하지 않으면(또는 그 반대) 즉시 테스트 실패로
드러난다 — 등록 누락이 조용히 묻히지 않는다.
