# Recall KPI 운영 대시보드 (#919 / PR #961 후속)

본 문서는 Notion 운영 페이지와 backend `GET /metrics/recall/summary` endpoint의 컨텐츠 source.

- **Notion 페이지**: https://app.notion.com/p/37730c0194b6817e8953dacb9e533039
- **Endpoint SSOT**: `backend/alarm-worker/src/recallQueries.ts`
- **Endpoint URL 상수**: `RECALL_OPS_PAGE_URL` (위 Notion URL을 노출, endpoint 응답에 포함)

## 목적

Phase 3 매역 알림(`perStationAlarmRecall`)의 도달률과 게이트 차단 분포를 추적해 운영 임계 alert 발사 입력값을 SSOT로 모은다.

## Query 목록

| id | window | 용도 |
| --- | --- | --- |
| `daily-recall-rate` | 14d | 일별 매역 알림 recall rate 추세 |
| `gate-suppression-distribution` | 14d | 게이트별 차단 분포 |
| `low-recall-trip-ratio` | 7d | `recall < MIN_RECALL_RATIO_THRESHOLD` (warning) / `< RECALL_THRESHOLD_CRITICAL` (critical) token 비율 (alert 임계 입력) |

세 query 모두 분모 0 가드(`if(... > 0, ..., 0)`)로 NaN/inf alert 폭주 차단.

## 임계값 (severity 2등급, #1003)

- **`MIN_RECALL_RATIO_THRESHOLD = 0.95`** (warning) — token prefix 단위 recall이 95% 미만이면 warning low-recall token으로 분류.
- **`RECALL_THRESHOLD_CRITICAL = 0.90`** (critical) — recall이 90% 미만이면 critical으로 분류. critical ⊂ warning (90% 미만은 95% 미만의 부분집합).

두 값 모두 `metrics.catalog.json` SSOT. invariant: `RECALL_THRESHOLD_CRITICAL < MIN_RECALL_RATIO_THRESHOLD`.

## Webhook 연계 (PR #976 / #972 / #1003)

`low-recall-trip-ratio` 결과가 임계 초과 시 운영 alert webhook 발사. payload `severity` 필드로 등급 구분:

- `severity: 'critical'` — critical 임계 미달 trip 존재. on-call 즉시 호출 대상.
- `severity: 'warning'` — critical은 없고 warning 임계 미달 trip만 존재. 모니터링 큐.

같은 webhook으로 흐르되 receiver는 severity로 분기 (페이지 색상 / on-call 알림 강도). 자세한 wiring은 PR #976 / #1003 참조.

## AE binding 활성 상태

- `wrangler.toml`의 `[[analytics_engine_datasets]]` 블록은 Workers Paid 대기로 주석 처리 상태(#506).
- **`available: false`** → AE binding 미활성. Notion 페이지에 "데이터 미수집 중" placeholder 표시.
- **`available: true`** → AE 활성. SQL HTTP API로 endpoint 응답의 `queries[].sql`을 그대로 호출해 데이터 fetch.

## 외부 호출 예시

```bash
# 1. endpoint에서 query 카탈로그 fetch
curl https://alarm-worker.<workers-dev>/metrics/recall/summary

# 2. AE 활성 후, fetch한 SQL로 Cloudflare SQL HTTP API 호출
curl -X POST https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql \
  -H "Authorization: Bearer <token>" \
  --data-binary "<sql 문자열>"
```

## Privacy

token prefix 8자만 — 개별 사용자 식별 불가.
