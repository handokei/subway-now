# plan 2026-10-03 — selfProgress 순방향 fast-forward (backend 신당 고착 해소)

이슈: #2723 reopen (같은 함수의 편측 — 역방향 보호만 구현, 순방향 수용 누락)

## 증거 (10/3 13:24 트립, D1 전수 + 덤프 실측)

- backend advance가 13:32:39 신당에서 정지. 이후 device가 **전진 서명(동대문역사-rooted)으로 12회 재등록**했으나 전부 `route-signature-mismatch` + `selfProgress:true` → **기존(신당-rooted) 유지로 버려짐**.
- 고착 결과(사용자 가시): 신당 station-passed 2회 발사(13:33:24, 13:37:24 재돌파) / mirror push가 신당 고정 → device `backend-ssot-override`가 정확한 GPS(을지로4가 idx8)를 신당(idx6)으로 **3회 롤백**(13:35:58/13:40:38/13:42:10) / POST /trips 17회 낭비.
- 사용자 증언 5건(10/3 피드백 로그)과 1:1 일치.

## Root — 완전 인과 사슬 (전부 file:line 확정, 2026-10-03 2차 RCA)

backend advance의 입력은 정확히 2채널이고, 오늘 **둘이 각각 다른 이유로 무력화**돼 신당 고착이 발생했다:

**채널 1 — `/boarding-lock/sync` (정상 전진 경로, D1 sync-received 13건 = 덤프 POST 13건과 1:1 일치 확정):**
- device `useBoardingLockSync.ts:16-21,60` — station 관측은 `GOOD_FIX_ACCURACY_MAX_M=50m` GPS 게이트(또는 WiFi)를 통과해야만 실측 역을 보냄. 13:32:38 상왕십리(마지막 좋은 fix)까지는 정상 전진(backend `index.ts:2453 computeLockSyncAdvance` → advance).
- 13:33 이후 지하 구간(신당→을지로, acc 500~1000m, gate-accuracy 26회): 좋은 fix 없음 → **fallback이 lock.boardingStation(성수)을 전송**(#2709 설계, :20-23). 성수는 이미 shift된 역이라 advance no-op — **설계된 무해 fallback이 맞고, "sync 오염"이라던 1차 보고 표현은 정정**(stall에 기여하지 않음, D1 노이즈일 뿐).
- **핵심 갭**: device는 지하에서 arrival/route-progress로 동대문역사·을지로4가를 정확히 알고 있었는데(fusion log 실측), sync 게이트가 **GPS 전용**이라 그 지식이 backend로 전달 불가 → 채널 1 침묵(13:33:25 이후 호출 0). GPS에만 전진 권한을 주는 ADR-039 위반 계보(#2782와 동형).

**채널 2 — `POST /trips` 재등록 (유일하게 남은 전진 입력):**
- device는 전진 서명(동대문역사-rooted)으로 12회 재등록 — 올바른 정보가 backend에 **도달은 했음**.
- `backend/alarm-worker/src/trips.ts:403-405`:
```ts
if (selfProgress) {
  return { existing, reset: false };   // incoming의 전진분을 방향 불문 폐기
}
```
- #2723은 "자기 진행 차이로 reset(상태 소실) 금지"(보호)만 구현 — **incoming이 앞서면 fast-forward 수용하는 분기가 없음**. `isRouteProgressOnly`는 방향 무관 true(13:30:19 뒤처진 incoming(한양대-rooted)도 true — D1 실측).

**판정**: Root 1(주원인) = trips.ts:403 순방향 수용 부재 — 이것만 있었어도 13:36 첫 재등록에서 자가 치유. Root 2(기여·별개 fix) = sync 게이트 GPS 전용 — 지하에서 채널 1을 구조적으로 침묵시킴. 성수 fallback 스트림 = 무해(무용).

## Fix 스펙

`resetTripStateForNewRoute`에서 selfProgress=true일 때 **방향 판정** 추가:

1. **incoming-ahead** (incoming 첫 waypoint가 existing 리스트의 뒤쪽에 존재 = 전방 trim):
   → **fast-forward**: existing의 waypoints를 incoming 앵커까지 shift (기존 advance shift 유틸 재사용 가능하면 재사용). **trip 신원·boardingLock·currentLegAnchor·passedStations·legBoardingPromptState 등 #2723이 지키던 상태 필드 전부 보존** — waypoints 진행도만 전진.
2. **incoming-behind** (existing 첫 waypoint가 incoming 리스트의 뒤쪽에 존재 = device 재등록이 뒤처짐, 13:30:19 실측 사례):
   → **현행 유지** (existing 보존) — 후퇴 금지(단조성). 무회귀.
3. selfProgress=false(진짜 다른 route): 현행 reset 경로 그대로.

### 계측 (기존 meta 확장만, 신규 KV write 0)
- mismatch meta에 `direction: 'incoming-ahead'|'incoming-behind'` + `action: 'fast-forwarded'|'kept-existing'|'reset'` 추가. tripEventLog 타입 union 갱신.

## TDD (red-first, 커밋 순서=증거)

1. **red — replay `replay_20261003_signature_stall.test.ts`**: 10/3 실측 서명 시퀀스를 불변 fixture로:
   - existing=신당-rooted(5 waypoints), incoming=동대문역사-rooted(4 waypoints) 재등록 반복(실측 12회 중 대표 3 cycle).
   - 기대(fix 후): 1회차 재등록에서 fast-forward → backend 현재 waypoint가 동대문역사-rooted로 전진 → **이후 cron cycle에서 신당 station-passed 발사 0**(사용자-가시 surface assert) + mirror(SSoT) 현재역이 전진.
   - 현행 red: existing 유지 → 신당 발사/고착 재현.
   - 보조 케이스: 13:30:19 incoming-behind(한양대-rooted) → existing 유지 assert(기대값 = 무변경, 실패 사유까지 assert).
2. **red — unit** (`trips.test.ts`): 방향 판정 순수 함수 — ahead/behind/동일/비suffix 4케이스 + fast-forward 시 lock/anchor/passedStations 보존 assert(결과값+보존 필드 각각).
3. green — 최소 구현.

## 회귀 안전 ("되던 게 안 되지 않게")

- #2723 원 시나리오(backend 자기 진행 → reset 금지, 상태 보존) 기존 테스트 green 유지.
- incoming-behind 유지(후퇴 금지) — 신규 테스트로 고정.
- 진짜 route 변경(reset) 경로 무변경.
- #2824/#2825 lock corroboration, #2801 approaching 게이트 등 인접 로직 무접촉.
- fast-forward가 cron advance와 이중 전진(레이스)하지 않는지: 같은 cycle 내 순서 확인 — register-time과 cron은 다른 트리거라 KV read-after-write 주의(trips.ts #765 주석의 기존 레이스 클래스 — fast-forward는 putTrip 경유 기존 직렬화(#2129 큐) 안에서 수행).

## Wire 5단

1. orphan: 신규 export 최소(방향 판정 함수) — caller 동일 파일/테스트. lint:orphan pass.
2. V/X: D1 mismatch meta의 direction/action + wrangler tail.
3. 의존 PR: N/A. **머지 ≠ 배포** — #2865와 묶어 배포 1회 권장.
4. 측정 plan: 배포 후 다음 트립 D1에서 (a) mismatch에 action=fast-forwarded 등장, (b) "동일 역 station-passed 2회+override 롤백" 패턴 재발 0, (c) mismatch 연발 횟수 급감(12→1~2).
5. Device verify: N/A — backend only.

## Scope 밖 (후속 — 별개 이슈/매트릭스에서)

- **Root 2**: sync station 관측 게이트에 arrival-confirmed 승격 허용(지하에서 GPS 없이도 전진 통보) — #2782(GPS에만 권한) 계보, 기존 이슈 매핑 검토 후 별도 진행. Root 1이 자가 치유를 제공하므로 2순위.
- mirror push에 lastAdvanceAt 동봉(신선도 판단) — 소유권 매트릭스 2번(현재역).
- 성수 fallback 스트림은 무해 확정 — fix 불요, D1 노이즈 축소는 선택 과제로만 기록.

## 제약

- BG implementer(sonnet, worktree), 브랜치 `fix/#2723-selfprogress-fastforward` (git 인자 따옴표 필수).
- backend vitest 타겟 실행만(full suite 금지): trips.test.ts + 신규 replay + scheduled 관련 접촉분.
- PR: base dev, `Refs #2723`(측정 후 수동 close), test-first 명시 + red 출력 첨부, label bug+backend, assignee handokei.
