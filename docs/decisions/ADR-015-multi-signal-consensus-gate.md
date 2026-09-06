# ADR-015 — 다중 신호 합의 게이트 + Deterministic Environment SSOT

## 상태

Draft (2026-06-18) — 검토 대기

## 배경 — 2026-06-17 17 PR 머지 후 trip 회귀 3건 잔존

2026-06-17~18 새벽 17 PR 머지(#1397~#1430)에도 2026-06-18 오후 실기기 trip(token `35b3502c`, 13:23~13:44) 한 번에 회귀 3건 동시 관찰.

### Trip 사실 (디바이스 dump)

route: 성수(2 3F) → 뚝섬(2 3F) → 한양대(2 2F) → 왕십리(2 B2) → [환승] → 왕십리(5 B5) → 마장(5 B3)

- `subsurface=false` 정상 (지상→지하 환승 trip)
- 13:24:09~13:28:05 leg 1 fire 정상 (성수/뚝섬/한양대 station-passed + 환승 imminent 왕십리)
- 13:28:05 이후 leg 2 fire **0건 (16분 침묵)**
- silent push `received=0 fired=0`
- BoardingLock leg 1(`line=2 trainCode=3212`) 21분 잔존 — 환승 후 release 안 됨
- fusion이 trip route에 없는 **분당선 `왕십리(bundang-053)` variant 반복 채택**
- Environment Distribution counter `underground=91.8%` (subsurface=false와 모순)

### 회귀 3건 cross-layer root cause

| 회귀 | layer 분포 |
|---|---|
| 조기 발사 + 늦은 도착 알림 | 프론트 `useFusedNearestStation.ts:861-887` interp Tier 5 override (`reanchored-hop`/`default-hop` 통과 + ceiling +1 허용 → forward ratchet) |
| leg 2 침묵 16분 | 프론트 fusion route-line filter 부재 + 백엔드→device lock release sync 채널 부재 + 환승 도보 윈도우 미배선 (**3 layer 동시 손상**) |
| 환경 분류 회귀 (`subsurface=false`인데 `underground 91.8%`) | 프론트 `surfaceSSotConsensus.ts:29` `acc≤30m` 임계 미충족 시 default underground 분류 + 환경 SSOT 데이터 부재 |

## 결정

### §1 환경 SSOT = stations.json `environment` 필드 (Deterministic)

stations.json 528역에 `environment: "surface" | "underground" | "mixed"` 필드 도입. 분기 판정은 데이터 기반 deterministic — barometer warm-up 결과 기다리지 않는다. 센서 합의(barometer/WiFi)는 cross-check 용도, 분기 SSOT 아님.

- 서울교통공사 1~8호선(275역): 서울교통공사_역사건축정보 CSV `층수` 컬럼 자동 분류 (B prefix=underground, F prefix=surface, FB 복합=mixed)
- 외부 노선(253역): 위키 + 나무위키 자동 스크랩 + cross-check + 사용자 검수
- 같은 좌표 다중 line 환승역은 line별 separate entry 유지 (왕십리 2/5/gyeongui/bundang 등)

### §2 Fire 권한 영구 박탈 — 시간 적분 strategy 3종

다음 source는 알림 fire 권한 영구 박탈. UI 표시(현재 위치 추적)는 유지, 알림 발사 X.

- `boarding-lock-interp` (시간 적분 lock interp)
- `sticky:locked` (jitter 흡수 표시) — fire path와 표시 채널 분리
- `lockless-route-hop` (lockless 시간 적분 route hop)

코드 위치: `useFusedNearestStation.ts:861-887` Tier 5 override result/confidence 대입 제거, `useStickyStation.ts:307` 결과는 별 채널 `useStickyDisplayOnly`로 격리.

근거: 추정 신호 3종은 지하 dead-zone fallback 의도로 만들어졌으나 fire 권한까지 가져 dedup 누적 → 실측 신호 도착 시 dedup 차단으로 알림 빠짐. dump L335 13:26:14 `interp 뚝섬 d=827m, gp=성수, rt=성수`이 직접 evidence (사용자 성수 정차 중인데 lock 시점 시간 적분으로 뚝섬 오인 fire). memory `lesson_lockless_route_hop_time_integration_ssot_assumption.md` 동일 처방.

### §3 분기별 fire 게이트 — N-of-M 합의

fire는 다중 신호 합의 게이트 통과 시에만 허용. 점수 기반 1개 채택 X.

**신호 분류**

| 신호 | 등급 |
|---|---|
| GPS fix (acc≤30m + 거리≤100m) | strong A |
| arrival arvlCd 1~3 | strong B |
| position-train (호선 일치) | strong C |
| WiFi SSID 매칭 | strong D |
| boardingLock + pos-train 일치 | strong E |
| 기압계 stable verdict | medium F |
| motion activity (walking/automotive) | medium G |
| SSOT stability buffer N=3 stable | medium L |
| route arc progress | weak |

**분기별 게이트**

- `environment=surface`: A + B 2-of-2 OR (A 또는 C 또는 D) + B + medium 1개
- `environment=underground`: C + B 또는 D + B 2-of-2. **GPS는 입력 set에서 reject** (acc 좋아도 무시)
- `environment=mixed`: 보수적. strong 2개 충족 시에만

### §4 합의 안 됨 = fire X

합의 게이트 미통과 시 fire 권한 박탈. UI는 마지막 합의 위치 + 추적 신호 표시, 알림 발사 X.

silent 케이스 한정성 — 정상 FG/BG + 권한 정상 + 비행기 모드 아님 환경에서는 다중 신호 살아있어 합의 통과 가능. silent는 다음에 한정:

- 비행기 모드 (사용자 의도된 silent)
- 권한 회수 (사용자 의도된 silent)
- 전 신호 동시 침묵 (지하 dead-zone + arrival fetch fail + WiFi 미인식 + 기압계 미준비) — 사용자도 인지하는 상태

ADR-010 §"두 실패 모드 동급" 위반 아님 — 합의 가능한 신호 환경에서는 fire 정상 발사.

### §5 Route-line filter (강제)

fusion 후보 산출 시 trip route의 `allowedLines` 외 station/line은 후보 단계에서 reject.

```
trip 활성 (routeContext 있음):
  allowedLines = ∪{
    direct.line ∨
    transfer.fromLine ∨ transfer.toLine ∨
    multi-transfer.transfers[].fromLine ∨ multi-transfer.transfers[].toLine
  }
trip 비활성 (자유 화면):
  filter 미적용 (기존 동작 보존)
```

코드 위치: `findTopNearestStations(..., allowedLines?: Set<LineNumber>)` 시그니처 확장 + `useFusedNearestStation.ts:350-355` 호출에서 `routeContext.route`로부터 `allowedLines` 도출.

근거: `stations.json` L4602 `gyeongui-034 name="왕십리(성동구청)"` vs L5372 `bundang-053 name="왕십리"` — 같은 좌표 다른 이름으로 `findNearestStation.ts:50-71` name dedup 우회. 분당선 variant가 fusion 후보 단계 통과 → `useFusedNearestStation.ts:598-614` cascade에서 result로 채택 → dump L239 `src=position-train | 왕십리(bundang)`. 청량리(서울시립대입구)/(bundang) 등 같은 dedup-bypass 패턴 자동 차단.

### §6 환승 lock 재요청 윈도우 = `transferTimes.json`

환승 도보 시간을 호선쌍별 데이터셋으로 분리. 단순 상수 X.

```json
{ "from": "2", "to": "5", "station": "왕십리(성동구청)", "seconds": 240 }
```

출처: 서울 열린데이터 광장 "지하철역 환승소요시간" 또는 코레일 환승역 정보 등 공공데이터 API. 외부 노선은 운영사 안내도 또는 수동 입력.

게이트: `현재 시각 + transferTimes[from→to] ≤ 다음 열차 도착 시각` 인 traincode부터 boardingPrompt 후보로 진입.

기존 `src/shared/constants/boardingLock.ts:17 TRANSFER_WALKING_BUFFER_SECONDS=180` 단순 상수("정밀화는 후속" 주석) 정밀화. 전체 trip 정적 ETA 산출(`stationRoute.ts:934`)에도 호선쌍별 시간 합산.

### §7 토글 input X — backend fire 결정은 trip 등록만 본다

- C 토글 / lockless toggle / boardingPrompt 응답 / BoardingTrainList 직접 탭 등 사용자 명시 의향은 fire 결정 input X
- backend는 trip 등록 + route + 합의 게이트 신호로만 fire 결정
- 토글 UI는 정보 라벨(예: "현재 lockless 추적 중")로만 유지

ADR-014 §4 "사용자 명시 의향 trip 동급 보장"과 호환 — backend가 토글 무관 정확하게 동작하면 토글 ON trip도 동등 정확성 자동 보장.

### §8 Lock release sync 채널

backend 환승 release(`scheduled.ts:1467-1472 lockReleasedOnTransfer=true`)를 device로 silent push payload에 실어 전파.

```
silent push payload 추가:
{
  ...,
  lockReleasedReason?: 'transfer' | 'expired' | 'vanish' | 'arrived'
}
```

device 동작:
- `silentPushTask.ts`가 `lockReleasedReason` 인식 시 `useBoardingLockStore.releaseLock()` 호출
- `transfer`면 즉시 §6 환승 lock 재요청 게이트로 진입

근거: 현재 backend는 release log만 찍고 device 미통보. dump의 leg 1 lock 21분 잔존이 직접 evidence. memory `project_2026_06_15_lockless_hydration_seam.md` 동일 seam 패턴.

### §9 trainCode lock 정확성 게이트

lock 채택 시 `lock.line`이 trip route `allowedLines` (§5)에 포함되지 않으면 reject.

코드 위치: `useBoardingLockController.ts:176-201 createLockFromTrain` 및 `:221-291 hydrateLockFromCandidate` 진입점, backend `autoLock.ts:158-223` autoLock 9-AND gate 진입점.

근거: #662 환승역 옆 노선 traincode 잘못 매핑 회귀. 분당선 variant 채택과 같은 cross-line 매핑 패턴.

### §10 단계적 마이그레이션 — sub-issue 매핑

- **E0**: 본 ADR 본문 + 메모리 박제
- **E1** (병렬, 데이터): §1 stations.json `environment` 필드
- **E2** (병렬, 데이터): §6 `transferTimes.json` 데이터셋
- **E3** (즉시, ~30줄): §5 Route-line filter — `findTopNearestStations` allowedLines 확장
- **E4** (1주 내, ~50줄): §2 Fire 권한 박탈 — interp/sticky/route-hop override 제거
- **E5** (1주 내, ~80줄): §8 Lock release sync — silent push payload `lockReleasedReason`
- **E6** (E1/E2/E5 완료 후, ~200줄): §3/§4/§7/§9 backend fire 재설계 — 합의 게이트 + 토글 input 제거 + trainCode lock filter
- **E7** (병렬, ~5줄): `useNearestStation.ts:50 distanceInterval=0` — #1416 회귀, FG GPS 회복 prereq

P5 (가중치 학습) 후속: 1주 raw signal dump → confusion matrix → 가중치 자동 조정. ADR-015 본문 임계값 갱신은 별 PR.

### §11 Process 룰 — 양방향 layer 추적

매 sub-issue(E0~E7) 시작 전 다음 체크리스트 통과 후 코드 수정 시작:

1. 건드리는 함수/handler/cron/payload 식별
2. upstream — 데이터 source layer 추적
   - 프론트: hook / component / store / native module (live-activity, motion-activity, audio-route)
   - 백엔드: worker handler / KV / cron / durable object / lockSwap / boardingPrompt evaluator
   - 인프라: silent push(APNs production/sandbox) / widget storage / Live Activity push update / expo-location task / barometer
   - 데이터셋: stations.json / transferTimes.json / locales/* / wifiSsidLookup
3. downstream — 데이터 effect layer 추적 (위와 동일 카테고리)
4. sync 깨진 곳이 발견되면 같이 fix
5. 양방향 회귀 없는지 검증 — layer별 단위 테스트 + E2E 또는 실기기 통합

1줄 patch도 동일 적용. memory `feedback_full_layer_cross_trace.md` 참조.

근거: 2026-06-17 17 PR 회귀가 모두 cross-layer 단일 fix 패턴. backend release vs device 잔존, frontend fusion vs route, scheduled queue dump vs trigger 등.

### §12 Surface-weak cross-impact — RC-3 weighted vote ×  #1876 (D+A hybrid)

#### 배경

- **PR #1876** (`fix/#1876-cellular-soft-downgrade`, 2026-06-26 머지): cellularTech의 LTE/LTEAdvanced/NRNSA를 `'surface' hard-reject` → `'surface-weak' soft downgrade` 전환. `undergroundSSOTConsensus` primary path에서 `envVotes -= 1`로 보수 처리.
- **PR #1884** (`fix/#1884-weighted-vote-fusion`, RC-3): primary quorum 미달 시 `weightedVoteFusion` fallback 호출.

#### 발견된 logical conflict

primary path 미달 케이스에서 fallback이 #1876의 `envVotes -= 1` 의도를 모르고 station을 채택하면 **#1876 보수 정책 무효화**. 예시 (`position(line=2 매칭) + barometer + 'surface-weak'`):

| Path | Math | Result |
|---|---|---|
| Primary (#1876) | pair 1 + envVotes(baro+1 −1) = 1 < quorum 2 | reject (의도) |
| Fallback (#1884, naive) | positional 1.0 + time 0.3 = 1.3 ≥ 1.1 | **accept (의도 무효화)** |

#### 결정 (사용자, 2026-06-26)

**D+A hybrid**:

- **D** — `cellularEnvironmentVote === 'surface-weak'`일 때 `STATION_ACCEPT_THRESHOLD` **1.1 → 1.6 동적 상향**. 강한 multi-source 조합만 station 채택 허용.
- **A** — `weightedVoteFusion`의 기존 `winner === null` 가드 (station 후보 ≥ 1 필수)를 **명시 유지**. env vote 누적이 아무리 커도 station 후보 없으면 reject.

#### 옵션 비교 — false binary 회피 (memory `feedback-decision-no-false-binary`)

| 옵션 | 설명 | 채택 여부 |
|---|---|---|
| A | Primary path에 fallback skip 가드 추가 | `weightedVoteFusion` station 가드로 이미 일부 보장. 명시 보존. |
| B | radio 카테고리에 음수 weight 부여 | weight 음수 금지 (paradigm 위반) — 채택 X |
| C | surface-weak 시 weighted vote 자체 skip | T3 stuck (lockless 진행 불가) 재발 — 채택 X |
| **D** | **threshold 1.1 → 1.6 동적 상향** | **채택** — 보수성 + 진행 균형 |

#### 1.6 선정 근거

| 조합 | 점수 | 1.6 판정 | 의도 |
|---|---|---|---|
| positional full 단독 | 1.0 | reject | steady quorum=2 동등 보수 |
| positional full + barometer | 1.3 | reject | 단일 약 vote는 부족 (의도된 보수) |
| positional full + motion | 1.4 | reject | 단일 환경 vote도 부족 |
| **positional full + motion + time** | **1.7** | **accept** | **multi-source 강한 조합 — lockless 진행 보장** |
| positional partial + motion + time | 1.3 | reject | partial은 더 엄격 |
| 1.8 이상으로 올리면 | — | — | motion+time+positional full=1.7도 fail → 너무 보수, 채택 X |

#### Acceptance (§12 한정)

- `useFusedNearestStation` 환경 'unknown' → 'underground' 전환 trip에서 surface-weak vote 발생 시: weighted vote fallback의 acceptThreshold=1.6 노출 (DebugModal)
- 1주 production 측정: `silentPushFired / silentPushReceived` ratio surface-weak 환경에서도 ≥ 0.5 유지 (#1876 보수 정책 + #1884 fallback 둘 다 작동 시 균형)
- T3 시나리오 (lockless 지하 충정로→용마산) stuck 재발 0건 (D 임계 상향으로 surface-weak 케이스 채택 보수화되더라도 underground primary 케이스는 영향 X)

#### 코드 위치

- `src/shared/constants/fusion.ts` — `STATION_ACCEPT_THRESHOLD_SURFACE_WEAK = 1.6` 상수
- `src/features/nearest-station/utils/weightedVoteFusion.ts:selectAcceptThreshold` — 환경별 임계 데이터 표
- 신규 환경 분기는 `THRESHOLD_BY_ENV` 표에만 한 줄 추가 (CLAUDE.md §3 데이터 주도)

## Acceptance

본 ADR close 조건 — 1주 실기기 trip 누적 측정 (또는 production 측정):

- **조기 발사 0건** — 실제 위치보다 앞선 station-passed/transfer/destination fire
- **늦은 도착 알림 0건** — 실제 도착 시점에 dedup 차단된 fire (= 도착 후 알림 X 또는 한참 후 알림)
- **leg 2 침묵 0건** — 환승 후 다음 leg 16분 이상 침묵
- **route 외 line variant fire 0건** — 분당선/경의중앙선 등 trip route 외 line으로 잘못 매핑된 fire
- **모든 trip 동등 정확성** — lockless toggle ON/OFF, boardingPrompt 응답/무응답, lock 활성/비활성 trip 모두 같은 정확성 기준 충족

sub-issue E0~E7 각각 close 조건: 본 ADR § acceptance 부분집합 + §11 cross-layer 체크리스트 통과.

## Followup

본 ADR 검토 시점에 결정 보류된 후보 조항:

- 사용자 정지/하차 시 lock 자동 release 게이트 (boardingLock BG 카탈로그 case #9, "잃어버리는 케이스" 미커버 항목)
- 모든 신호 침묵 시 backend route + lock + 마지막 fix 시각 기반 ETA prompt fallback (사용자 정정 — "안 되는 것 #15")
- traincode TTL 동적 갱신 (별 트랙 B2와 통합 검토)
- WiFi SSID 데이터셋 (별 트랙 B3와 통합 검토)
- BG WiFi SSID 권한 정책 (Location Always 권한 vs device→backend SSID push)

위 후보는 본 ADR sub-issue 완료 후 1주 측정 결과로 채택 여부 결정.

## 관련 문서

- ADR-010 sensor-fusion-policy (두 실패 모드 동급)
- ADR-013 lockless-supplementation-policy
- ADR-014 decision-process-rules (false binary 금지, 옵션 3개 보장, 사용자 의향 trip 동급 보장)
- memory `feedback_full_layer_cross_trace.md` — §11 양방향 layer 추적 룰 출처
- memory `lesson_lockless_route_hop_time_integration_ssot_assumption.md` — §2 시간 적분 fire 박탈 근거
- memory `lesson_motion_activity_intermittent_signal.md` — motion gate 단독 의존 금지
- memory `lesson_train_progressing_source_strategy_blindness.md` — downstream fix가 아니라 upstream
- memory `project_2026_06_15_lockless_hydration_seam.md` — §8 lock release sync seam 패턴
