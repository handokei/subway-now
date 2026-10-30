# ADR-051: Live Activity를 탑승여부 LA와 여정 LA 2개로 분리하고, 매역 알림은 여정 LA 다이내믹 아일랜드 축소 표시로 대체한다

- **상태**: **Proposed** (2026-10-30) — 사용자 결정 U1~U7(2026-10-29, plan §13)을 반영. 구현은 #3221 PR-1~6 분할 중이며 이 문서는 PR-3(backend 발사)에 동봉한다.
- **관련**: #3221, #2997(S1·S2), #3101, #3007(S4-c), #2854, #2528, #3146, #3223(ADR-050), ADR-040, ADR-042, ADR-049, ADR-050, `tasks/plan-2026-10-29-3221-la-split.md`
- **검증 상태 표기**: 확인(코드 `file:line` / 10/28 D1 `trip_events` / R2 캡처로 확인) / 추정(미검증)

## 배경

10/28 trip 179·180에서 탑승 질문 행과 여정 상태가 **한 카드에 스택**되어 잠금화면에서 반반 잘렸다. 원인은 backend 여정 content builder 하나가 모든 LA push에 `boardingPhase`를 섞는 것(`liveActivity.ts` `computeBoardingContext` spread)과 위젯이 질문 행을 상태 위에 쌓는 레이아웃이다. 사용자 결정(10/28): "잠금화면 표시를 두 개로 나눠 탑승여부와, 계속 떠 있는 것 두 개로".

2026-10-30 실기기 스파이크(iOS ≥17.2): 잠금화면에 여정 LA와 탑승 LA를 **동시에 표시해도 잘리지 않음**을 확인했다.

## 이 ADR이 수정·대체·모순하는 결정

| 기존 결정 | 축 | 처분 |
| --- | --- | --- |
| #2997 S2(질문·버튼을 여정 LA content의 `boardingPhase`로 표시) | 질문의 운반체 | **대체**: split 클라이언트에서는 질문(탑승/하차/종료 제안)이 별도 탑승 LA로 간다. 여정 LA content에는 질문 필드가 없다(`laClient.split`이면 `buildLiveActivityContentState`가 생략). 구 클라이언트는 현행 그대로 |
| #2997 S1(lock 없어도 pre-boarding 버튼을 여정 LA에 상시 노출) | 버튼 노출 | **split에서 폐지**: 탑승 LA가 질문 시점에만 뜬다 |
| #3101(탑승 LA 표시 개선) | 표시 | **흡수**: 탑승 LA 전용 위젯이 대체 |
| #3007 S4-c(end-prompt 질문을 여정 LA alert로) | 종료 제안 운반체 | **수정**: split에서는 15분 정지 due tick(`isEndPromptDue`)에 탑승 LA(phase end-prompt)를 push-to-start한다. 버튼 [계속 안내]는 탑승 LA만 닫는다(U4) |
| #2854(질문 순간을 LA alert로 병행) | 소리 채널 | **유지, 운반체만 변경**: alert는 탑승 LA start에 실린다 |
| #2528(자동락 "추적중" 변형 — pre-boarding+autoLocked) | 자동락 표시 | **폐기**(U3=A): 답하면 탑승 LA가 사라진다. lock은 사용자 응답으로만 생기므로(`decision_lock_only_alerts`) 질문은 이미 답해진 상태다 |
| #3146(LA alert 성공 시 일반 알림 무음) | 소리 기준 | **유지, 기준 이동**: split trip의 기준은 "여정 LA heartbeat 신선도"가 아니라 "탑승 LA start 2xx"다. 같은 기준을 hop-end 질문에도 적용한다(이중 울림 방지) |
| ADR-049(LA 쓰기 권위 게이트 D1~D8) | writer 범위 | **여정 writer(D1~D4)로 한정**. 탑승 LA writer(B1~B4)는 이 게이트 밖이며 텍스트 계약 테스트로 고정한다(PR-4) |
| ADR-050(매역 알림 트리거 = 진입 또는 도착 중 먼저, 역당 1회) | 매역 알림의 **채널** | **재배정(split trip의 intermediate만)**: 트리거와 역당 1회(`stationPassedFiredKey`)는 그대로, 채널을 "일반 notification(무음 INFO)"에서 "여정 LA 무음 update(DI 축소 표시)"로 옮긴다(§13). transfer/destination은 일반 notification(소리) 유지. 비split trip은 현행 |
| ADR-042(약속 재정의: 매역 알림 약속 창) | 약속 창 | 무변경: 창 시작점(진입)과 끝(다음 역 도착 전)은 그대로. 표면만 DI 축소 표시로 바뀐다 |
| ADR-040(역 통과 알림 단일 발사 수렴) | 경로 수 | 무변경: 새 경로를 만들지 않고 기존 3개 발사 지점(`fireArvlCdStationPush`, 공용 `sendStationPassedAlertPush`, vanish fire)이 같은 헬퍼로 분기한다 |
| `docs/agents/invariants.md:66` "LA 채널은 단일 세션" | 세션 수 | **수정**: "여정 LA 단일 + 탑승 LA 최대 1" |

## 결정

1. **ActivityKit 타입 2개.** 기존 `SubwayActivityAttributes` = 여정(wire 유지), 신규 `BoardingActivityAttributes`(static `promptId`·`tripToken`) = 탑승. end-all·adopt·AppIntent 순회가 타입별로 자동 격리된다.
2. **탑승 LA 시작 경로.** iOS 17.2+ push-to-start(주 경로, 앱이 꺼져 있어도 시작), 17.0~17.1은 앱 foreground 시작만, 16.x는 탑승 LA 없음(일반 알림만).
3. **종료는 기기 소유, update token 미저장(R-a).** 응답 intent / lock 생성 / not-boarded / 재질문 시 이전 end / trip cleanup이 탑승 LA를 닫는다. backend는 탑승 LA update token을 저장하지 않아 KV 쓰기 증가 0이다.
4. **알림 정책.** LA alert(소리)는 탑승 LA start에만 실린다. 여정 LA 갱신은 항상 무음이다. start가 2xx로 수락되면 같은 질문의 일반 알림은 무음이다(실패하면 소리 유지 — 질문을 놓치지 않는다).
5. **`laClient` capability 게이트.** 클라이언트가 register body로 `laClient: {split, boardingStart}`와 push-to-start token을 보낼 때만 split 경로를 쓴다. 구 클라이언트는 byte 동일.
6. **매역(intermediate) 일반 알림 폐지 → 여정 LA 무음 update(§13).** split trip에서 intermediate 역 진입 시 backend가 여정 LA를 `arrivedStationName`(+만료 `arrivedUntilEpochSec`)을 싣고 무음 갱신한다. 다이내믹 아일랜드 축소 뷰는 만료 전이면 왼쪽 "{역}역 도착", 오른쪽 "{N}분·환승{K}역"(환승이 없으면 "{N}분·{K}역")을 보이고, 다음 갱신(content-state 전체 교체)이나 만료로 "역 · N분"으로 돌아온다. 소리·배너·알림센터는 없다. 여정 LA가 live가 아니면 일반 alert로 폴백한다(역 알림을 잃지 않는다). transfer/destination은 지금처럼 일반 notification이다.
7. **두 LA 모두 Line Glass 테마**(PR-5/6).

## 대안 (기각)

| 옵션 | 기각 이유 |
| --- | --- |
| S2 타입 1개 + static kind 인스턴스 2개 | 모든 순회 지점(end-all/adopt/intent)에 kind 필터가 필요해 편측 위험(#2806 계보) |
| S3 질문은 알림만, 여정 LA 질문 행 제거 | 사용자 결정 "잠금화면 두 개로" 위반 |
| S4 LA 1개에서 질문 동안 카드 교체 | 사용자 결정 "1개에 함께 말고" 위반 |
| R-b 탑승 LA update token 저장 | LA당 putTrip 1회 추가(trip 179 +4 / 180 +2). 기기가 push 시작 LA를 감지하지 못하는 것이 실기기로 확인될 때만 재검토 |
| 매역 알림을 아예 끔 | 사용자 결정: 환승·목적지는 소리 알림 유지, 매역만 DI 축소 표시로 대체 |
| 매역 대체 실패 시 알림 없음 | LA 미표시 위험이 알림 유실보다 크다 — 일반 alert 폴백 |

## 결과

- 질문 1건마다 탑승 LA start 1건(10/28 trip 179 replay: 06:27:46 탑승 / 06:35:46 환승 하차 / 06:36:46 leg-2 탑승 / 06:41:49 재질문), 여정 LA push에 질문 필드 0.
- split trip의 intermediate 3역(중곡·군자·어린이대공원)은 일반 alert 0 + 여정 LA update 각 1건. transfer(건대입구)는 일반 alert 그대로.
- 관측: D1 `trip_events` kind `la-boarding-start`(path·phase·status), 매역 대체는 여정 LA push의 `arrivedStationName`. 배포 순서는 backend(split 게이트라 구 앱 무해) → 앱 빌드(PR-1·4·5·6) 후 실효.

## 리스크

- push 시작 LA를 기기가 감지하지 못하면 탑승 LA가 2개 공존할 수 있다(상한: 다음 foreground 또는 trip 종료).
- 매역 대체는 일반 alert push의 `contentAvailable` 부수 효과(기기 BG에서 SSoT mirror·위젯 갱신)도 함께 없앤다 — split trip의 intermediate 매역에서 기기는 그 시점에 깨어나지 않는다. 기기 SSoT는 다른 경로(`/boarding-lock/sync`, 위치 보고)로도 갱신되지만, 이 부수 효과 소실의 실영향은 **추정(미검증)**이며 실기기 확인 항목이다.
- lockless 매역 경로(`runLocklessIntermediate`의 silent push)는 이 ADR의 대체 대상이 아니다(별도 철거 예정, K5).
- 두 LA 동시 표시 시 다이내믹 아일랜드 우선순위(B5)는 실기기 확인 항목이다.
