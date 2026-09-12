# V/X Acceptance — Alert rules

Phase 0 epic #1576 / P0-5 (#1581).

`vx-acceptance-queries.md` 20 임계 위반 시 alert 발사 규칙. Sentry (X) + Slack (V) 2채널 분리.

## 채널 매트릭스

| 임계 종류 | 발사 조건                  | 채널                                   | 응답 SLA |
| --------- | -------------------------- | -------------------------------------- | -------- |
| X1~X11    | 위반 1건 발생              | Sentry issue + Slack `#alert-trip-x`   | 1h       |
| V1~V9     | daily cron 임계 미달       | Slack `#alert-trip-v`                  | 24h      |

## X 임계 — Sentry alert rule

Sentry project: `subway-now-alarm-worker` (P0-2 #1584로 생성됨).

각 X 임계에 대해 Sentry Issue Alert rule:

```
WHEN: A new issue is created
IF: event.tags["acceptance"] equals "X1"  (또는 X2, X3, ...)
THEN:
  - Send notification to Slack channel #alert-trip-x
  - Send notification to PagerDuty (선택)
```

발생 측 코드 (`backend/alarm-worker/src/queries/sentryReporters.ts` scaffold 참고):

```ts
Sentry.captureMessage(`X1: wrong-station alarm fired`, {
  level: 'error',
  tags: { acceptance: 'X1', tripToken: tokenPrefix },
  extra: { stationId, env, staleMs },
});
```

## V 임계 — Slack webhook (daily cron)

Cloudflare Workers cron (`0 9 * * *` UTC = 18:00 KST) → 20개 V SQL 실행 → 임계 미달 시 Slack POST.

```
Slack webhook URL: SECRET (Workers env `SLACK_V_WEBHOOK`)
Channel: #alert-trip-v
Message format:
  ":warning: V<N> acceptance breached"
  "Threshold: <threshold>"
  "Observed: <value> (window: 24h)"
  "Dashboard: <URL>"
```

## 임계 일람표

### V (daily, < 임계 시 alert)

| 임계 | 측정값                                | 임계        |
| ---- | ------------------------------------- | ----------- |
| V1   | currentStation mismatch %             | < 1%        |
| V2   | transfer-1-stop alarm count != 1 trip | 0건         |
| V3   | destination-1-stop alarm count != 1   | 0건         |
| V4   | station-passed drift                  | ≤ ±1        |
| V5   | 자동 종료 trip %                      | ≥ 99%       |
| V6   | SSoT mirror lag p95                   | < 5000ms    |
| V7   | 지하 trip advance %                   | ≥ 90%       |
| V8a  | /position rate / 10min trip           | ≤ 100건     |
| V8b  | /trips rate / 10min trip              | ≤ 10건      |
| V8c  | stationary cycle rate vs moving       | < 50%       |
| V9   | suppress rate / hour / trip           | ≤ 30건      |

### X (즉시, count > 0 시 alert)

| 임계 | 측정값                              | 임계 |
| ---- | ----------------------------------- | ---- |
| X1   | wrong-station alarm                 | 0건  |
| X2   | duplicate alarm (trip+station 2회)  | 0건  |
| X3   | stale alarm (lastAdvance > 5min)    | 0건  |
| X4   | spam suppress > 10건/trip           | 0건  |
| X5   | mirror leak                         | 0건  |
| X6   | late alarm (도착 + 30s 이후)        | 0건  |
| X7   | env=unknown ≥ 5min trip             | 0건  |
| X8   | trip 6h+ 잔존                       | 0건  |
| X9   | app kill 후 fire                    | 0건  |
| X10  | fusion picker mismatch              | 0건  |
| X11  | BG scheduled queue post-trip-end fire | 0건  |

## Slack webhook setup

1. Slack workspace → `Apps` → `Incoming Webhooks` 설치
2. 채널 `#alert-trip-x`, `#alert-trip-v` 2개 생성 후 각각 webhook URL 발급
3. Cloudflare Workers secret:
   ```
   cd backend/alarm-worker
   wrangler secret put SLACK_X_WEBHOOK
   wrangler secret put SLACK_V_WEBHOOK
   ```
4. `dailyVCheck` cron handler에서 fetch POST.

## Escalation

X1/X9 (사용자에게 직접 가치 손상) 5건 누적 또는 1시간 내 3건 → PagerDuty escalation (Sentry rule로 wire).
