# ADR-040: 역 통과(station-passed) 알림 표시 경로 단일 발사 수렴

- **상태**: 제안 (Proposed)
- **일자**: 2026-10-08
- **배경**: 사용자 지적 — "알림 표시 경로가 왜 4개나 되는거야 그냥 단일발사잖아"

## 맥락

역 통과 1건이 거치는 경로는 코드상 5개로 보이지만, 실제로 사용자에게 보이는 건 2개뿐이고 나머지는 구조적으로 죽어 있다. 죽은 경로도 로그·payload·KV write를 계속 만들어 **"살아있는 경로가 몇 개인지"를 코드만으로 알 수 없게** 만든다 — 사용자가 "4~5개"로 느끼는 이유다.

- **(A) backend visible alert push** — 살아있음, 사실상 유일한 표시 채널. `scheduled.ts:3622` `fireArvlCdStationPush`(+ `fireVanishFallbackStationPush`). 소리 정책 `:2705-2709`(매역 `sound:null`+`active`, 환승/도착 `alarm.wav`+`time-sensitive`). **collapse-id 비일관 확인**: `:3814/:4029/:4662`는 trip 단위, `:4241`(sync catch-up)만 역 단위.
- **(B) content-available 동반 silent push** — ~~구조적 no-op~~ → **🔴 2026-10-08 정정: 죽은 경로가 아니다.** 표시만 no-op이고(`silentPushTask.ts:1409-1421`이 매역 kind를 `legacy-station-kind-ignored`로 skip, #2064 의도), **그 BG wake 위에 상태 sync가 얹혀 있다**: `persistBackendSsotMirror`(`silentPushTask.ts:1050-1053`, kind 분기 **이전** 실행) + `finally`의 LA/위젯 refresh(`:1425-1446`). `apns.ts:527-533,557-568`이 명시하듯 #2092가 이 조합을 **"SSoT mirror·BG 위젯 채널 복원"** 목적으로 의도적으로 추가했다. content-available을 빼면 **wake 자체가 사라져 상태 sync가 통째로 끊긴다**.
  → **(B)는 "표시 경로"가 아니라 "상태 sync 경로"다. 제거 대상에서 제외하고, 역할을 그렇게 재명명한다.** 1단계에서 실제로 제거한 것은 (D)뿐(PR #2917).
- **(C) device 로컬 FG aux 발사** — 살아있음. `useStationAlarm.ts:304-414` `dispatchStationPassed` → `:396-410`(FG+lock+route+destination). 목적은 backend 전달 지연(실측 35~51s) 우회.
  - **#2903이 1차 가드 구현 완료**: `stationNotification.ts`의 `handleNotification`이 backend push 표시 직전 `markLocalStationFired`로 공유 store 기록 → `fireFgAuxStationPassedNotification`이 `hasRecentLocalStationFire`로 스킵.
  - **남은 공백**: 마커는 "표시된 순간"에만 생긴다 → **아직 안 왔지만 곧 올 push를 기다릴 방법이 없다**. 지금은 기다리지 않고 즉시 발사.
- **(D) legacy prescheduled 취소** — 구조적 no-op. `silentPushTask.ts:1389-1396`이 `'station-passed'` 취소를 시도하나 `AlarmLocalKind`(`alarmLocalAuthority.ts:29`)에 그 종류가 없어 대상이 존재하지 않음(ADR-026 결정 2).
- **(E) LA fallback notification** — 덤프에 다수 관측, file:line 미확인. 본 ADR 범위 밖.

## 이 ADR이 수정·대체·모순하는 결정

**ADR-033 D1을 매역(station-passed) 발사 주체 축에서 뒤집는다.**

- ADR-033 D1(`docs/decisions/ADR-033-per-station-notification-device-authority.md:30-35`)은 "매역 진행 알림의 발사 주체를 **FG device-local 단독**으로 한다. backend `fireArvlCdStationPush`의 intermediate/station-passed kind 발사는 **제거**한다"로 확정했다 — 근거는 backend 경로 지연(35~51s)이 "OO역 도착" 문구를 거짓으로 만든다는 것.
- 본 ADR의 결정표 A행(위 "결정" 표)은 반대로 **backend `fireArvlCdStationPush`를 매역 표시의 Owner로 유지**하고, device 로컬 발사(C)는 "조건부 대리(유예 타이머 후 미확인 시만)"로 축소한다. 즉 발사 주체 축을 device-FG 단독 → backend 1차/device 보조로 재배정한다.
- **재배정 근거**: 본 ADR §맥락 (A)는 "backend visible alert push — 살아있음, 사실상 유일한 표시 채널"이라 기술한다 — ADR-033이 제거를 결정했던 그 backend intermediate kind 발사가 실제 코드(`scheduled.ts:3622`)에는 여전히 살아 있다는 관측이다. 즉 ADR-033 D1·A6(backend 매역 push 제거, 조건부 "A7 지하 FG fusion 매역 발사 실기기 확인 후에만 머지")은 **실행되지 않았거나 롤백됐다** — 본 ADR은 이 현재 상태(backend가 살아있는 유일한 표시 채널)를 그대로 Owner로 공식화한다.
- 이 재배정이 맞는지(ADR-033 제거가 misexecute였는지, 혹은 별도 결정으로 되돌려졌는지)는 본 PR 범위에서 **추가로 확인하지 않았다** — 코드상 backend 매역 push가 살아있다는 사실과 ADR-033 문서상 결정이 반대라는 사실만 대조했다. 두 문서가 같은 축(매역 발사 Owner)에 대해 다른 답을 갖고 있다는 것 자체가 #2931이 막으려는 실패 모드이므로, 여기 명시한다.
- ADR-010("두 실패 모드는 비대칭이 아니라 동급")·ADR-014·ADR-023·ADR-026은 본 ADR §맥락/§대안에서 인용 방식이 이미 각주/근거로 명시돼 있고, 그 인용들은 해당 ADR의 결정을 뒤집지 않는다(매역 무음 정책 유지, false positive/miss 동급 원칙으로 C 완전 제거 대안을 기각하는 데 사용 — 기존 결정과 정합).

## 결정

**원칙**: 표시 책임자는 **A 하나**. 그 책임자가 실패했다고 **device가 스스로 판단할 수 있을 때만**(유예 후 마커 미확인) 대리 **C**가 쏜다. B·D는 제거. collapse-id는 **역 단위로 통일**(사용자 승인).

| 경로 | 목표 | 조치 |
|---|---|---|
| A | **Owner 유지** | `:3814/:4029/:4662`에 station 인자 추가해 `:4241`과 통일. 매역 `sound:null` 유지(ADR-014/023) |
| C | **조건부 대리로 축소** | 유예 타이머 후 `hasRecentLocalStationFire` 재확인 → 미확인 시에만 발사. #2903 마커 재사용, 신규 인프라 없음 |
| B | ~~제거~~ → **상태 sync 소유자로 유지**(2026-10-08 정정) | 변경 없음. 표시는 하지 않지만 BG wake로 SSoT mirror·위젯·LA refresh를 담당한다(#2092). 제거하면 상태 sync가 끊긴다 |
| D | **제거** | `silentPushTask.ts:1389-1396` station-passed 분기 삭제 |
| E | **보류** | 별도 조사 |

## 대안 (기각)

1. **C 완전 제거(순수 단일 채널)** — backend 지연 35~51s 구간에 사용자가 아무 알림도 못 받는다. miss 증가로 기각(ADR-010: false positive와 miss는 동급).
2. **collapse를 trip 단위로 통일** — `collapseId.ts:51-58`의 기존 의도("최신으로 교체, 스택 방지")에 맞추는 안. 그러나 덮어쓰기가 "안 왔다"는 체감을 만든다는 분석에 사용자가 동의해 **역 단위 분리로 확정**.
3. **B·D 방치** — 기능적으로 무해하나, 본 ADR의 출발점이 "코드 표면적이 4~5개로 보이는 것"이므로 죽은 경로는 제거한다.

## 결과

- 알림센터에 역 단위로 배너가 쌓인다(trip당 1건 덮어쓰기 → 역별 유지). 매역은 무음이라 소리 스팸 아님.
- 정상 전달 트립에서 중복 배너 감소, 지연 트립에서는 유예 시간만큼 체감 지연 증가(아예 없는 것보다 나음).
- B·D 제거는 사용자 가시 동작 무변화.

## 마이그레이션

- **0단계 — collapse-id 역 단위 통일**(결정 완료, 위험 낮음). 롤백=1줄 revert. Acceptance: 역A→역B 연속 통과 replay에서 역A 배너 잔존 확인.
- **1단계 — B/D 제거**(가시 동작 무변화). Acceptance: 배포 전후 D1 fired/displayed 비율 불변.
- **2단계 — C 유예 타이머**(위험 최대). feature flag로 감싸 OFF 시 즉시 복귀. Acceptance(신규 라이드 아님, replay): ①정상 전달 트립 → 대리 발사 0 ②지연 트립(35~51s 증거) → 유예 후 대리 발사 발생. 배포 후 D1로 1주 측정.
- **3단계 — E 조사**: 별도 스코프.

## 열려있는 결정

1. ~~collapse 교체 vs 분리~~ — **해소**(역 단위 분리 승인).
2. **유예 윈도우 길이**(제안 15~20초) — #2905 전달률/지연 분포 측정 후 재조정.
3. **소리 등급** — 9/30 3단 우선순위와 충돌 없음(매역 무음 유지). 대리 발사도 동일 등급인지 2단계 구현 PR에서 검증.
4. **lockless 대리 포함 여부** — 현재 `lock &&` 조건이라 제외. `feedback_user_intent_equal_protection`과 충돌 가능, 별도 확인.

## 리스크

- **지하**: device도 네트워크가 끊겨 "backend 미발사"와 "내 미수신"을 구분 못 함 → 현행과 큰 차이 없음. **지상 한정 개선**임을 acceptance에 명시(지하에서 "효과 없음"을 회귀로 오판 금지).
- **BG**: C는 `AppState==='active'` 조건이라 BG 무영향. 본 설계는 **FG 한정**이며 ADR-026의 "매역 로컬 폴백 0건"은 유지.
- **유예 타이머가 새 실패 지점**: 버그 시 "쏴야 할 때 안 쏨(miss)" 발생. 양방향 replay 없이는 배포 금지.
- **마커 race**: 타이머 만료와 마커 생성이 동시일 때 중복 가능 — 0단계 collapse 통일이 "동시 2건 표시" 증상을 흡수하나 완전 제거는 아님.
