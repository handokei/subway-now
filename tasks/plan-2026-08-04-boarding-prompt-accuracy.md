# Plan: "탑승했나요?" boarding-prompt 정확 발사 복구 (2026-08-04)

RCA SSoT: 이슈 #2130. 본 문서는 사슬 전체(5단)의 정확 발사 플랜.

## 0. 사용자 가치 → Acceptance (코드보다 먼저)

**가치**: lock 없이 trip을 시작한 사용자가, 실제 승차 직후 1~3분 내 "탑승했나요?" 알림을 정확히 1회 받고, 응답하면 lock이 생성돼 정확도 사슬(silent push SSoT → 매역/환승/도착 알림)이 살아난다.

**Acceptance (전부 충족해야 close)**:
| # | 조건 | 검증 방법 |
|---|---|---|
| A1 | 실승차 trip에서 prompt 도착 (등록~첫 발사 ≤3분) | 실탑승 dump `boardingPrompt(all)≥1` + push sentAt/receivedAt |
| A2 | 미승차(집에서 route만 설정, GPS 양호) 시 prompt 0건 | 자택 등록 시나리오 1회 + 신규 skip counter |
| A3 | 응답 → lock 생성 → silent push ≥1 수신 | D1 `lock_attached=1` + `silent_push_received≥1` |
| A4 | **15분 창 내 새 열차 도착마다 재발사(무응답 시)** — 같은 열차(trainCode) 중복 0건, collapse-id로 배너 교체(스택 금지) | unit(trainCode dedup) + 실탑승 dump(열차 2대 이상 관측 시 재발사 확인) |
| A5 | 모든 skip이 counter로 관측 가능 (무음 skip 0종) | `/admin` 또는 obs-metrics로 사유별 조회 |
| A6 | C 토글 ON 사용자도 A1 동일 보장 (ADR-014 동급) | infoMode ON 실탑승 1회 |
| A7 | **지하 역사 안에서 trip 시작해도 prompt 도착** (GPS 불가 환경) | 지하 시작 실탑승 1회 + fallback tier counter |

권한 매트릭스: WhileInUse/Always 모두 — prompt는 backend alert push라 권한 무관 도착. 환경 매트릭스: 지상/지하 모두 — archFlag=on 발사 조건이 GPS 아닌 arvlCd 관측이므로 지하 OK. 단 A2 게이트(아래 D2)는 등록 시점 device 판정이라 지하 GPS 불량 시 fallback 명시 필요.

## 1. 사슬 5단과 수리 항목

```
[1 device 등록] → [2 backend 도달] → [3 발사 판정] → [4 device 표시·응답→lock] → [5 검증·관측]
```

### 단계 1 — Device: 컨텍스트 등록 보장 (#2130 Part B-device, 직렬: #2129 머지 후)
- **B-1 (핵심)**: context-heal 조건부 재등록 2-tier:
  - **Tier 1 (일반)**: 활성 trip + 직전 송신에 promptContext 없음 + `currentStation` null→non-null 전환(소스 무관 — GPS/WiFi/fusion) → **정확히 1회** 재등록. #703 의도 보존(raw deps 복귀 금지, sessionKey당 heal 1회 가드).
  - **Tier 2 (지하 fallback, A7)**: 등록 후 60초 내 `currentStation` 미해소 + 지하 판정(subsurface=true 또는 cell 지하 vote) → **route 출발역**으로 context 빌드해 heal (사용자가 역사 안에서 route를 잡았다는 가정). 스탬프 없이 송신.
- **B-2**: heal 시 `originDistanceM` + `originAccuracyM`(GPS 정확도) 쌍 스탬프 — 단계 3 게이트 입력. **fix가 아예 없을 때만 필드 생략 → backend는 부재=발사 허용(관대)**. fix가 있으면 정확도가 나빠도 항상 스탬프하고, backend는 `distance − accuracy > 150m`일 때만 차단(오차 고려 보수 차단).
  - 이 비대칭이 세 케이스를 동시에 처리: 지하(fix 없음→생략→발사) / 자택(acc 9m, d=227 → 227−9>150 → 차단) / **실내 bad-GPS**(예: d=300, acc=150 → 300−150=150 → 경계 차단). 2026-08-04 트레이드오프 검토에서 "acc>100 생략" 초안이 실내 bad-GPS false positive를 열던 구멍을 막은 수정.
- 알려진 한계(counter로 측정): 지상 실내(사무실 등)에서 GPS-dead + 지하 판정도 실패하면 Tier 2 미발동 → prompt miss (안전 방향 선택). 지하 역사인데 지하 판정 실패도 동일 — fallback tier counter로 빈도 관측 후 v2 판단.
- 파일: `useApnsTripRegistration.ts`(+ `boardingPromptContext.ts` 스키마 확장) — **#2129와 동일 파일 → 직렬**.

### 단계 2 — Backend: 평가 도달 보장 + 관측성 (#2131 Part A, **지금 병렬 가능**)
- **A-1**: `if (!geo || !display) return;` → `boardingPromptSkippedNoContext` counter + log. 무음 skip 3종 전수 counter화 (A5).
- **A-2**: #918 continue 재배치 — `evaluateAndMaybeFireBoardingPrompt`를 `if (infoModeEnabled && intermediate) continue` **앞**으로 hoist (lock 없음 + `promptState.fired` 아님 trip 한정). runLocklessIntermediate 동작·순서 불변. (A6)
- 파일: `scheduled.ts`, `boardingPrompt.ts` — #2129 backend(`index.ts` rotation)와 겹침 없음.

### 단계 3 — Backend: 발사 판정 정확화 (#2130 Part B-backend — **#2131 머지 후, B-device와 병렬 가능**)
- **근접 게이트**: `originDistanceM` 존재 + >150m → 차단. **부재 → 발사 허용** (지하/구 클라 관대). trip 등록 후 15분 경과 → prompt 자격 만료(신선도).
- **반복 발사 (A4, 2026-08-04 사용자 결정)**: 기존 "trip당 1회(`promptState.fired`)" 폐기 →
  - 15분 창 내 origin에 **arvlCd=1 열차 도착마다 발사**, `firedTrainCodes` set으로 **같은 열차 1회** dedup (열차가 플랫폼 정차 중 cron 2tick 걸려도 재발사 없음).
  - **정지 조건**: ① 응답([탔어요]→lock 생성) ② 15분 만료 ③ [안 탔어요] dismiss → 기존 5분 silence 유지(그 뒤 창 남았으면 재개, D3 참조) ④ **최소 발사 간격 5분** — 직전 prompt 발사로부터 5분 미만이면 새 열차여도 skip (배차 2~3분 역에서 연발 방지, 기존 "같은 알림 5분 내 재발사 금지" 원칙 및 `DISMISS_SILENCE_MS`=5분과 정합. 2026-08-04 사용자 확인으로 추가). ⑤ **명시 상한 3회** (사용자 확정 — 15분 창 ÷ 5분 간격의 실효치를 hard cap으로 고정, `promptState.fireCount ≥ 3`이면 skip).
  - **collapse-id 고정**(`boarding-prompt-${tripToken.slice(0,16)}`, #2086 규칙 준수) — 새 열차 prompt가 이전 무응답 배너를 **교체**, 알림센터 스택 금지.
- 알려진 한계(명시): heal 시점 227m→이후 도보 접근 케이스는 v1 miss — FG 한정 스탬프 갱신은 후속 카드.
- 파일: `boardingPrompt.ts`(gate #9 재작업), `scheduled.ts`, `types.ts` — **#2131과 동일 파일이라 #2131 머지 후 착수. 단 B-device(src/)와는 파일이 달라 병렬 가능.**

### 단계 4 — Device: 표시·응답 → lock (기존 wire, 검증만)
- 이미 구현됨(#1888 candidateTrains fallback, 응답→lock). Part B PR의 device verify 시나리오에 포함만.

### 단계 5 — 검증·측정
- Unit: cold-start 회귀(캐시 empty+station null→resolve→context 송신), counter, hoist, D2 게이트.
- 실기기 1회(사용자): 경로 설정→승차→prompt 수신→[탔어요]→lock→silent push 확인. + 자택 등록 대조 1회 (A2).
- V/X: 신규 counter를 obs-metrics(또는 `/admin/telemetry`)에 노출 — persist=false 환경에서도 사후 조회 가능하게.

## 2. 결정 필요 항목 (구현 전 사용자 확인 불필요 — 권장안으로 진행, PR에서 이의 가능)

**D1. backend context 자가 합성 fallback** (geo 부재 시 waypoints+stationsLookup으로 origin/next 좌표 합성)
- 옵션 ①: 미구현 — device heal(B-1)만으로 충분, 합성은 유령 trip false positive 증폭 위험 (**권장, v1**)
- 옵션 ②: 구현 + fresh-trip(≤15분)·D2 게이트 동반 — 구 클라 회귀까지 커버, 단 #2129 머지 선행 필수
- 옵션 ③: 합성하되 발사는 안 하고 counter만(shadow mode) 1주 측정 후 ② 전환
- 옵션 ④: 정확성 게이트 보강 신규 작업(디바이스 위치 재확인 push-pull 왕복) — 신규 1주+, v2 후보

**D2. 발사 근접 게이트 임계**
- 옵션 ①: `originDistanceM ≤ 150m` + 15분 신선도, **부재=허용(지하 관대)** (**권장** — 역사 반경 실측 100~180m)
- 옵션 ②: 게이트 없음(현행 B8 유지) — A2 포기, 노이즈 허용
- 옵션 ③: 거리 대신 subsurface/모션 신호 합의 — 지하 진입 후엔 이미 늦음, 기각 사유 기록
- 옵션 ④: 임계 동적화(역별 반경 데이터) — stations.json 확장 필요, v2

**D3. [안 탔어요] dismiss 후 재발사 정책 (반복 발사 도입으로 신규)**
- 옵션 ①: 5분 silence 유지 후 창 남았으면 재개 (**권장** — 명시 거부 직후 잠깐 조용, 다음 열차엔 다시 기회)
- 옵션 ②: dismiss 즉시 trip 전체 종료(재발사 없음) — "안 탔다"를 "이 trip 안 탄다"로 해석. 15분 창 취지와 충돌
- 옵션 ③: silence 없이 다음 열차 즉시 재발사 — 연속 거부 시 스팸(최대 5회 상한이 있어도 체감 나쁨)
- 옵션 ④: dismiss UI에 "다음 열차도 물어보기/그만 묻기" 2버튼 — UX 명확하나 신규 작업, v2 후보

## 3. 실행 순서 (병렬 구조)

```
지금              : #2129 (소형 PR 4개, 진행 중)  ∥  #2131 Part A (backend, PR 2개)
#2129 머지 후      : #2130 B-device (heal 2-tier + 스탬프) — src/ 전용
#2131 머지 후      : #2130 B-backend (근접 게이트 + 반복 발사 + collapse) — backend 전용
                    ↳ B-device와 B-backend는 파일이 달라 서로 병렬 가능
전부 머지 후       : 실탑승 검증 (A1~A7: 일반 승차 1회 + 지하 시작 1회 + 자택 대조 1회) → #2130 close
```

Wire-completion 5단은 각 PR이 개별 충족. #2061 epic(알림≠알람 재설계)과의 경계: 본 플랜은 boarding-prompt 사슬 복구까지만 — 매역 알림 타이밍은 불변.
