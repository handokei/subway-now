# 6/26 4 trip + 6/27 = N=5 paradigm Phase 6 prereq verify

Evidence: backend log 11:22–13:22 KST + 4 device dumps. Token `e25e1158`.

## 6/26 4 trip silent push delivery 표

| Trip | KST | lockless | lock | apnsEnv | recv | recvByKind | fired | V4 |
|---|---|---|---|---|---|---|---|---|
| T1 | 11:58 (11:47–11:58) | true | no | production | 4 | stn=2 dst=0 unk=2 | 0 | NO |
| T2 | 12:12 (12:09–12:12) | false | yes 3186/2 | production | 2 | stn=0 dst=0 unk=2 | 0 | NO |
| T3 | 12:28 (12:14–12:28) | false | yes 2233/2 | production | 8 | stn=1 dst=0 unk=7 | 0 | NO |
| T4 | 12:49 (12:34–12:49) | false | yes 3237/2 | production | 5 | stn=1 dst=0 unk=4 | 0 | NO |
| 6/27 ref | — | — | — | sandbox→prod | 3 | unk=3 | 0 | NO |

`fired=0` 5/5. kind=unk 위주(=분류 wire 회귀).

## 6/26 backend log silent push 발사 타임라인

- `arvlcd-fire: station-passed push`: 4건 (T1×3: 중곡 11:49:44 / 군자 11:51:43 / 어린이대공원 11:53:43, T3×1: 을지로4가 12:24:44)
- `reschedule push`: 15건 (T1=4, T2=2, T3=7, T4=2)
- `alert fallback fire`: 1건 (중곡 11:50:44)
- `fireLiveActivityUpdate`/`laPushSent`: 3건 (12:10:45, 12:11:44, 12:13:44 모두 T2)
- backend 발사 ≈ 19 ↔ device recv = 19 → **전달 정상**, 회귀는 device-side 분류/fire
- `boarding-lock: skip cycle`: **36건** (T1=4, T2=2, T3=5, T4=11, 무-trip=14). `runLocklessIntermediate`: **0건** 2시간 누적
- `apns env mismatch — retry with opposite host`: **6건** (모두 production→sandbox, corrected 1초 후)

## 4 trip isLockConsistentWithRoute mismatch evidence

- **T1**: backend `trainCode=7175 line=7` waypoint advance 3건. device `BoardingLock active=no, lockless=true`. → device mismatch 강제 lock 무력화. **영역 B 직접 evidence**
- **T3**: lock line=2 OK, 그러나 bg-scheduled `revalidate-route-sig-mismatch` 4건/cycle×수십. 마장/건대입구 = route signature drift
- **T4**: `cold-start-mismatch | 2-003 | exp=line-mismatch` (12:34:20) + `lockless-no-user-intent` (12:33:36). **영역 B 직접 증거**

영역 B N=3 (T1, T3, T4). T2는 부분.

## infoModeEnabled wire 부재 확정 (N=4)

4 device dump 전부 `infoModeEnabled` field **부재**. backend cron `skip cycle locklessOptIn=False` 36/36. T1(lockless=true)에서도 동일. → device `/trips`에 미전송 → `runLocklessIntermediate=0` 2h. **#10 N=4 확정**.

## APNs env race 6/26

backend `apns env mismatch` 6건 (모두 production→sandbox) + `corrected` 6건. 캡처(11:47–13:22 KST) **PR #1915 머지(6/26 06:54 UTC=15:54 KST) 이전** + 사용자 로컬 Xcode Release → #1915 미반영. 자동 recovery 작동(6/6).

## 6/27 + 6/26 = N=5 paradigm Phase 6 prereq 검증

| trip | fired | 영역 B mismatch | infoMode wire | APNs race |
|---|---|---|---|---|
| T1 | 0 | YES | YES | YES |
| T2 | 0 | partial | YES | YES |
| T3 | 0 | YES | YES | YES |
| T4 | 0 | YES | YES | (auto-end 도달, 마무리) |
| 6/27 | 0 | YES | YES | YES |

**N=5 모두 V4 미충족**. 5/5 공통 root = **infoModeEnabled wire 부재** (locklessOptIn=false 강제 → runLocklessIntermediate 영원히 0). 4/5는 영역 B. 3/5는 APNs race.

## 이슈 #10 / #11 우선순위 정정

- **#10 (infoModeEnabled wire) — P0 hard-blocker**. 5/5 cover. fix 없으면 V4 영원히 미충족 → paradigm Phase 6 prereq 미성립.
- **영역 B (isLockConsistentWithRoute) — P1**. 4/5 영향, T4 cold-start-mismatch 로그 = 직접 evidence. #10과 독립 병렬 가능.
- **#11 (APNs env race) — P2**. 3/5 영향, 자동 recovery 작동. #10 fix 후 측정.
- 영역 D' / F / H — N=5 직접 evidence 부족, #10 fix 후 1차 측정 재평가.
