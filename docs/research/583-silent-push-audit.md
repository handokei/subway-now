---
issue: #583
title: Silent push 디바이스 미도달 진단 — apnsEnv host 분기 및 환경 검증 audit
created: 2026-06-11
---

## 배경

#583: 2026-05-28 출근 trip에서 backend는 silent push 6건 발사(`pushed:1`)했지만 디바이스 silentPushTask가 한 번도 wake up 안 됨. 채널 2 alert fallback은 도달.

가설:
1. APNs host 분기 (`api.push.apple.com` vs `api.sandbox.push.apple.com`) 잘못
2. Token 환경(development vs production) 불일치 → `BadDeviceToken`
3. `aps-environment` entitlement 잘못 (별개 — #696/#1144에서 처리)
4. 클라 silentPushTask permission/registration 결손

본 문서는 **코드 audit** — fix는 별도 PR에서. DebugModal 확장은 Pipeline B(#1139)와 충돌 가능하여 본 PR 범위 밖.

---

## 결론 요약

**backend host 분기 / self-heal / payload 구조 — 모두 정상.** 별도 fix 불필요.

- 디바이스 미도달 원인은 코드 결손이 아니라 운영 환경 변수(`EXPO_PUBLIC_APNS_ENV`) 또는 클라 BG App Refresh / entitlement(별개 이슈)일 가능성이 높다.
- 향후 진단 강화는 DebugModal에 `apnsHost` 1줄 + (선택) `envCorrected` 카운트 노출 — 본 PR 범위 외(#1139 머지 후 별도 PR로).

---

## audit 결과

### 1. APNs host 분기 (정상)

`backend/alarm-worker/src/apnsHost.ts`:

```ts
export function pickApnsHost(apnsEnv: ApnsEnv | undefined, hosts: Record<ApnsEnv, string>): string {
  return hosts[apnsEnv ?? 'sandbox'];
}
export function flipApnsEnv(env: ApnsEnv | undefined): ApnsEnv {
  return (env ?? 'sandbox') === 'sandbox' ? 'production' : 'sandbox';
}
```

- `undefined` → `sandbox` fallback 의도적 (구버전 클라이언트가 production host로 잘못 보내 BadDeviceToken을 받는 회귀 방지).
- App Store / TestFlight 빌드는 반드시 `apnsEnv: 'production'`을 명시 송신해야 production host로 라우팅된다.

`backend/alarm-worker/wrangler.toml` (`[vars]`):

```
APNS_HOST = "api.push.apple.com"
APNS_HOST_SANDBOX = "api.sandbox.push.apple.com"
```

→ Apple 공식 도메인과 일치.

### 2. self-heal (`sendWithEnvHeal`, #482) — 정상

`backend/alarm-worker/src/scheduled.ts:140-166`:

- 1차: `pickApnsHost(trip.apnsEnv)`로 발사
- 응답이 `400 BadDeviceToken`이면 (`isApnsEnvMismatch`) opposite host로 1회 retry
- retry 성공 → `correctedEnv` 반환 → 호출자가 `trip.apnsEnv` 갱신 + `stats.envCorrected += 1`
- retry도 BadDeviceToken → `envMismatchExhausted: true` → 토큰 무효, trip 삭제
- 비교 조건: `status === 400 && reason === 'BadDeviceToken'` (정확)

### 3. silent push payload / 헤더 — 정상

`backend/alarm-worker/src/apns.ts:117-128` (`sendSilentPush`):

```
POST https://${host}/3/device/${deviceToken}
headers:
  authorization: bearer <JWT(ES256, kid, iss=teamId)>
  apns-topic: <bundleId>
  apns-push-type: background
  apns-priority: 5
body:
  { aps: { 'content-available': 1 }, data: { ... } }
```

→ Apple 공식 silent push 사양 충족. `apns-push-type: background` + `priority: 5` + `aps.content-available: 1` 3종 세트.

reschedule / trip-ended silent push도 동일 헤더 사용 (apns.ts:221-231, 273-283).

### 4. 클라 token 발급 — 정상

`src/features/alarm/hooks/useApnsTripRegistration.ts:191`:

```ts
const tokenResp = await Notifications.getDevicePushTokenAsync();
```

→ `getDevicePushTokenAsync`는 raw APNs hex token을 반환 (Expo push token 아님). backend는 이 token으로 `/3/device/{token}` 직접 호출. 올바른 선택.

`addPushTokenListener`로 토큰 회전 시 자동 재등록 (240-241).

### 5. apnsEnv 자동 감지 — 정상

`src/shared/utils/apnsEnv.ts`:

```ts
export function resolveApnsEnv(): ApnsEnv {
  const raw = process.env.EXPO_PUBLIC_APNS_ENV;
  if (raw === 'production' || raw === 'sandbox') return raw;
  return 'sandbox';
}
```

- `EXPO_PUBLIC_APNS_ENV` 미설정 / 오타 → `sandbox` fallback
- backend self-heal과 정합 (양쪽 모두 모르면 sandbox 출발)
- **운영 요구사항**: EAS production profile에 `EXPO_PUBLIC_APNS_ENV=production` 명시 설정 필요. 누락 시 production 빌드도 sandbox로 송신 → backend 1차 발사 실패 → self-heal로 1회 복구되지만 매 cycle 1회 추가 retry 발생 (envCorrected stat에 누적).

### 6. envCorrected 운영 가시성 — 충분 (KV 적재 불필요)

`backend/alarm-worker/src/scheduled.ts:387-391`:

```ts
log('scheduled run complete', { ...stats, seoulCalls: ... });
return stats;
```

cycle 종료 시 stats 전체를 wrangler tail에 log. `envCorrected` 카운트 운영자 가시.

- 한 trip이 self-heal로 한 번 정정되면 그 trip은 KV에 corrected env가 보존되어 이후 cycle은 정상 routing. 따라서 `envCorrected > 0`은 trip 신규 등록 시점에만 spike → 누적 KV 적재 가치 낮음.
- 만약 환경 mismatch가 지속 발생(잘못된 EAS env)하면 매 trip 새로 등록될 때마다 1회씩 spike → wrangler tail로 충분히 식별 가능.

→ 추가 KV 통계 적재(`apns_send_stats`) **불필요**.

---

## 미해결 가설 (별개 이슈 trace)

#583 본문의 4 가설 중 코드 audit으로 배제할 수 없는 것:

| 가설 | 본 audit | 후속 |
| --- | --- | --- |
| 1. host 분기 잘못 | **배제** (audit 1, 2) | — |
| 2. token env mismatch (BadDeviceToken) | **부분 배제** — self-heal이 정상 동작하면 1회 retry로 복구. 만약 production token이 sandbox host로 갔다가 retry도 실패한다면 envMismatchExhausted로 trip 삭제 → log 흔적 남음. wrangler tail에서 `apns env mismatch` 또는 `envMismatchExhausted` 로그 확인 권장. | wrangler tail 확인 |
| 3. `aps-environment` entitlement | 본 audit 범위 외 | #696 / #1144 |
| 4. 클라 silentPushTask permission/registration | 코드 경로 정상 (useApnsTripRegistration token 발급 + DebugModal `taskRegistration` 노출). 디바이스 측 BG App Refresh OFF 또는 entitlement는 코드로 진단 불가 — 사용자 설정 스크린샷 필요. | 사용자 BG App Refresh 확인 |

---

## DebugModal 진단 보강 권고 (별도 PR, #1139 머지 후)

현재 DebugModal silent push 진단 row(`silentPushDiagRows`):
- `permission`, `apnsToken`, `activeTrip`, `apnsEnv`, `task`, `route`, `dest`, `currStn`, `recv`, `fired`, `lastSkip`, `toggle`

추가 권고 1줄(작은 보강):
- `apnsHost`: `apnsEnv === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'`
  - 운영자가 env→host 매핑을 머리로 안 돌려도 됨
  - 클라 단독 계산 — 추가 hook 변경 0

추가 KV 적재 / backend 변경 없음.

---

## 액션 아이템

- [x] backend audit — host 분기 / self-heal / payload / 헤더 모두 정상
- [x] 클라 token 발급 / apnsEnv 자동 감지 audit — 정상
- [ ] (운영) EAS production profile에 `EXPO_PUBLIC_APNS_ENV=production` 명시 확인 — `eas env:list` 1회 점검
- [ ] (운영) wrangler tail에서 `apns env mismatch` 로그 발생 빈도 확인 — `envCorrected` 카운트로 spike 확인
- [ ] (별도 PR, #1139 머지 후) DebugModal에 `apnsHost` 1줄 추가
- [ ] (별개 이슈) `aps-environment` entitlement는 #696 / #1144에서 진행
- [ ] (별개 이슈) 디바이스 BG App Refresh 설정 사용자 확인 절차 — 본 audit 범위 외

---

## 참고 파일

- `backend/alarm-worker/src/apnsHost.ts` — host 분기 SSOT
- `backend/alarm-worker/src/apns.ts` — silent / reschedule / trip-ended / live-activity push 발사
- `backend/alarm-worker/src/scheduled.ts:140-166` — `sendWithEnvHeal` self-heal
- `backend/alarm-worker/src/scheduled.ts:1416-1418` — `isApnsEnvMismatch`
- `backend/alarm-worker/wrangler.toml:87-88` — host 환경변수
- `src/shared/utils/apnsEnv.ts` — 클라 `resolveApnsEnv()`
- `src/features/alarm/hooks/useApnsTripRegistration.ts:191` — `getDevicePushTokenAsync`
- `src/features/alarm/hooks/useSilentPushDiagnostics.ts` — DebugModal 데이터 소스
