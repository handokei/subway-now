# ADR-026 — Fire 판정 단일 권위: backend 단일 emitter + 단일샘플 권위 금지

- **Status**: Proposed (2026-08-07)
- **Depends on**: ADR-025 (트립 등록이 먼저 신뢰성 있어야 backend가 발사 가능)
- **관련 회귀 이력**: dedup 177 commits / false-fire 14 commits / time-integration·arc 34 commits — ①phantom·②storm 반복 실패
- **적대적 검증**: 4개 근본 검증 중 ①②에서 초기안(device 단일 dispatcher / route-progress 화이트리스트 제거) **HOLES-FOUND** → 본 ADR로 재정의

---

## Context

### 두 증상은 같은 병이다

- **증상① (phantom fire)**: 건대 정지 중 GPS 22.1m/s 스파이크 1개 → route-progress arc 적분 → 뚝섬 destination-early 오발사.
- **증상② (storm)**: 동일 알림 3~4회. device dedup(in-memory·프로세스별)이 못 잡는 surface들이 병렬 발사.

둘 다 **"누가·언제 발사(emit)할지"의 권위가 device·backend에 쪼개져 있고, 단일 샘플에 발사 권한을 주는" 문제**다.

### 적대적 검증이 밝힌 것 (초기안 기각 근거)

1. **flag-ON(`arch:simple-arrival-v1`) 모드에선 backend가 primary emitter, device 게이트는 무력화** — `movementGate.ts:317` `isSimpleArchEnabled → reliable:true`. 사용자 실기기가 flag-ON이므로 **device-only 수정은 cosmetic**. (①이 device 수정으로 안 죽던 진짜 이유)
2. **iOS 플랫폼 제약**: backend remote push(`apns.ts`)와 device OS 사전예약 로컬알림(`stationPrescheduler.ts:176`)은 **식별자 공간이 분리**(collapse-id vs identifier) → 서로 coalesce/취소 불가 → **둘 다 유지하면 이중발사는 물리적으로 못 막음**. (②가 dedup 177커밋으로도 안 죽은 근본)
3. **단일 샘플이 공통 defeater**: 22.1m/s 1개(`useRouteProgress.ts:116`), arvlCd=출발 1샘플(`alarm.ts:64`), `arrival-confirmed`가 1폴링 최대값(`pickFusedStation.ts:35`)에 train-identity binding 없음.

### 결론
②를 **확정** 종료하려면 emitter가 **정확히 1개**여야 한다(플랫폼 제약상 유일한 길). 그 단일 emitter는 flag-ON 방향(ADR-022)과 정합하는 **backend**여야 한다. ①은 그 단일 권위가 **단일 샘플에 속지 않도록** consensus를 요구하면 함께 죽는다.

---

## Decision (Option 1 — 사용자 승인 2026-08-07)

1. **Backend = 유일 fire emitter (flag-ON)** — `backend/alarm-worker/src/alarm.ts` `evaluatePhaseWithArrival`가 destination/station/transfer 발사의 whether/when을 단독 결정. device fusion 경로는 flag-ON에서 **표시·보조만, emit 금지**(#2064/#2067 부분 적용의 잔여 emit 경로 정리).

2. **device 매역 OS 사전예약 채널 퇴역** — `stationPrescheduler.ts`의 매역 destination/transfer/station-passed 로컬 발사 제거. 중복 emitter 소멸 → 이중발사 확정 종료.

3. **safetyNet 단일 backstop만 유지** — `safetyNetScheduler.ts`. backend 침묵이 **확인될 때만** 무장 + **발사 직전 position/arvlCd 재검증**(`:272` 기존 게이트 재사용). outage 시 유일 backstop.

4. **단일샘플 권위 금지 (①의 근본)** — 발사 판정은 **temporal/multi-sample consensus + train-identity binding** 필요:
   - backend: arvlCd fire에 consensus(연속 샘플/전역도착 조합, ADR-022 B3 기반) + 트립 boarded train 바인딩.
   - device `arrival-confirmed`: 단일 폴링 최대값 금지, temporal consensus로 재정의. route-progress는 fire 권위 없음(표시 전용).

5. **`arvlcdFireOnceTtl` 활성화** — 현재 `isSimpleArchEnabled()=false`로 dormant(`arvlcdFireOnceTtl.ts:110`). backend 단일 emitter의 fire-once dedup으로 활성. (어린이대공원 13:31/13:32/13:37 재발사 = 이 dormant 때문)

---

## Consequences

### 제거
- `stationPrescheduler` 매역 emit 경로.
- route-progress의 fire 권위 (`trainProgressing` 화이트리스트 `useFusedNearestStation.ts:1839`, phase gate `useStationAlarm.ts:1065`가 estimator만 보는 구멍).
- device 중복 fire 경로 (flag-ON 잔여).

### 유지
- `safetyNetScheduler` (outage-only, position-gated backstop).
- LA 업데이트(표시), boardingPrompt(별도 클러스터).

### 추가
- backend `alarm.ts`에 consensus + train-identity binding.
- `arvlcdFireOnceTtl` 활성 wire.
- device fusion `arrival-confirmed` temporal consensus 재정의 + `FusionSource`를 fire 게이트에 plumb(잔여 device emit 차단용).

---

## Trade-offs (정직하게)

- **miss 위험**: 매역 사전예약 backstop을 없애므로 backend outage/APNs 지연 시 safetyNet 하나에 의존. **ADR-025(등록 신뢰성) 선행 필수** — 오늘처럼 트립이 등록조차 안 되면 backend가 못 쏜다. (ADR-010: miss = 오발사 동급 손실)
- **flag-ON 전제** — flag-OFF로 되돌리면 본 ADR 무효(device 권위로 회귀 = ADR-022 롤백).
- **backend + device 양 코드베이스** 수정 → 같은 파일 직렬 머지, 실기기 재검증 필수.

---

## Acceptance (PR 머지 = close 금지)

1. **red replay fixture 선행** — 2026-08-07 오전 덤프로 (a) 대기중 뚝섬 오발사, (b) 동일알림 3~4회를 **재현(red)**, 단일 emitter 적용 후 **green**(fire=1, 대기중 fire=0).
2. **field verify** — 실탑승 1주: 이중발사 0건 + 미탑승/정지 중 오발사 0건 + outage 시 safetyNet backstop 1회 도달 확인.
3. **관측** — `arvlcdFireOnceTtl` 활성 후 backend fire-once dedup 카운터 노출.
