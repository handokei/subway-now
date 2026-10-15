# plan 2026-10-03 — boarding-prompt 임박 게이트 miss측 보완 (approaching 계열 추가)

이슈: #2801 (3차 reopen — #2834 게이트의 miss측 갭, 10/2 실측 확정)

## 증거 (10/2 실측, D1 trip 창 06:28~06:53 KST — 전수 조회 완료)

10/2 아침 트립(용마산→건대입구 환승→뚝섬), leg-2 앵커 건대입구(2):

| KST | kind | candidateArvlCds | outcome |
|---|---|---|---|
| 06:43:38 | leg-boarding-prompt | [99,99] | suppressed-not-imminent |
| 06:44:28 | leg-boarding-prompt | [99,99] | suppressed-not-imminent |
| 06:46:11 | leg-boarding-prompt | **[5,99]** | suppressed-not-imminent |
| 06:46:39 | leg-boarding-prompt | **[3,99]** | suppressed-not-imminent |
| 06:48:29 | leg-boarding-prompt | [99,99] | suppressed-not-imminent |
| 06:49:24 | leg-boarding-prompt | **[5,99]** | suppressed-not-imminent |
| 06:50:55 | leg-boarding-prompt | [5,99] | suppressed-not-imminent |
| 06:51:27 | leg-boarding-prompt | [3,99] | suppressed-not-imminent |

- 사용자는 **06:49:30경 실제 탑승**(GPS 21.9m/s @06:49:54, 덤프 실측). 프롬프트는 9회 전부 억제 → **miss**.
- `IMMINENT_BOARDING_ARVLCD={0,1,2}`가 cron 60s 샘플에 **한 번도 안 걸림** — 도착창(진입→도착→출발 ≈30~60s)이 폴링 갭으로 빠지는 미스가 #2834 스펙 작성 시 우려 그대로 실측 확인됨.
- 사용자 열차와 가장 근접한 관측은 5(전역도착)/3(전역출발) — 직전역 신호(도착 1~2분 전).
- leg-resolve는 2060을 06:52:28(뚝섬 도착 30초 전)에야 confirmed — 프롬프트/락 모두 늦음.

## 결정: fire 집합에 approaching 계열 {3,5} 추가 (별도 decision 라벨)

- `APPROACHING_BOARDING_ARVLCD = {3 PREV_DEPARTED, 5 PREV_ARRIVED}` — 직전역 출발/도착 = 도착 60~150s 전. 플랫폼 대기 사용자에게 "곧 도착" 프롬프트로 적절한 창.
- **4(PREV_ENTERING, 전역진입)는 제외** — ≈2~3분 전이라 9/30 조기 불만(4분 전 발사) 창에 근접 + 10/2 실측에 미관측. 측정 후 필요 시만 확장.
- 판정 순서: imminent{0,1,2} → **approaching{3,5}** → null-fallback(지하 보존) → suppress.
- decision 라벨은 `'approaching'`으로 **분리**(기존 'imminent' 재사용 금지) — 조기 불만 재발 시 D1 meta만으로 창 조절 판단 가능해야 함.
- 반복 방어는 기존 그대로: 5분 repeat gate(MIN_FIRE_INTERVAL_MS) + MAX_FIRE_COUNT=3 + fire-once key(#2838) + trainCode ledger. **이 PR에서 반복 로직 변경 금지.**
- arvlCd **하드 필터 금지 불변 유지** — pool은 그대로 payload로 나간다(기존 §4 금지사항 승계).

### 기각 대안 (기록)
- ETA(etaSeconds) 임계 병용: 연속값이라 샘플링 미스에 강하나 D1에 ETA 미기록 → 10/2 실측 replay 불가, 검증 불가로 기각.
- transition 기반(전 cycle 대비 arvlCd 전이): cron stateless + KV eventual-consistency((b) 레이스)로 기각.
- {0,1,2} 유지 + 폴링 주기 단축: CF cron 1분 하한 + quota, 기각.

## 수정 지점 (전 경로 커버 증명)

- `backend/alarm-worker/src/boardingPrompt.ts:123~155` — `IMMINENT_BOARDING_ARVLCD` 옆에 `APPROACHING_BOARDING_ARVLCD` 추가, `decideBoardingPromptFire`에 approaching 분기 + `BoardingFireDecision`에 `{fire:true; decision:'approaching'}` 추가. 헤더 주석(#2801 임박 정의)도 갱신.
- GPS 9단 경로(①)는 #2844로 은퇴 — 발사 전 경로(origin gps-free scheduled.ts:7426 / leg-2 :7679)가 공유 본체 `fireBoardingPromptForAnchor`(:7084 `decideBoardingPromptFire`) 경유 → **순수 함수 1곳 수정으로 양측 자동 커버** (/audit-sides 선제 증명).
- `tripEventLog.ts` outcome union — 'approaching' 라벨이 D1 meta(gateDecision)로 나가는 경로 확인. outcome 자체는 'fired' 유지(발사는 발사) + meta.gateDecision='approaching'. 기존 계측(§3.4) 확장만, 신규 KV write 0.

## TDD (red-first, 커밋 순서 = 증거)

1. **red A — 10/2 실측 replay** `replay_20261002_leg2_prompt_miss.test.ts` (신규): 위 표의 candidateArvlCds 시퀀스를 불변 fixture로 박고(출처: D1 trip_events, 수치 조정 금지), 기대:
   - 06:46:11 상당 cycle에서 **최초 발사**(gateDecision='approaching') — 현행 코드에서 red(전 cycle suppress).
   - 이후 5분 내 cycle(06:46:39/06:48:29/06:49:24/06:50:55)은 repeat gate로 발사 0 (스팸 無).
   - 전체 창 총 발사 ≤ 2.
   - trainCode는 D1 미기록이라 재구성(테스트 헤더에 정직 표기 — 재구성 표기는 `replay_20260930_leg2_prompt.test.ts` L21~24 선례).
2. **red B — unit** `boardingPrompt.test.ts`: `decideBoardingPromptFire` 케이스 — [5]→approaching, [3]→approaching, [4]→suppress(의도적 제외), [99]→suppress, [5,null]→imminent 아님+null 공존 시 approaching 우선(결정적 신호가 fallback보다 앞), [2]→imminent(기존 유지). **실패 사유까지 assert**(decision 라벨).
3. **9/30 replay 회귀 처리**: `replay_20260930_leg2_prompt.test.ts`의 조기(cycle A/B) pool이 **재구성 arvlCd=3**을 씀(테스트 스스로 "재구성" 명시, 실측 아님). 열차가 06:46 도착인데 06:42에 3(전역출발≈60~90s 전)이었을 수 없음 — 재구성 오류. 조기 pool을 99(운행중)로 정정하고 커밋 메시지에 근거 명시. **실측 fixture 조정이 아님**(해당 트립 arvlCd는 D1 미로깅이었음). 억제 계약(원거리만 있으면 suppress)은 그대로 성립해야 함.
4. green — 최소 구현(위 수정 지점만).

## 회귀 안전 ("되던 게 안 되지 않게")

- 지하 null-fallback 발사 유지 (replay_20260930 cycle D 통과 유지).
- 원거리(99만) suppress 유지 — 9/30 조기 회귀 재발 방지.
- imminent{0,1,2} 발사 유지.
- 반복 방어 4종(repeat/max/fire-once/trainCode ledger) 무변경 — 기존 테스트 전부 green 유지.
- whole_trip_3leg_e2e 등 기존 suite green.

## Wire 5단

1. orphan: 신규 export는 `APPROACHING_BOARDING_ARVLCD`뿐 — caller(decideBoardingPromptFire) 동일 파일. `npm run lint:orphan` pass 확인.
2. V/X: wrangler tail `leg-boarding-prompt: gate blocked`/fired 로그 reason + D1 `trip_events` meta.gateDecision('approaching' 신규 값).
3. 의존 PR: N/A (backend 단독). 단 **머지 ≠ 배포** — 머지 후 `cd backend/alarm-worker && npm run deploy` 별도 수행.
4. 측정 plan: 배포 후 다음 실측 트립 D1에서 (a) leg-boarding-prompt outcome=fired + gateDecision=approaching 등장, (b) "suppressed-not-imminent 연속 후 leg-resolve confirmed"(=miss 패턴) 재발 0 쿼리. 조기 불만 재발 시 gateDecision으로 {3,5} 창 재조절.
5. Device verify: N/A — backend only.

## 제약

- 코딩: BG implementer(sonnet, worktree). 브랜치 `fix/#2801-approaching-gate`.
- backend 테스트는 vitest (`cd backend/alarm-worker && npx vitest run <파일>`). full suite 금지(BG stall) — 변경 파일 + replay 2종 + boardingPrompt + scheduled 관련만 타겟 실행.
- PR 본문: test-first 명시, base=dev, `Closes` 아님(이슈는 측정 후 수동 close) — `Refs #2801`.
