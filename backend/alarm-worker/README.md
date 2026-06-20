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
npm run deploy
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
