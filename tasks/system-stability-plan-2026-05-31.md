# System Stability Plan — 2026-05-31

> 4개 영역 100% 코드 분석 결과 + 디바이스 debug modal + Cloudflare cron 로그 기반.
> 사용자가 보고한 5가지 핵심 문제 (BG 광범위, 위치 정체, BG 알람 미발화, 재실행 경로 어긋남, 환승역 오알람)의 root cause 식별 및 통합 fix 로드맵.

---

## 분석 입력
- `tasks/` 내 기존 분석 문서 (bg-alarm-analysis, bg-trip-persistence 등)
- Cloudflare Workers cron 로그 11.5h window
- 디바이스 debug modal 1회 캡쳐
- 코드: `src/`, `backend/alarm-worker/src/`, `ios/`, `app.config.js`, `eas.json`, `.entitlements`

---

## 사용자 보고 5가지 문제 (요약)
1. BG에서 광범위한 문제
2. 위치 서비스가 현재역을 따라가지 못함 (이동했는데 정체)
3. BG에서 알람 미발화, FG에서만 발화
4. 앱 재실행 시 현재역이 시작점이 아니라 다른 역
5. 노선 X/Y 환승역(예: line 1/7)에서 X호선 탑승 중인데 Y호선 환승 알람 오발화

---

## 결정적 발견 5건 (이번에 새로 식별)

### F-1. `aps-environment = development` (entitlement vs eas.json mismatch)
- `ios/subwaynow/subwaynow.entitlements:6` = `development`
- `eas.json` production profile = `EXPO_PUBLIC_APNS_ENV=production`
- → production APNS host(`api.push.apple.com`)에 development 토큰 전송 → 100% BadDeviceToken
- 디바이스 debug modal의 `lastReceived=(never)` 가장 유력한 원인
- backend `sendWithEnvHeal`이 self-heal하지만 fallback path에는 없음

### F-2. Backend `kind: 'reschedule'`을 client가 100% drop
- `src/tasks/silentPushTask.ts:134-135` valid kind = `{transfer, destination, intermediate}`
- backend `backend/alarm-worker/src/apns.ts:191 sendReschedulePush`는 `kind: 'reschedule'` 발사
- client는 `payload-missing-kind` skip → **사전 예약 정정 신호 100% 무의미**

### F-3. Backend `isSameSession`이 `createdAt` strict 비교
- `backend/alarm-worker/src/index.ts:46` — `existing.createdAt === incoming.createdAt`
- client `useApnsTripRegistration.ts:118-126`의 `lastSessionKeyRef`는 hook lifetime
- → cold restart마다 `createdAt=Date.now()` 새로 박힘 → backend waypoints 통째 wipe
- **backend 로그의 "advance → 다음 minute 첫 waypoint reset" 사이클 직접 원인**

### F-4. `TRIP_ORIGIN_KEY`가 존재하지 않음
- `src/constants/storageKeys.ts` 17개 키 전수조사 결과 없음
- `src/hooks/useTripOrigin.ts:31-44`는 `useState` 전용
- → cold restart 시 첫 GPS fix를 origin으로 캡쳐 = **사용자 보고 #4 직접 root cause**

### F-5. `useStationAlarm setFiredAlarms`가 fire-and-forget
- `src/hooks/useStationAlarm.ts:175` — AsyncStorage write 완료 대기 안 함
- → 다음 evaluation이 stale state 봄 = **destination 2분 차 2번 발사 직접 원인**

### 보조 발견
- F-6. Backend `sendSilentPush`/`putPending` production caller 없음 (grep 결과). 로그의 fallback fire 6건과 mismatch — deploy vs repo 추적 필요
- F-7. `_layout.tsx:39-44 cancelScheduledAlarms()`가 매 cold start 호출 → `bl:` 사전예약 알람 wipe 가능성
- F-8. `useApnsTripRegistration.ts:238` deps에 `nextStationEtaSeconds`/`currentStation?.id` 포함 → 30s마다 effect 재실행 → ms-동일 3개 POST race
- F-9. `purgeBoardingLockSchedulerQueue` exported but never called (`src/utils/boardingLockScheduler.ts:253-259`)
- F-10. 모든 fusion 가드 (#662)가 FG `useFusedNearestStation`에만 — BG path/silent push 핸들러에는 가드 없음

---

## P0 통합 16건 (이슈 #696~#711)

### 채널 / 인프라
| ID | Issue | 작업 | type | 작업량 |
|---|---|---|---|---|
| **C1** | [#696](https://github.com/handokei/subway-now/issues/696) | EAS production `aps-environment=production` 강제 | chore | S |
| **C2** | [#697](https://github.com/handokei/subway-now/issues/697) | 실기기 DebugModal 진단 캡쳐 1회 | chore | XS |
| **C3** | [#698](https://github.com/handokei/subway-now/issues/698) | silentPushTask reschedule kind 분기 추가 | fix | M |
| **C4** | [#699](https://github.com/handokei/subway-now/issues/699) | useStationAlarm setFiredAlarms await | fix | S |

### Trip lifecycle
| ID | Issue | 작업 | type | 작업량 |
|---|---|---|---|---|
| **L1** | [#700](https://github.com/handokei/subway-now/issues/700) | TRIP_ORIGIN_KEY 신규 + atomic persist | feat | S |
| **L2** | [#701](https://github.com/handokei/subway-now/issues/701) | useApnsTripRegistration in-flight Promise dedup | fix | M |
| **L3** | [#702](https://github.com/handokei/subway-now/issues/702) | setDestination 시 customOrigin/lock/scheduled 자동 클리어 | fix | S |
| **L4** | [#703](https://github.com/handokei/subway-now/issues/703) | useApnsTripRegistration deps 정리 | refactor | S |

### Backend resilience
| ID | Issue | 작업 | type | 작업량 |
|---|---|---|---|---|
| **B1** | [#704](https://github.com/handokei/subway-now/issues/704) | isSameSession trainCode 기반 + createdAt drift 허용 | refactor | M |
| **B2** | [#705](https://github.com/handokei/subway-now/issues/705) | waypoint advance 별도 KV(progress:<token>) 분리 | refactor | M |
| **B3** | [#706](https://github.com/handokei/subway-now/issues/706) | consecutiveEtaMissing 카운터 + 자동 종료 | feat | S |

### Fusion / 알람 정확도
| ID | Issue | 작업 | type | 작업량 |
|---|---|---|---|---|
| **A1** | [#707](https://github.com/handokei/subway-now/issues/707) | BG/silent/lock 3곳 BoardingLock line 가드 | fix | S |
| **A2** | [#708](https://github.com/handokei/subway-now/issues/708) | scheduler route 변경 감지 + cancel/reschedule | fix | M |
| **A3** | [#709](https://github.com/handokei/subway-now/issues/709) | scheduler cold restart schedule 보장 (hasScheduledRef) | fix | S |
| **A4** | [#710](https://github.com/handokei/subway-now/issues/710) | advanceHopWindow canonical name resolve | fix | M |

### BG → React state 채널
| ID | Issue | 작업 | type | 작업량 |
|---|---|---|---|---|
| **S1** | [#711](https://github.com/handokei/subway-now/issues/711) | BG_LAST_STATION_KEY + FG 복귀 시 임시 hydrate | feat | M |

---

## 사용자 보고 ↔ P0 매핑

| 사용자 보고 | 해결 P0 |
|---|---|
| ① BG 광범위 | C1+C2 (entitlement+진단), S1, B3, P1-D1 (region monitoring) |
| ② 현재역 정체 | B1+B2 (isSameSession+advance KV), L2 (POST dedup), S1 |
| ③ BG 알람 미발화 | **C1** (직격), C3 (reschedule), A3 (cold restart 보장), C4 (dedup) |
| ④ 재실행 시 시작점 어긋남 | **L1** (TRIP_ORIGIN), L3 (customOrigin 클리어), P1-D6 |
| ⑤ 환승역 오알람 | A1+A2+A3+A4 (가드+cancel/reschedule+canonical) |

---

## P1 (단계적 신뢰성/UX)
- **D1** Region Monitoring (`expo-location` Geofencing) — WhileInUse 사용자에서 BG wake-up [L]
- **D2** `DEFAULT_WINDOW_SIZE` 동적화 — 4 hop 이후 사전예약 누락 차단 [S]
- **D3** 운영 시간대 인식 (KST 01:00-05:00 polling skip) — Seoul API 절감 + 무한 폴링 차단 [M]
- **D4** backend `isSameSession` tolerance window + push idempotency [S]
- **D5** hydration ordering Promise.all + `hydrated` flag로 hook 차단 [M]
- **D6** boot-time consistency check (stale trip 정리) [M]
- **D7** iOS Accuracy Authorization 명시 (reduced accuracy 감지 UI) [S]
- **D8** fusion 가드 BG path 이식 (boardingLockInterp + 거리 게이트) [M]
- **D9** silent push gate에 `BG_LAST_FIX` fallback [M]
- **D10** `advanceHopWindow` 90s/hop 보정 (노선/환승 페널티) [L]
- **D11** backend `expiresAt` 상한 검증 (6h) [S]
- **D12** useEffect single-fire 가드 (effect race 전반) [M]

## P2 (구조 정리)
- trip SSOT consolidation (`useTripStore` 신규) [XL]
- dead code 정리 (`purgeBoardingLockSchedulerQueue`, `sendSilentPush`/`putPending`) [M]
- `useStationAlarm` single-owner [M]
- backend `forceAlertMode` flag [M]
- kv.put 실패 try/catch [S]

---

## 의존성 그래프 + Sprint 분할

### Sprint 1 (Week 1) — 진단 + 즉시 차단
**병렬 가능 (4트랙)**:
- **Track 1 (진단)**: C2 → C1
- **Track 2 (Trip lifecycle)**: L1, L3 (서로 독립, L3는 L1과 분리)
- **Track 3 (알람 정확도)**: C4, A1, A3 (독립 작은 fix들)
- **Track 4 (스케줄러)**: A2 → A4 (A2 후 A4가 같은 advance 영역)

**순차 의존**:
- C2 → C1 (진단 결과 봐야 entitlement 확정)
- A2 → A4 (route 변경 cancel 후 canonical resolve 보강이 같은 코드 영역)

### Sprint 2 (Week 2) — Backend + race
**병렬 가능 (3트랙)**:
- **Track 5 (Backend)**: B1 + B2 + B3 (모두 backend, 같은 PR로 묶을 수도)
- **Track 6 (Client race)**: L2 → L4 (in-flight dedup 후 deps 정리)
- **Track 7 (Channel)**: C3 (reschedule kind), S1 (BG state hydrate)

**순차 의존**:
- B1 ↔ B2 (같은 파일이므로 한 PR로 권장)
- L2 → L4 (in-flight dedup 검증 후 deps 정리해야 안전)
- C3은 client만, backend reschedule push 발사 검증 필요

### Sprint 3+ (Week 3+)
- D1 Region Monitoring (대규모, 단독 sprint 권장)
- 나머지 P1 12건 우선순위에 따라

### 전역 순차 의존 (반드시 순서)
1. **C2 (진단) → C1 (entitlement fix)** — 진단으로 가설 확정 후 fix
2. **C1 → C3** — entitlement 살아난 후 reschedule kind 검증 가능
3. **B1+B2 → L2** — backend advance 영속화 후 client dedup 효과 측정
4. **모든 P0 → P1 D1 (region monitoring)** — P0 기반 안정화 후 새 채널 추가

### 병렬 친화 (서로 영향 없음)
- L1 ↔ L3 ↔ A1 ↔ S1 (각각 다른 파일/관심사)
- A1 + A2 + A3 + A4는 같은 알람 영역이지만 파일이 분산되어 병렬 가능
- B1+B2+B3는 모두 backend이지만 함께 한 PR로 묶는 게 효율

---

## 추가 검증 필요 (코드만으로 단정 불가)
- F-1 entitlement: EAS production 빌드 IPA inspect 또는 `apple developer console`에서 토큰 환경 확인
- F-6 dead code mismatch: backend production deploy의 실제 코드 wrangler tail로 확인
- F-7 cancelScheduledAlarms 동작: 실기기에서 cold restart 후 `bl:` identifier 알람이 살아있는지 검증
- iOS Live Activity push update가 알람 백업 채널로 활용 가능한지 (#586 series 머지된 상태)

---

## 솔직한 평가

**Q: P0 16건 완료하면 사용자 보고 5건 해결되나?**
**A**: F-1 entitlement 가설이 사실로 확정되면 **5건 모두 차단 가능**. F-1이 다른 원인(예: token 등록 실패)이라면 C2 진단 결과에 따라 C1 대신 별도 fix 필요.

**Q: 진정한 SLA를 위해선 추가로 무엇이?**
- P1-D1 Region Monitoring 없이는 WhileInUse 사용자가 silent push 의존 → 채널 redundancy 부족
- Live Activity push update를 알람 백업 채널로 활용 가능한지 검토
- 사용자에게 "정확한 알람을 위해 Always 권한 권장" UX nudge

---

## Issue tracking
이 문서의 P0 16건은 각각 GitHub issue로 생성됨. Sprint별/track별 진행 상황은 issue 라벨로 추적.
