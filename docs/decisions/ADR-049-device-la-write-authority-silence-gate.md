# ADR-049 — device LA 쓰기 권위는 "silent push 수신 공백 T"로 판정한다 (ADR-041 결정 3 확정)

- 상태: 채택
- 결정일: 2026-10-29
- 관련: ADR-041, #2735, #2659, #2481, #3221(범위 밖)

## 배경

ADR-041 결정 3은 침묵 판정 신호를 "착수 PR에서 확정"으로 남겼다. #2735 요구 3("push가 없으면 device 재개")은 `liveActivityPushChannel`에서 **등록 성공 시각 + 5분**으로 구현돼 있었다(`LA_BACKEND_AUTHORITY_STALE_MS`). 등록 확인은 한 번의 사실인데 만료 시계로 쓰인 것이다.

실측(2026-10-28 trip 180, 뚝섬→건대입구 환승→용마산): LA token 등록 17:13:29 한 번뿐, lock 17:24:55, 이후 silent push는 최대 92s 간격으로 계속 도달했는데도 권위가 등록 5분 뒤 만료돼 lock 이후 device 쓰기 8건(D2 mirror 전체 교체 / D1·D3)이 backend LA push 내용을 덮었다. 같은 만료가 9/23·10/01·10/18 라이드에서도 재등록 없이 발생했다. BG silent push 핸들러는 JS가 매번 재기동돼 모듈 메모리의 `backendConfirmed`가 비므로 BG에서는 애초에 항상 "미등록"으로 판정되는 결함도 있었다.

수신 간격 실측(덤프 전부, 연속 `silent-push-received` 20분 미만 N=233): p50 60s · p90 185s · max 748s · 600s 초과 3건(653·668·748s) · 30분 초과 0건.

## 이 ADR이 수정·대체·모순하는 결정

| 결정 | 어느 축을 어떻게 재배정하는가 |
| --- | --- |
| **ADR-041 결정 3** (침묵 판정은 기존 신호 재사용, 착수 PR에서 확정) | **확정한다:** 신호 = 기존 `LAST_SILENT_PUSH_RECEIVED_AT_KEY`(마지막 유효 silent push 수신), 임계 T = 10분(`TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS` 재사용). 별도 stamp 키는 만들지 않는다("새 신호 금지" 해석 논쟁 회피). 후보 중 `degraded`·LA push 미수신은 이 판정에 쓰지 않는다. |
| **ADR-041 결정 4** (표시에는 출처를 밝힌다) | **준수·구체화:** backend 침묵 판정 뒤 device가 쓰는 LA(D1·D3·D2/D4)에 기존 `sourceLabel`로 `deviceFallback` 출처를 붙인다(debug 게이트 포함 기존 표면 그대로, Swift 무변경). |
| **#2735 요구 3** | 권위 만료 입력을 "등록 시각 + 5분"에서 "silent push 수신 공백 > T(10분)"로 바꾼다. 등록 확인은 영속(`LA_BACKEND_CONFIRMED_TRIP_KEY`)하고 token-missing 응답(status `hasLiveActivityToken===false`)이 해제한다. lock이 없으면(lockless) 게이트하지 않는다. |
| **#2659** (mirror 경로의 backend-authority 면제) | **좁힌다:** 면제를 "backend가 LA를 갱신 중이 아닐 때"로 한정한다 — 권위 active면 mirror 전체 교체(D2/D4)도 skip. #2659의 면제 근거(LA push 채널 0/0이면 LA가 얼어붙는다)는 수신 공백이 T를 넘으면 권위가 풀리므로 계속 충족된다. D6(auto-locked pre-boarding)도 같은 게이트를 받는다. |
| **#2481** | 유지 — "device 추정치가 backend 정확값을 덮어쓰지 않는다"는 수신이 신선한 동안 보존된다. |
| **ADR-041 발사 축 불변** | 유지 — 이 ADR은 표시 쓰기 권위만 다룬다. 발사는 건드리지 않는다. |

## 결정

1. device LA content writer(D1 `updateStationNotification` / D2 BG mirror / D3 BG gps / D4 FG mirror poll / D6 auto-locked pre-boarding)는 **등록 확인(영속) + lock + 마지막 유효 silent push 수신 공백 ≤ T(10분)** 이면 쓰지 않는다. 하나라도 어긋나면 device가 쓴다(blank/frozen LA 방지가 우선).
2. 생성·시작 계열 writer(D5 pre-boarding, D7 LA 부재 시 FG 시작, D8 채널 세션 start/adopt)는 게이트 대상이 아니다 — lock 전이거나 LA를 만드는 경로다.
3. token 소실 감지(V1-a): silent-push 사이트의 pull 조건에 "lock 활성"을 OR로 추가한다(쿨다운 10분 그대로 -> status GET 최대 10분에 1회, KV read만). 소실 응답은 영속 등록 확인을 지워 device가 즉시 재개하고, 재등록 성공이 다시 설정한다.
4. T=10분 근거: 기존 상수라 침묵 판정과 생존 재확인(status pull 쿨다운)이 같은 시계다. 실측 오판(수신 정상인데 공백 > T) 1.3%, backend 실사망 시 동결 상한 10분. 180s는 12% 오판, 30분은 30분 동결로 기각.

## 대안 (기각)

| 대안 | 기각 이유 |
| --- | --- |
| A1: 신규 `laPushOkAt` 신호 | ADR-041 결정 3(새 신호 금지)과 충돌하고 운반체가 같은 silent push라 분포도 같다. |
| A3′/T=30분 | backend 사망 시 최대 30분 동결. |
| T=180s | 실측 12% 오판 — device가 backend를 자주 덮는다. |
| 현행(등록 5분) 유지 | trip 180 재현. |

## 결과

- lock 이후 backend LA push가 도달하는 동안 device는 LA를 덮지 않는다. 수신이 10분 넘게 끊기면 device가 재개하고 sourceLabel(`deviceFallback`)로 출처를 밝힌다.
- 관측: DebugModal Alarm log `la-write`/`la-refresh-decision`(`backend-authority-skip`)·`live-activity-mirror-skip`(`la-mirror-skip-backend-authority`)·권위 전이.

## 리스크 (알려진 한계)

- **zombie push(U6)** — 판정 stamp(`LAST_SILENT_PUSH_RECEIVED_AT_KEY`)는 payload tripToken 비교(`silentPushTask`, mirror 전용)보다 앞에서 갱신되므로 **다른 trip의 push로도 갱신된다**. backend가 이 trip의 LA를 실제로는 안 쓰는데 zombie push가 오면 device가 최대 T(10분) 침묵할 수 있다. 상한은 T다. reschedule payload에는 tripToken이 없어(`types.ts`) 필터로도 막을 수 없다. 별도 stamp 키로 완화하는 안은 ADR-041 "새 신호 금지" 해석 문제로 보류했다.
- **lockless 이중 writer** — lock이 없으면 게이트하지 않는다(station-passed·reschedule이 없어 수신 신호의 운반체가 없다). lock 없는 trip의 표시는 정확성 보장 대상이 아니다(#3083).
- **FG D4 skip 관측** — mirror 코어의 skip은 `live-activity-mirror-skip`(상태 전이 시)로만 남는다.
