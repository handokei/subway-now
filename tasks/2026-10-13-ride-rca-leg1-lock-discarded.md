# 2026-10-13 06:23 트립 RCA — 탭한 lock이 버려지고 매역 알림이 전멸한 사슬

증거: 실기기 덤프 `~/Downloads/텍스트-DF4BA273BDDE-1.txt`(20:37 저장, 트립은 06:23~06:47) + D1 `trip_events` 21건(authoritative).

## 0. 이 트립이 유효한 배포 후 검증인 근거

| | 시각(KST) |
| --- | --- |
| 마지막 머지 `00b8cf85` | 10-13 05:48 |
| 앱 빌드 (`main.jsbundle` mtime) | 10-13 **06:14:52** |
| backend 배포 (버전 `9a8f0c46`, 100%) | 10-13 **06:13** |
| 트립 | 10-13 **06:23:50 ~ 06:47:04** |

앱 빌드가 마지막 머지보다 26분 뒤 → 오전 머지분(#2960·#2952·#2963·#2965·#2970) 전부 포함. 트립은 양쪽 배포 이후.

덤프 저장 시각(20:37)은 앱 재실행 15초 후라 **라이브 버퍼는 전부 비어 있다**(`BoardingLock active=no`, `Trip lifecyclePhase=none`, Drift/Lifecycle 버퍼 0건). 증거로 쓸 수 있는 것은 지속 로그(Alarm log 200 / Counters / Notifications fired)와 D1뿐이다. 20:36:53 `lifecycle-backstop | fired | trip-lifecycle-force-ended`는 재실행 시 정리이며 트립 거동이 아니다.

## 1. ROOT — leg-1 boarding-confirm이 body trainCode를 읽지 않는다

`backend/alarm-worker/src/index.ts:2287`

```ts
const bodyTrainCodeLock =
  releasedForLegSwitch && payload.trainCode !== undefined   // ← 게이트
    ? resolveBodyTrainCodeLock(working, payload.trainCode, payload.line, payload.station, now)
    : null;
```

`releasedForLegSwitch`는 `:2254`에서 `false`로 시작해 **`:2267`에서만** true가 된다(설정 지점 전수: 2254·2267 두 곳). 그 `:2267`은 `if (working.boardingLock !== undefined)` 블록 **내부**다.

→ **이미 lock이 있어 release된 경우(환승 leg-2)만 body trainCode를 읽는다. 첫 탑승(leg-1, lock 없음)은 device가 보낸 trainCode를 열어보지도 않고 버린다.**

`#2958`이 안전을 위해 이 게이트를 걸고 주석에 *"그 경로는 stamp 유무와 무관하게 100% 무변경"*(`:2282`)이라 명시했고, **`#2963` 스펙이 그 게이트를 그대로 상속했다**. 사용자 요구는 "락은 LA·알림·수동탭 다 가능하게"였고 **첫 탑승 알림 탭**이 빠졌다. `/audit-sides` 축으로는 **시간축(트립 시작 vs 환승 경계)** 편측.

### 필드 증거

```
device 06:27:44  boarding-prompt | fired | autolock-success | 7·용마산
device 06:27:44  boarding-prompt | received | response-boarded
D1     06:27:45  boarding-confirm-result
                 {"lockState":"none","outcome":"none",
                  "noneReason":"position-resolve-none","anchorSource":"promptDisplay"}
```

device는 **로컬 autolock에 성공**했다(사용자 체감 "27분 진입 시 락생성"이 정확하다). 그 trainCode를 confirm으로 보냈고 backend가 게이트로 버렸다. `trainCodeSource` 키 자체가 meta에 없다.

fallback인 live 재조회는 `:2275` 주석이 예고한 방식 그대로 실패했다 — *"탭 시점에 정방향 열차가 아직 앵커 역에 물리적으로 도착하지 않아(positions `freshCandidatesAtAnchor` 0건) live 재해소가 none으로 끝난다"*.

## 2. 사슬 — ROOT가 "매역 알림 없음"을 직접 만든다

`boardingAnchorResolver.ts:713`: *"`runTrainCodeTracking`(lock 경로) 대신 `runLocklessIntermediate`로 흘러 **leg-1 매역 발사가 전멸**"*. 즉 매역 push는 **lock 활성이 전제**다(`scheduled.ts:2137`).

```
06:27:45  탭 → lock 없음 (§1)
          └→ runTrainCodeTracking 미진입 → leg-1 매역 발사 0건
06:28:04  마지막 sync (용마산)
06:29~35  device BG 전멸: gate-accuracy 20회, acc=1322~2068m (지하)
          └→ 8분 12초 position 공백.  사용자: 29분 중곡 / 31분 군자 통과
06:36:16  재부상 → sync(건대입구) → waypoint queue 점프
          cron-fire-attempt 어린이대공원(세종대)  outcome=sent          ← 이미 지난 역
          cron-fire-attempt 군자(능동)           outcome=skipped-by-shift ← 폐기
          cron-fire-attempt 중곡                 outcome=skipped-by-shift ← 폐기
06:36:20  advance 성수 {"shiftedCount":4}
```

> 🔴 **정정(사용자 지적)**: 최초 서술은 *"두 축이 동시에 죽었다 — backend는 lock이 없어
> 추적 불가, device는 지하 GPS 게이트로 보고 불가"* 였다. **틀렸다.** 지하 GPS 불가는
> **아키텍처의 전제**이고(그래서 backend가 추적한다, `decision_ARCHITECTURE_COMMITTED`),
> 고쳐야 할 결함이 아니다. GPS를 공동 원인으로 적으면 이미 폐기된 축(지하 GPS 확보)으로
> 유도한다 — `feedback_no_gps_for_decision`.

**원인은 lock 부재 하나다.** 같은 트립이 그것을 증명한다:

```
마지막 sync  06:36:26
lock 확정    06:43:32   (leg-resolve streak)
발사         06:45:32  성수 sent    ← sync 없이 발사
            06:46:56  뚝섬 sent    ← sync 없이 발사
```

`recordFireAttempt`는 `scheduled.ts:3633`에만 있다 — **cron 전용**이다. 즉 **lock이 있으면
device position 없이 arvlCd로 발사된다**(위 두 건이 그 증거이고, 그때도 지하였다). 중곡·군자가
침묵한 이유는 GPS가 아니라 **그 구간에 lock이 없었기 때문**이다. 재부상 시 큐 점프
(`skipped-by-shift`)도 lock 부재 구간이 길어져 생긴 결과다.

## 3. 사용자 피드백 ↔ 증거 매핑

| 사용자 피드백 | 판정 | 증거 |
| --- | --- | --- |
| 27분 진입 시 락생성 | **확정** | device `06:27:44 autolock-success 7·용마산` — 로컬 lock은 성공 |
| 28분에 또 "탑승여부" 알림 | **미확정** | device/D1 양쪽에 28분 프롬프트 기록 **없음**. 단 **06:45:35 `boarding-prompt fired 7·건대입구`** 가 있다 — 이미 끝난 7호선 leg·이미 지난 환승역의 **유령 프롬프트**(2호선 성수~뚝섬 구간 중). 별건 결함 후보 |
| 29 중곡 / 31 군자 도착, 매 역 알림 없음 | **확정 + root 완결** | §2 — lock 부재 + `gate-accuracy` 20회(지하) → 8분 공백 → `skipped-by-shift` 폐기 |
| 35 건대 하차 후 36분에 어대 알림 | **확정** | `06:36:16 cron-fire-attempt 어린이대공원 outcome=sent` — ≈3분 지난 역 |
| 건대 하차 알림도 옴 | **확정** | `06:36:20 silent-push-received transfer imminent 건대입구` — 하차 **후** 도착 |
| 직접탭 안 함, 자동으로 락 걸린 듯 | **확정** | `06:41:51→06:43:32 leg-resolve-attempt` streak 1→2→confirmed, trainCode **3013**. 탭한 lock은 버려지고 **15분 47초 뒤** 자동 lock이 대신 생겼다 |
| 뚝섬에서 연속해서 옴 | **미확정** | backend는 뚝섬 **1건**만 발사(`06:46:56 vanish-fallback`). device 로그는 06:47:29에 끊김(앱 종료). `fg-evaluated suppressed gate-phase-time-integration 뚝섬` 12회(06:45:46~06:47:29)는 **억제**됨. 수신 출처 불명 — §5 계측 필요 |

## 4. 작동한 것 (회귀 아님, 재litigate 금지)

| | 증거 |
| --- | --- |
| #2958 leg-2 lock | `leg-resolve-attempt` confirmed, `lock_attached=1` |
| #2958 route progress 관계 | `route-signature-mismatch` 4건 **전부 `selfProgress:true`** — 전진·후퇴 양방향 정상 판정 |
| 환승 1역 전 신호 자체 | 06:36:16 어린이대공원(건대입구 직전 역) 발사됨 — **신호는 존재한다. 타이밍이 늦었을 뿐** |
| 트립 종료 | `destination-arrived` / `endPath: lock-active-destination` (좀비 LA 없음) |
| silent push `fired=0` | **의도**(`silentPushTask.ts:20` #2064 패러다임 — 매역/환승/목적지는 device 로컬 발사 금지). `received=5/skipped=4`가 설계대로 |

## 5. 드러난 측정 갭 (fix보다 먼저)

1. **`sync-received` meta가 비어 있다.** `index.ts:3212`(#2560/#2824)에 "sync의 trainCode로 lock 승격" 구조 rescue 경로가 있는데, 06:27:51·06:28:04 sync가 **왜 승격에 실패했는지 판정 불가** — sync payload의 `trainCode`/`boardingLine`과 `isPromotionCorroborated` 결과가 기록되지 않는다. **이것부터 깔아야 §1 fix의 완결성을 검증할 수 있다.**
2. **`trainCodeSource=undefined`가 두 상태를 구분하지 못한다** — "device가 안 보냄"과 "backend가 게이트로 안 봄". #2963의 V/X 지표 자체가 이 결함을 가렸다.
3. **`trip_metrics` 행이 트립의 75초만 담았다** — `started_at 06:45:41 / ended_at 06:46:56`, `orig: 성수`. 실제 트립은 06:23:50 시작(7호선 용마산). 또 `boarding_prompt_displayed=0 / responded=0`인데 같은 트립에 `boarding-confirm-result`가 존재. **회귀 정의를 이 테이블로 backfill하면 틀린다.**
4. **LA push가 전 기간 무계측** — `trip_events`에 LA 관련 kind **0건**(`kind LIKE '%la%' OR '%live%'`). 덤프 `laPushDelivery=0% (0/0)`은 9/16 확정 증상과 같은 값이지만(`useLiveActivityTokenRegistration.ts:4`), "안 보냈다"인지 "기록이 없다"인지 가릴 수 없다.

## 6. acceptance (새 라이드 불필요)

이 트립이 곧 fixture다. 룰대로 "다음 라이드에서 확인"으로 쓰지 않는다.

- **red**: 06:27:45 시점(lock 없음 + body trainCode 존재)을 fixture로 박아 `boarding-confirm`이 `lockState=none / position-resolve-none`을 반환함을 재현.
- **green**: 같은 fixture에서 `lockState=leg1`(또는 attached) + `trainCodeSource='body'`.
- **거부 케이스**: body trainCode가 waypoint line과 불일치 / TTL 만료 / `isBoardingLockConsistentWithWaypoints` 실패 시 **승격되지 않아야 한다**(`resolveBodyTrainCodeLock`이 이미 검증하므로 그 호출만 게이트에서 꺼내는 것이 최소 변경).
- **편측 점검**: stamp 경로(`promoteStampedTrainCode`)는 `releasedForLegSwitch` 유지가 맞다 — stamp는 "backend의 마지막 발사 기록"이라 leg 전환 근거가 필요하다. body는 **사용자가 탭한 그 알림**이라 조건이 없다. 이 비대칭을 `invariants.md`에 기록한다.
