# ADR-055 — Trip 상태 DO 이전: 이름 붙은 상태 연산(ops) + 필드 소유권 단계 이전

- 상태: Proposed (2026-11-09) — 구현 진행 중(PR-1~4b·reseed fix 머지, `lock@1`·`progress@1` 운영 중). 채택(Accepted) 전환은 아래 "결과"의 잔여 PR과 관찰 조건 충족 후.
- 관련: #3055, ADR-031(저장 권위 부분 채택), ADR-052(진행 위치 권위 대체), ADR-025, ADR-042, ADR-010, 계획서 `tasks/plan-2026-11-03-trip-do-field-cas.md`(v3)
- 검증 상태 표기: 확인(코드 `file:line` / D1 `trip_events` / replay로 확인) / 추정(미검증, 명시)

---

## 배경

trip 상태(lock·진행 위치·LA 토큰·프롬프트 상태 등 `Trip` 최상위 58필드)는 KV 단일 blob 하나를 여러 writer(register / confirm / sync / position / dismiss / LA register·delete / cron 36곳)가 **읽고-통째로-덮어쓰는** 구조다. KV는 읽기에 `cacheTtl`(최대 60s) 지연이 있고 CAS가 없어, 낡은 스냅샷을 든 writer가 다른 writer의 정당한 변경을 지운다(lost update).

실측:
- 2026-11-03 18:46:59 confirm으로 부착된 lock이 18:47:01 sync(60s 캐시, 18:46:01 스냅샷)의 통째 쓰기로 사라졌고, 이후 cron 시야에서 lockless로 평가됐다(확인: D1 `trip_events`). 사용자 명시 의향(LA 탑승 버튼)이 lock으로 이어지지 않은 것이므로 CLAUDE.md상 **결함(miss)** 이다.
- 같은 패턴: 10/19 재등록이 낡은 `existing`을 읽어 lock이 `undefined`가 됨 — **추정**(재등록 payload에 lock이 있었는지는 D1에 없음, 계획서 §0.1; CLOSED #3084의 lockless 종료 경로 결론과 병기). 11/04 재등록 merge가 `activityPushToken`을 지워 여정 LA push 0건(10/28·11/02·11/03에도 동일, 확인). 10/31 reregister storm에서 진행 위치 되감김 후 같은 역 재소비(확인).

2026-11-03 사용자 결정: **옵션 D("d가 근본") — trip 상태를 per-token Durable Object(직렬화 지점)로 이전한다.** 이 ADR은 그 구현 방식을 기록한다. 최초 구현안(필드 단위 CAS, plan v2)은 2차 `/verify-plan` 반증 12건으로 기각됐고, **같은 옵션 D 안에서 구현 방식을 "이름 붙은 상태 연산(ops)"으로 변경**했다(2026-11-03 사용자에게 보고).

## 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
| --- | --- | --- |
| ADR-031 §1 trip=1 DO, storage 이주 | 저장 권위 | **채택(부분)**: 저장·원자성만 DO로. ADR-031의 self-alarm 발사는 범위 밖이며 변경하지 않는다. |
| ADR-031 Phase 1 acceptance("shadow 일치"), Phase 2b hard-gate("divergence 0") | cutover acceptance | **재배정**: 저장 권위 이전의 acceptance는 본 ADR 지표(M1′=0, 같은 역 재소비 0, `lock-op-conflict` 분포)로 한다. divergence 0 기준은 발사 이전(2b)에만 남는다. shadow 단계는 두지 않는다(shadow는 "일치"를 측정할 뿐 lost update를 막지 못한다). |
| ADR-052 결정 1(progress 작성자 = cron mirror 하나), 결정 2(cron 맞춤) | 진행 위치 권위 | **대체(`progress@N` 단계부터)**: 권위는 DO 진행 셀. 작성 경로는 여러 개일 수 있으나 직렬화 지점이 1개이고 전진은 `headKey` 전제조건 op로만 가능하다. `progress:` KV reconcile(맞춤)은 `progress@N`에서 **퇴역**한다(코드는 롤백용으로 유지). "register는 진행을 쓰지 않는다"는 유지. ADR-052 리스크 "HTTP 낡은 쓰기는 맞춤이 복구"는 폐기. |
| ADR-052 "lost-update 근절은 ADR-031 몫" | 근절 담당 | **재배정**: ADR-031 Phase 2b → 본 ADR. |
| ADR-025 신원 불변 | DO 범위 | 충돌 없음. 1 token DO가 연속 세션을 공유하므로 셀에 `session.seq`를 둔다. |
| ADR-042 권위 모라토리엄 | 발사 권위 | 모순 없음. 본 ADR은 **저장**만 바꾸고 발사·판정 권위를 재배정하지 않는다. |
| ADR-010 두 실패 모드 동급 | 정확성 | 유지. acceptance와 claim-then-fire 실패 정책(결정 7)이 이를 따른다. |
| CLAUDE.md "lock 없음 = 알림 없음 / 자동 lock 없음" | lock 생성 경로 | **충돌 없음을 선언**: auto 계열 op(`attachIfNone`·`swapAuto`·`releaseAuto`)는 **현행 코드의 cron 부착(scheduled.ts cron-leg1/leg2)과 vanish swap을 그대로 옮길 뿐 새 자동 lock 경로를 만들지 않는다.** vanish-swap 존폐는 별도 초안(`tasks/ADR-draft-vanish-swap.md`)의 결정을 따르며 폐지되면 `swapAuto`를 제거한다. 사용자 3경로(탑승 알림 응답 / LA 탑승 버튼 / 목록 직접 탭)는 `authority:user` op로 표기해 auto와 구분한다. |
| 목록 탭 승격 근거(번호 미부여 초안 `tasks/` 하위 draft, `index.ts:3944-3946`) | sync 승격 권한 | 해당 초안은 아직 ADR로 채택되지 않았다. 본 ADR은 이 경로를 `authority:user`로 분류하는 근거로 코드 주석만 인용한다. |
| `docs/agents/invariants.md` HTTP 낡은 쓰기 복구 / lock만 read-after-write 보호 / KV RMW CAS 없음 / register cross-isolate 무방비 | 불변식·한계 | 단계별 갱신·삭제(PR-3 lock verify 생략, PR-4 "HTTP는 waypoints를 저장하지 않음", PR-5 `withTripRegisterLock` 제거, PR-7 삭제). `trips.ts`의 "DO는 별도 이슈 후보"가 가리키던 그 이슈가 본 ADR이다. |
| 코드 주석 3건(`index.ts:2620-2622` disembarked, `index.ts:1414` "순수 release 경로 없음", `trips.ts:171-173` "sync가 swap") | 주석-코드 불일치 | 거짓/낡은 전제로 선언하고 주석 정정. 동작 의미는 유지(disembarked = 현재 lock leg 해제). `listTrips` 경유 line 불일치 lock 정리는 "다음 put이 있으면 영속"에서 **cron op로 즉시 영속**으로 바뀐다(영속 시점 변경, 선언). |
| confirm "release 로직 무관 / 100% 무변경" 주석(`index.ts:2706-2718`) | confirm 의미 | 유지하되 rev 충돌 시 `conflict-kept`(기존 lock 유지) 결과 1개가 추가된다. |
| #3006(KV 쓰기 한도), #2452/활성 마커 | 쿼터·열거 | KV 쓰기는 증가 없음(verify 재읽기는 감소). 새 비용 축은 DO 요청. 활성 trip 열거는 PR-6에서 D1 `active_trips`로 재배정. |

## 결정

1. **trip 상태의 쓰기 권위를 per-token DO(`TripDO`)로 단계 이전한다.** 단위는 필드가 아니라 **상태 셀**이고, 변경은 통째 덮어쓰기가 아니라 **이름 붙은 op**(명시적 전제조건 + 함께 바뀌는 필드 묶음 + 결과 `applied | noop | conflict`)로만 한다.
2. **lock 셀**(PR-1~3): `attachIfNone`, `userBoarded`, `userDisembarked`, `releaseAuto`, `swapAuto`, `refreshExpiry`, `setSegment`, `setEtaMissing`, `registerSession`, `endSession`, `seedFromKv`. lock 전제조건은 **식별 rev**(부착·swap·해제·세션 변경에만 +1, TTL 갱신은 +0). 해제에 딸린 효과(`deleteProgress`, 재확인 push, `infoModeEnabled=true`)는 `outcome===applied`일 때만 실행한다. 만료 lock 위에는 부착 가능(활성 판정 = `lock && expiresAt > now`).
3. **진행 셀**(PR-4): waypoints·currentLegAnchor·prompt 상태·`lastTrackedArrivalEpoch`·`lastLaPush*` 등과 `headKey`. `advanceHead{expectedHeadKey}`는 이미 지나갔으면 `noop`이고 호출자는 **발사하지 않는다**(재소비 차단). `userTapAdvance`는 앞으로만 이동. transfer·intermediate는 **claim(op) 후 발사(claim-then-fire)**, destination은 종료 전에 claim.
4. **flag**: `arch:trip-do-shadow-v1` 값 `off | lock@N | progress@N | full@N`(기존 `on`은 `off`로 정규화). `@N`은 epoch — 재활성화 때 올려 셀 재시드를 강제해 off 기간의 KV 변화를 낡은 셀이 덮어 부활시키는 것을 막는다. **롤백 = 낮은 단계로 KV 쓰기 1회(배포 불필요).** 모든 writer가 overlay된 lock을 KV blob에 다시 쓰므로 롤백 직후 KV에는 거의 최신 사본이 있어 "오늘의 결함 클래스로 복귀"가 하한이다.
5. **안전 장치**: DO 핸들러 안 storage 외 await 금지 + 클래스 내부 promise-chain mutex. lock 변경 지점 전수는 `lockWriteGuard` 테스트로 강제(`noRawSqlGuard` 패턴). overlay 읽기 실패는 fail-closed(모든 op 전제조건 실패 → lock 변경 0). HTTP op 실패 503, cron op 실패는 그 trip의 이번 tick 변경 skip. 발사 직전 `GET /lock` 1회로 tick 시작 스냅샷 창을 막는다.
6. **acceptance**(divergence 0이 아님): M1′ = origin 프롬프트 fired 앞에 `lock-attached`가 있고 그 사이 `lock-released`가 없는 건수 = 0, 같은 트립 창 안 같은 역 재소비 0, `lock-op-conflict` 건수·분포 보고. 검증은 새 라이드가 아니라 11/03·10/19·10/31·11/02 실측 replay와 D1 `trip_events` backfill로 한다(CLAUDE.md "검증은 새 실기기 라이드에 의존하지 않는다").
7. **claim-then-fire 발송 실패 정책(2026-11-09 사용자 결정): claim 후 발송 실패 시 1회 재시도한다.** 근거: ADR-010 — false positive(재발송 중복)와 miss(claim만 소모되고 미발송)는 동급이므로 재시도 0회(miss 쪽 극단)도 무제한(FP 쪽 극단)도 아니라 1회 재시도로 두 실패 모드를 함께 줄인다. 재시도도 실패하면 miss로 기록한다.
8. **#2629(지하 진행 보간)은 `progress@1`이 필드에서 안정화될 때까지 보류한다(2026-11-09 사용자 결정).** 진행 권위가 바뀌는 중에 보간을 얹으면 두 변경의 효과를 분리할 수 없다.

## 대안 (기각)

- **필드 단위 CAS(plan v2)**: 함께 바뀌어야 하는 필드(lock 부착 = boardingLock + 카운터 + LA 필드 + 프롬프트 상태)를 반쪽만 수락할 수 있고, 한 세션 내 다중 commit·반복 읽기·JSON `undefined` 삭제 소실의 기준 스냅샷 의미를 규칙으로 계속 늘려야 한다. 2차 `/verify-plan` 반증 12건.
- **trip 전체 버전 번호 + 낙관적 재시도**: 읽기와 쓰기 사이에 되돌릴 수 없는 부수효과(APNs, D1 `verifyLaCandidate`, Seoul 호출)가 있어 핸들러 재실행은 push 중복, 쓰기만 재시도는 field-CAS로 회귀. `/position`·sync·LA·dismiss가 tick 중간에 끼면 cron의 정당한 쓰기가 전부 거절된다.
- **shadow(dual-write 비교) 후 cutover**: "일치"를 재는 단계는 lost update를 막지 못하고 acceptance(divergence 0)가 모순된다. 폐기.
- **정확성 게이트 보강(현 KV 유지 + 맞춤 강화)**: ADR-052 맞춤이 이미 이 방식이며 진행 위치만 복구한다. lock·LA 토큰 소실은 범위 밖이었고 11/03·11/04에도 재현됐다. 신규 작업이 아니라 한계를 이미 확인한 옵션이다.

## 결과

- 구현·운영 상태(확인):
  - 머지: PR-1 #3310(순수 op), PR-2 #3314(DO `/lock` 라우트·mutex·flag), PR-3a #3328(HTTP 연결), PR-3b #3334(cron 연결·guard·`lock-released`/`lock-op-conflict` 이벤트), PR-4a #3336(진행 셀·ops, 연결 없음), PR-4b #3338(HTTP·cron을 진행 셀에 연결, claim-then-fire), 재시드 지움 fix #3344(같은 burst의 낡은 register가 LA 토큰·lock·진행 셀을 재시드로 지우지 않게 함).
  - 운영 flag: `lock@1` 2026-11-04 22:11 KST부터, `progress@1` 2026-11-09 18:15 KST부터.
  - 현장 증거: 11/06·11/07 라이드에서 D1 기준 lock 부착 → 환승 `lock-released` → 재부착이 관측되고 **무음 lock 소실 0건**.
- 잔여(미착수): PR-5(나머지 필드, `stampFields`·`planRegisterMerge`·`markPrompt`, flag `full@N`, `withTripRegisterLock` 제거) / PR-6(cron 열거를 D1 `active_trips`로) / PR-7(KV trip blob 퇴역, 착수 조건 = `full` 전환 후 2주 관찰, KV `trip:` 쓰기 0 guard).
- 사용자 가시 동작: 사용자 명시 의향(탭/응답)이 낡은 쓰기에 덮이지 않고, 재등록이 LA 토큰·진행 위치를 되감지 않는다. lock 없는 trip의 알림 0은 변하지 않는다.
- close 조건: PR 머지만으로 닫지 않는다. M1′=0·재소비 0이 프로덕션 1주 측정에서 회귀 0일 때(CLAUDE.md Epic close 조건).

## 리스크

- **변환되지 않은 직접 대입**은 DO 모드에서 조용히 무시되어 해제된 lock을 부활시킬 수 있다. guard 테스트(PR-3b)가 유일한 방어선이므로 허용 목록은 함수명 단위로 유지한다.
- **DO 요청 예산(미확인)**: Worker→DO fetch가 Free 플랜 subrequest 한도(호출당 50)에 포함되는지 문서상 불명. 포함된다고 가정해 트립당 overlay 1 + op ≤2 + fresh 확인 ≤1로 제한하고 한도 접근 시 overlay 생략(fail-closed). duration 한도(약 28 trip-hour/일)가 성장 시 먼저 걸린다. 유료 플랜이어도 절감은 타이트하게 유지한다.
- PR-5 전까지 나머지 필드는 낡은 통째 쓰기에 노출된다(lock·진행 셀·LA 토큰 외).
- 롤백 시 KV 사본이 "거의 최신"일 뿐이라 off 직후 짧은 창에서 오늘의 결함 클래스가 재현될 수 있다(하한).
