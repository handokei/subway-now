# plan — 테스트 갭 우선순위 재배치 (2026-10-18)

## 배경

전체 테스트 감사 결과 device 517 suites/11,129건 + backend 143 files/4,052건 전부 통과, 커버리지 device 100% / backend 97.61·96.55·99.03. 그래서 "green인가"가 아니라 "green이 무엇을 보호하지 못하는가"를 물었고, 아래 우선순위를 제안한다.

## 확정이라 주장하는 전제

- **P1.** 프로덕션 감시(`recallAlerts.ts`)는 3중으로 비활성이다. 근거: ① `backend/alarm-worker/wrangler.toml:43-44`의 `analytics_engine_datasets` / `binding = "TELEMETRY"`가 주석 처리 ② `npx wrangler secret list --config wrangler.toml` 출력이 `ADMIN_TOKEN, APNS_BUNDLE_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_TEAM_ID, SENTRY_DSN, SEOUL_API_KEY` 7개뿐 — `RECALL_ALERT_WEBHOOK_URL` / `CF_ACCOUNT_ID` / `CF_API_TOKEN` 없음. `recallAlerts.ts:13-16` 주석이 이 셋을 graceful no-op 조건으로 명시.
- **P2.** `backend/alarm-worker/scripts/checkTripMetricsRegression.mjs`(#2795)는 코드가 정상이고 live D1을 읽지만 **스케줄러가 없다**. 근거: `backend/alarm-worker/package.json:19`에 npm script로만 존재하고, `.github/workflows/` 및 `wrangler.toml [triggers]`에 참조 0건.
- **P3.** 10/15 실기기 덤프(`~/.claude/uploads/.../d50c8992-1015.txt`)의 Whole Chain 19개 역 중 16개가 `displayed=N(legacy-station-kind-ignored)`이고, 이는 **alert payload 부재**를 뜻한다. 근거: `src/features/alarm/tasks/silentPushTask.ts`의 `const alertAccompanied = hasAlertPayload(input.data);` → `logPushReceipt({ displayed: alertAccompanied, ... suppressedReason: 'legacy-station-kind-ignored' })`.
- **P4.** 머지 전 코드 테스트로는 인프라·쿼터·외부 API 거동·iOS 런타임 중재 부류를 원리적으로 못 잡는다.

## 제안하는 처분

- **하기(1순위)**: `checkTripMetricsRegression.mjs`를 GitHub Actions nightly로 스케줄. 회귀 감지 시 이슈 자동 생성. 프로덕션 무영향(CI에서 D1 read-only).
- **하기**: ②(PR #3016 Swift typecheck) · ⑦(PR #3018 lint CI) 마무리.
- **하기**: ①(required status check에 `Backend Validation` / `Swift MIRROR Sync Check` 추가).
- **접기**: ③ 10/15 replay fixture. 근거 — 그 fixture는 10/15 사고를 막지 못했을 것이고(P3·P4), 감시가 켜지면 같은 trip이 24h 내 자동 검출되므로 감시가 fixture보다 선행한다.
- **접기**: ⑤ Swift 테스트 타깃(비용 과다, ②가 최빈 부류를 덮음) · ⑥ screens 커버리지(실사용 결함 유형에 미대응).
- **분리**: ④ `trackingOptIn`이 `maybeFireLegBoardingPrompt` / `maybeFireHopEndPrompt`에 미적용 — 테스트 보강이 아니라 제품 결함이므로 별도 트랙.
- **얇게 하기**: ⑧ station waypoint push payload 계약 테스트 1개(backend 생성 payload를 fixture로 박고 device 파서가 소비).

## acceptance

- 감시 스케줄: 워크플로 1회 수동 실행(`workflow_dispatch`)으로 D1 질의가 실제 행을 반환하고 리포트가 생성됨을 확인.
- ②: 깨진 상태(`a1031791^`) 복원 시 typecheck red, 현재 dev green (실측 완료).
- ⑦: 프로덕션 파일 cross-feature import 프로브 → error, 같은 import를 `__tests__` 아래 → 통과 (실측 완료).
