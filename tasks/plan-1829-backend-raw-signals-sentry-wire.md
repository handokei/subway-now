# Plan #1829 — backend RAW_SIGNALS KV 활성화 + Sentry wire 완성

**SSoT**: 본 문서. 사용자 결정 반영 (D1 + Analytics Engine은 보류).

## 1. 배경

### 사용자 결정 (2026-06-25)

| 옵션 | 결정 | 이유 |
|---|---|---|
| RAW_SIGNALS KV 활성화 | ✅ 진행 | 비용 0, 5분 작업, 회귀 사후 분석 도구 |
| Sentry backend wire 완성 | ✅ 진행 | 무료 5k events/월, backend 에러 자동 수집 |
| Analytics Engine (TELEMETRY + TRIP_METRICS) | ❌ 보류 | Workers Paid $5/월 — 다음에 결정 |
| D1 도입 | ❌ 보류 | schema 설계 비용, 다음에 결정 |

### 현재 backend 인프라

| Binding | 상태 |
|---|---|
| TRIPS KV / PENDING_PUSHES KV / FEEDBACK KV / TELEMETRY_R2 | ✅ active |
| **RAW_SIGNALS KV** | ❌ binding 대기 (코드는 graceful) |
| **Sentry backend** | 🟡 stub (`sentry.ts` DSN 확인만, `withSentry` HOC bind 미적용) |
| Analytics Engine 2개 | ❌ 보류 |
| D1 | ❌ 보류 |

## 2. Phase A — RAW_SIGNALS KV 활성화

### 현재 코드 상태

`backend/alarm-worker/wrangler.toml` L56~L62:
```toml
# [[kv_namespaces]]
# binding = "RAW_SIGNALS"
# id = ""
# preview_id = ""
```

`POST /signals/dump` endpoint 이미 코드에 있고 `if (env.RAW_SIGNALS)` graceful 분기.
`GET /admin/signals/export?corrId=` 운영자 조회 endpoint도 코드 존재.

### 변경 사항

1. **운영자 작업** (사용자 1회):
   - `wrangler kv namespace create RAW_SIGNALS`
   - `wrangler kv namespace create RAW_SIGNALS --preview`
   - 출력된 id / preview_id를 wrangler.toml에 채움

2. **PR**: wrangler.toml 주석 해제 + id 입력 (사용자 입력값)
   - 운영 절차 README 갱신 (docs/runbook 또는 backend README)

### Acceptance

- `wrangler deploy` 성공 (binding 활성)
- `POST /signals/dump` 호출 시 KV write 성공 (503 X)
- `GET /admin/signals/export?corrId=<id>` 조회 가능

## 3. Phase B — Sentry backend wire 완성

### 현재 코드 상태

`backend/alarm-worker/src/sentry.ts`:
- L11: `env.SENTRY_DSN` 미설정 시 init/capture 모두 no-op
- L17: 정식 `withSentry` 적용은 후속 PR (본 PR이 그 후속)
- L49 Phase 0: DSN 존재 여부만 stamp + console.info
- L81 `isSentryInitialized()` 함수

### 변경 사항

1. **`@sentry/cloudflare` SDK 설치 검증**:
   ```bash
   cd backend/alarm-worker
   npm list @sentry/cloudflare
   ```
   (audit 결과 미설치 시 npm install)

2. **`withSentry` HOC bind** (`backend/alarm-worker/src/index.ts`):
   ```ts
   import * as Sentry from '@sentry/cloudflare';
   
   const handler = {
     fetch: ...,
     scheduled: ...,
   };
   
   export default Sentry.withSentry(
     (env) => ({
       dsn: env.SENTRY_DSN,
       release: env.RELEASE_SHA, // optional
       environment: env.APNS_ENV ?? 'production',
     }),
     handler,
   );
   ```

3. **운영자 작업** (사용자 1회):
   - Sentry 계정 생성 (or 기존 device Sentry project 사용)
   - DSN 발급
   - `wrangler secret put SENTRY_DSN`

4. **error capture 통합**:
   - 기존 backend `try/catch`에 `Sentry.captureException` 추가
   - 핵심 path: cron, /trips POST/DELETE, /live-activity/register, /signals/dump

### Acceptance

- `withSentry` HOC bind 후 `wrangler deploy` 성공
- Sentry dashboard에서 backend exception 수신 확인 (의도적 throw로 verify)
- 기존 backend test 회귀 0
- DSN 미설정 시 graceful (Sentry SDK no-op)

## 4. Out of scope

- Analytics Engine 2개 (Workers Paid 필요): 별 issue
- D1 (오류 로그 관계형 + acceptance metric): 별 issue, schema 설계 후 진행
- Sentry breadcrumbs 강화 / custom context: follow-up

## 5. 옵션 — Workers Paid 전환 시 자동 활성 (out of scope, reference)

Workers Paid 전환 시:
- `TELEMETRY` Analytics Engine: silent push outcome SQL 쿼리
- `TRIP_METRICS` Analytics Engine: V/X acceptance 시계열 (ADR-017 자동 측정)

→ 본 PR scope 아님. 사용자 비용 결정 후 별 PR.

## 6. Audit 필요 (BG agent)

1. `@sentry/cloudflare` SDK 설치 여부 확인 + 버전
2. 기존 `sentry.ts` Phase 0 stub과 `withSentry` HOC 통합 방향
3. 기존 backend test가 `withSentry` 통합 후 작동하는지 (mock 필요 여부)
4. cron handler가 fetch handler와 별 entry point — 둘 다 withSentry 통합 필요

## 7. Wire-completion 5단

1. **Orphan**: 새 export 없음. 기존 `sentry.ts` 함수 활성화
2. **V/X dashboard**: Sentry dashboard backend exception 수신 + Cloudflare Workers Logs 통합
3. **의존 PR**: #1827 (LA BG update) 머지 후 시작이 자연스러움 (같은 backend 영역 충돌 회피)
4. **측정 plan**: 1주 후 Sentry exception 분포 + 우선순위 큰 에러 식별
5. **Device verify**: N/A (backend only — 다만 Sentry device project와 통합되면 cross-platform 추적 가능)

## 8. 운영자 작업 절차 (PR 후)

### RAW_SIGNALS

```bash
# 1) namespace 생성
wrangler kv namespace create RAW_SIGNALS
# Output: id = "xxxxx"

wrangler kv namespace create RAW_SIGNALS --preview
# Output: preview_id = "yyyyy"

# 2) wrangler.toml 갱신 (PR에서 자리 마련)
# binding = "RAW_SIGNALS"
# id = "xxxxx"
# preview_id = "yyyyy"

# 3) deploy
wrangler deploy
```

### Sentry

```bash
# 1) Sentry 프로젝트 생성 (sentry.io)
# 2) DSN 복사

# 3) wrangler secret put
wrangler secret put SENTRY_DSN
# 입력: <복사한 DSN>

# 4) deploy
wrangler deploy

# 5) 의도적 throw로 verify (deploy 후 endpoint 호출)
curl -X POST https://...
# Sentry dashboard에서 exception 확인
```

## 9. 관련 메모리

- [[project_db_error_infra_backlog]] DB/오류 관리 인프라 backlog (Phase 1-3) — 본 PR이 Phase 1
- [[project_2026_06_25_day2_pr1819_confirmed]] Day 2 진입점
- [[lesson_wrangler_tail_v4_unstable]] wrangler tail BG 불안정 → 대시보드 의존 ↑

## BG agent 위임 지시

### 작업 순서

1. SSoT plan 정독
2. audit 4건 (#6)
3. Phase A (RAW_SIGNALS): wrangler.toml 변경 + 운영 절차 README
4. Phase B (Sentry wire):
   - `@sentry/cloudflare` SDK 설치 (미설치 시)
   - `withSentry` HOC bind (`index.ts`)
   - 기존 `sentry.ts` 통합
   - 핵심 path Sentry.captureException
5. acceptance 테스트 (mock SENTRY_DSN으로 init/capture 흐름)
6. PR 본문에 audit 결과 + 운영자 절차 + Wire-completion 5단

### 격리 규칙

- worktree 절대 경로 안에서만 작업
- 메인 repo는 다른 작업 중 — `tasks/plan-1829-...` 파일만 수정 가능

### 자율 scope

- `@sentry/cloudflare` 버전 결정
- `withSentry` HOC 통합 방식 자율
- 기존 `sentry.ts` Phase 0 stub 정리 (deprecation 또는 통합)
