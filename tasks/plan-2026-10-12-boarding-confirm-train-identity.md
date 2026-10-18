# plan 2026-10-12 — boarding-confirm에 열차 신원 전달

**상태**: 확정 (2026-10-12 사용자 승인)

## 한 줄

사용자가 **탭한 알림이 어느 열차였는지** backend에 알려준다. 지금은 backend가 **추측**(마지막 stamp)하고 있다.

## 시나리오

```
27분차 알림 발사  →  30분차 알림 발사  →  사용자가 27분차 알림을 31분에 탭

지금:  device 로컬 = 27분차 ✅  /  backend = 30분차 ❌
이후:  device 로컬 = 27분차 ✅  /  backend = 27분차 ✅
```

`#2696`("잘못된 lock 하나가 trip 전체 알림을 죽인다")이 이 상황이다 — **backend가 발사 권한자**인데 다른 열차를 들고 있으면 알림이 틀린다.

## 왜 body에 없었나 (이력, 확정)

`#2527`이 엔드포인트를 만들 때:

> **계약 (고정 — native 트랙 #C2가 이 계약으로 병렬 구현)**
> body: `{ action, station, line }`
> register-time resolver … **leg-2 trainCode 승격 로직(이미 존재, 재사용)**

세 가지가 겹쳤다:
1. 호출자가 **LA 버튼뿐**이었고 LA는 열차를 모른다 — `buildLiveActivityContentState`(`liveActivity.ts:120`) 필드는 `stationName`·`lineName`·`lineColorHex`·`etaMinutes` + multiHop(역명·정거장 수)뿐, `trainCode` 없음.
2. 계약을 **고정**해 Swift 트랙과 병렬 구현했다 — 변경 불가 상태.
3. 설계 의도가 *"클라는 '탔다'만 말하고 **열차는 backend가 스스로 해소**"* 였다. 확정 아키텍처(backend 추적, device=탭만)와 정합.

그 후 `#2852`가 device 알림 응답을 같은 엔드포인트에 붙일 때 *"body 계약은 Swift 호출자와 **완전히 동일**"*(`positionUpload.ts:438-441`)로 복사했다. **device는 `trainCode`를 갖고 있었는데(#2819) 계약이 고정이라 안 보냈다.**

## 전제가 깨진 지점

"backend가 스스로 해소한다"가 10/9에 실패했다 — 탭 시점에 정방향 열차가 `arvlCd=99`(운행중)라 `freshCandidatesAtAnchor` 0건. **"다시 묻는 것"이 실패 지점**이었다.

`#2957`이 **발사 시점 stamp**(`legBoardingFireStamp`)로 절반을 고쳤다. 그러나 stamp는 **단일 객체**(`types.ts:388`, `trainCode?` 1개)라 2회 발사 시 마지막만 남는다.

## 실측 증거 (D1, 2026-10-07~09 window)

```
boarding-confirm-result:
  2026-10-09 11:37:39  {"lockState":"leg1"}
  2026-10-09 11:37:43  {"lockState":"leg1"}   ← 4초 뒤 재탭 (반응이 없어서)
  2026-10-07 19:30:33  {"lockState":"leg2","outcome":"resolved"}
  2026-10-07 19:23:37  {"lockState":"none","outcome":"none"}
```

10/9 사용자 탭이 이 엔드포인트를 통했고 `leg1`로 기록됐다. `#2957`이 그 절반(stale lock release + stamp 승격)을 고쳤고, **나머지 절반이 "어느 알림이었는지"** 다.

## 할 일

| | 무엇 | 위치 |
| --- | --- | --- |
| 1 | `/boarding-confirm` body에 **`trainCode` optional 추가** | `validateBoardingConfirmPayload`(`index.ts:2493`) |
| 2 | device가 **탭한 알림의 `trainCode` 전달** | `postBoardingConfirm`(`positionUpload.ts:447`) ← 호출부가 `#2819` 파싱값 보유 |
| 3 | backend가 **받은 값 검증 후 우선 사용** | `isPromotionCorroborated(trainCode, working, now)`(`index.ts:3345`) **재사용** |

3의 기구는 이미 있다 — `#2824`가 sync 경로용으로 만든 검증(`recentPromptCandidates` 15분 창 OR `legResolveStreak` 일치, 두 신호 모두 없으면 backward-safe `true`).

## 안 할 일

| | 왜 |
| --- | --- |
| **LA 버튼(Swift)에 trainCode 추가** | LA content state에 열차 정보가 없다. backend→LA 파이프라인에 먼저 실어야 하며 더 큰 작업 → **별건 분리** |
| stamp를 배열로 확장 | 불필요. 클라가 정확한 값을 보내면 stamp는 폴백으로 남는다 |
| 기존 계약 파괴 | `trainCode` 미전송이면 **현행 stamp 경로 그대로**(하위호환) |
| `promoteStampedTrainCode` 제거 | 폴백으로 유지 — LA 버튼·구 클라가 그 경로를 쓴다 |

## 거부 케이스

| | 상황 | 요구 거동 |
| --- | --- | --- |
| **R-1** | `trainCode` 미전송 (구 클라·LA 버튼) | **현행 stamp 경로** — 회귀 0 |
| **R-2** | 보내온 열차가 발사 이력에 **없음**(외래 값) | **거부** → stamp 폴백. 임의 열차 lock 금지 |
| **R-3** | 15분 창 초과 | 거부 → stamp 폴백 |
| **R-4** | 보내온 열차가 **현재 leg의 것이 아님** | 거부 — 기존 `stale-leg-stamp`(W-4)와 동일 기준 |
| **R-5** | `trainCode` 전송 + 유효 | **그 열차로 lock** (stamp보다 우선) |

## 검증

- **red**: 27분차·30분차 2회 발사 → 27분차 `trainCode`로 탭 → 현재는 **30분차가 걸림**
- **green**: 27분차가 걸림
- **회귀**: `trainCode` 미전송 시 기존 테스트 전부 불변

## 관련

`#2527`(엔드포인트 신설·계약 고정) · `#2852`(device caller 추가) · `#2819`(push payload에 trainCode embed) · `#2824`(sync 경로 trainCode 검증) · `#2957`(stamp 승격, 절반 fix) · `#2696`(WHOLE 탑승 열차 식별)
