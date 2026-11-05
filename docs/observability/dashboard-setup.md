# V/X Acceptance Dashboard — 사용자 setup guide

Phase 0 epic #1576 / P0-5 (#1581).

`vx-acceptance-queries.md`의 20개 SQL을 Cloudflare Analytics Engine + Grafana(또는 Cloudflare 내장 dashboard)에 wire 하는 절차.

## Prerequisite (이미 머지됨)

- P0-1 #1577 — Analytics Engine binding (`TRIP_METRICS` → dataset `trip_metrics`) 적재 활성
- P0-2 #1584 — Sentry binding (alert destination)
- P0-3 #1586 — R2 archive (장기 보관)

## 옵션 A — Cloudflare 내장 Workers Analytics dashboard (권장 — fastest)

1. Cloudflare dashboard 로그인 → `Workers & Pages` → `subway-now-alarm-worker` 선택
2. 좌측 `Analytics` 탭 → `Analytics Engine` → `trip_metrics` dataset 선택
3. `Add Query` → `vx-acceptance-queries.md`의 SQL을 각각 붙여넣기
4. 각 query를 `Save as widget` → dashboard에 추가
5. 임계 위반 위젯에는 `Threshold` 설정 (color rule)

장점: 별도 인프라 X, 무료. 단점: chart 옵션 제한, custom alerting 제한.

## 옵션 B — Grafana + Cloudflare Analytics SQL API

### 1. SQL API token 발급

```
Cloudflare Dashboard → My Profile → API Tokens → Create Token
Template: "Custom token"
Permissions:
  - Account → Account Analytics → Read
  - Account → Workers Scripts → Read
Account Resources: include subway-now account
```

발급된 토큰을 `CF_ANALYTICS_TOKEN`으로 저장.

### 2. Grafana datasource 설정

```
Grafana → Configuration → Data Sources → Add data source
Type: Infinity (Generic REST API)  또는  JSON API plugin
URL: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/analytics_engine/sql
Method: POST
Header: Authorization: Bearer ${CF_ANALYTICS_TOKEN}
Body: Plain text (SQL query per panel)
```

`{ACCOUNT_ID}`는 Cloudflare dashboard → 우측 sidebar에서 확인.

### 3. Dashboard JSON import

`vx-acceptance-queries.md`의 20개 query 각각을 Grafana panel로 추가:

- V1~V9 → Stat / Time series panel + Threshold (green/yellow/red)
- X1~X11 → Stat panel (count) + Alert rule (count > 0 → alert)

### 4. Alert channel 연결

Grafana → Alerting → Contact points → Add:
- Slack webhook URL (예: `#alert-trip` channel)
- Sentry webhook (P0-2에서 발급한 Sentry project DSN endpoint)

`alert-rules.md` 참고하여 각 X 임계에 alert rule 적용.

## 옵션 C — Cloudflare Workers cron (V 임계만, 일일 alert)

X는 즉시 alert 필요 → Sentry/Slack webhook. V는 일일 1회 cron이면 충분.

`backend/alarm-worker/wrangler.toml`에 cron trigger 추가:

```toml
[triggers]
crons = ["0 9 * * *"]  # 매일 09:00 UTC (KST 18:00)
```

`backend/alarm-worker/src/queries/dailyVCheck.ts` 신설 (본 PR scaffold) — 20개 SQL 실행 → 임계 위반 시 Slack POST.

> 본 PR은 scaffold만. 실제 cron handler 구현은 P0-5 close 전 follow-up commit 또는 별도 sub-PR.

## Acceptance (사용자가 dashboard 구축 후 확인)

- [ ] Dashboard URL 1개 활성 + V1~V9 / X1~X11 패널 20개 표시
- [ ] X1 패널에 test 데이터 1건 inject → Slack alert 수신 확인
- [ ] V7 패널이 지하 trip evidence 1건 후 ≥ 90% advance % 표시
- [ ] Dashboard URL을 `docs/observability/dashboard-url.md` (별도 PR) 또는 README에 공유

## 보안

- `CF_ANALYTICS_TOKEN`은 Grafana / 1Password에만 저장. repo에 커밋 금지.
- Slack webhook URL도 동일 (Cloudflare Workers secrets 또는 Grafana secrets).
