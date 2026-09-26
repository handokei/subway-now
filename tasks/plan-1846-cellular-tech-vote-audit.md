# Plan #1846 — cellularTech.ts Vote 신뢰성 Audit

Issue: https://github.com/handokei/subway-now/issues/1846  
Parent: #1821 (environment=unknown 100% fix) 옵션 B follow-up  
Date: 2026-06-26  
Label: docs (코드 수정 없음)

---

## §1 메커니즘 — Vote 알고리즘 + Threshold + Tech 분류

### 1.1 데이터 흐름

```
iOS CTRadioAccessTechnologyDidChange notification
  → CellularTechListener (native module)
    → cache: getCurrentTech() → string | null
      → useCellularTech (5s 폴링)
        → classifyCellularEnvironment(tech)
          → 'surface' | 'underground' | 'unknown'
            → undergroundSSOTConsensus.cellularEnvironmentVote
              → envVotes += 1  (underground)  OR  hard-reject (surface)
```

### 1.2 분류 테이블 (cellularTech.ts SURFACE_TECHS / UNDERGROUND_TECHS)

| CTRadioAccessTechnology 상수 | 세대 | Vote |
|---|---|---|
| `CTRadioAccessTechnologyLTE` | 4G | **surface** |
| `CTRadioAccessTechnologyLTEAdvanced` | 4G+ (CA) | **surface** |
| `CTRadioAccessTechnologyNR` | 5G SA | **surface** |
| `CTRadioAccessTechnologyNRNSA` | 5G NSA (EN-DC) | **surface** |
| `CTRadioAccessTechnologyWCDMA` | 3G | underground |
| `CTRadioAccessTechnologyHSDPA` | 3G+ | underground |
| `CTRadioAccessTechnologyHSUPA` | 3G+ | underground |
| `CTRadioAccessTechnologyGPRS` | 2G | underground |
| `CTRadioAccessTechnologyEdge` | 2G+ | underground |
| `CTRadioAccessTechnologyCDMA1x` | 2G (CDMA) | underground |
| `CTRadioAccessTechnologyeHRPD` | 3G (CDMA) | underground |
| `CTRadioAccessTechnologyCDMAEVDORev0/A/B` | 3G (CDMA) | underground |
| `null` / `''` / 미지 상수 | — | unknown (미투표) |

### 1.3 Vote 사용 방식 (undergroundSSOTConsensus.ts)

- `cellular === 'surface'` → **undergroundSSOT 자체 hard-reject** (환경 확정 모순). `return null` 최우선.
- `cellular === 'underground'` → `envVotes += 1` (환경-확정 1표). station pair ≥ 1이면 2-of-N quorum 달성 기여.
- `cellular === 'unknown'` → vote 미투표. 영향 0.

backend `consensusGate.ts`에서도 동일 contradict 정책 적용:
- `environment=underground + cellularVote=surface` → `cellular-environment-contradicts` → push reject.

### 1.4 Native 동작 상세

- `CTServiceRadioAccessTechnologyDidChangeNotification` observer — 네트워크 전환 즉시 캐시 갱신.
- 5s 폴링 간격: 환경 변화는 분당 1~2회 수준이라 stale 우려 낮음.
- Android / jest / web: `requireOptionalNativeModule` null → 모든 API graceful → vote='unknown' 고정.
- iOS SIM 비활성 / 비행모드: `getCurrentTech()` null 반환 → 'unknown'.

---

## §2 신뢰성 매트릭스 — 한국 지하철 5G/LTE 환경

### 2.1 현재 코드의 기본 가정

`cellularTech.ts` L12 주석:
> "macro cell 안정 coverage. 지하 펨토셀로는 통상 NR/LTE 우선 안 잡힘."

즉 4G/5G → `surface` 분류의 전제는 **지하 펨토셀 / DAS(Distributed Antenna System)가 2G/3G로 fallback하는 구형 방식**을 가정한다.

### 2.2 서울 지하철 실제 네트워크 상황 (2025~2026)

#### 2.2.1 5G (NR / NRNSA) — 한계 명확

| 항목 | 실제 상황 |
|---|---|
| 서울 지하철 5G 커버리지 | 수도권 지하철 주요 노선 일부 구간 5G 상용화 시작 (SKT/KT/LGU+ 2024~) |
| 5G SA (NR) | 실내/지하 커버리지 거의 없음 (2026년 기준 공사 중) |
| 5G NSA (NRNSA) | NR + LTE 앵커 조합 — 지하에서도 잡히는 경우 있음 (5G 기지국 배치 구간) |
| 지하 5G 현실 | 지하 플랫폼 5G 안테나 설치 = 지하에서도 NRNSA 잡힘 가능 |

**핵심 문제**: NRNSA → `surface` vote이지만, 서울 지하철은 **지하에서도 NRNSA를 잡을 수 있다.**

#### 2.2.2 LTE (4G) — 더 심각

| 항목 | 실제 상황 |
|---|---|
| 서울 지하철 LTE 커버리지 | 수도권 전 노선 전 구간 LTE 커버 (100% — 기간통신사업자 의무) |
| 지하 LTE 방식 | 터널 내부 DAS + 중계기 — **LTE 그대로 중계** (2G/3G fallback X) |
| 통신사 정책 | SKT/KT/LGU+ 모두 지하 LTE 유지 (VoLTE 품질 보장 의무) |
| 실제 tech 코드 | 지하에서도 `CTRadioAccessTechnologyLTE` 또는 `CTRadioAccessTechnologyLTEAdvanced` |

**결론**: **현재 코드의 LTE → `surface` 가정은 한국 지하철 환경에서 틀렸다.**

서울 지하철에서는 LTE가 지하에서도 안정적으로 잡힌다. 따라서 `CTRadioAccessTechnologyLTE` 수신 = 지상이라고 단정할 수 없다.

#### 2.2.3 Tech 별 지하 신뢰성 매트릭스

| Tech | Vote (현재) | 지하 발생 가능성 | 잘못된 vote 방향 |
|---|---|---|---|
| `NR` (5G SA) | surface | 낮음 (인프라 미비) | false positive 낮음 |
| `NRNSA` (5G NSA) | surface | **중간~높음** (지하 5G 설치 구간) | **surface false positive 위험** |
| `LTE` | surface | **매우 높음** (지하 100% 커버) | **surface false positive 높음** |
| `LTEAdvanced` | surface | **높음** (LTE-A DAS 중계) | **surface false positive 높음** |
| `WCDMA/HSDPA/HSUPA` | underground | 낮음 (LTE 우선) | underground false positive 낮음 |
| `GPRS/Edge` | underground | 매우 낮음 | underground false positive 낮음 |
| `null` | unknown | — | 영향 없음 |

### 2.3 `underground` vote 신뢰도

- 지하에서 2G/3G가 잡히는 경우: **LTE fallback 실패** (극히 드문 edge case — 지하 DAS 장애, 원거리 역 진입 직전 신호 약화 구간)
- 이 경우 `underground` vote는 올바름.
- 하지만 일반적 상황에서 지하에서 2G/3G는 거의 잡히지 않는다 → `underground` vote는 발생 빈도 자체가 낮다.

### 2.4 `surface` vote 신뢰도 요약

- **지하에서 `surface` vote가 발생하는 경우가 매우 흔하다** (서울 기준 LTE/NRNSA 지하 커버).
- 현재 `surface` vote는 `undergroundSSOTConsensus`에서 hard-reject를 발동한다.
- 즉 **지하에서 LTE 수신 시 underground SSOT 자체가 null 반환** → environment = unknown으로 고착될 수 있다.

---

## §3 Day 2 Evidence 분석

### 3.1 Day 2 trip 상황

```
regression-environment-unknown.txt (FG 시점 dump):
  GPS accuracy=200m → 지하 GPS jitter 확인
  subsurface=false (reason=readings, readings=2) → 기압계 미확정
  signalMask=UUU → 3신호 모두 unavailable
  lockless=true, received=0 → silent push 0건
  environment 추론: inferEnvironment(subsurface=false, surfaceSSOT=false, undergroundSSOT=false) → 'unknown'
```

### 3.2 cellularTech vote가 unknown=100%에 기여한 경로

**시나리오 (가설):**

사용자가 5G/LTE 환경에서 지하철 탑승 (서울 7호선 용마산 → 5호선 사가정):

1. 지하 진입 후에도 `CTRadioAccessTechnologyLTE` or `NRNSA` → `surface` vote
2. `undergroundSSOTConsensus` 호출 → cellular='surface' → **hard-reject** → `null`
3. `undergroundSSOT = null` → `inferEnvironment(subsurface=false, surfaceSSOT=false, undergroundSSOT=false)` → `'unknown'`
4. environment=unknown → 35분 내내 unknown 고착

**증거 부재 요소:**
- Day 2 dump에는 cellularTech vote 값이 직접 기록되지 않음 (rawSignalBuffer에 cellular 필드 없음)
- positionUpload.ts에 `cellularEnvironmentVote` 필드 있으나, 5G/LTE 환경에서 실제 전송값 불명

### 3.3 unknown=100%의 복합 원인 분석

#1821에서 이미 채택한 가설 2(quorum 미달)가 1차 원인:
- arrival API 5/5 error → station pair 0
- WiFi BG nil
- barometer 미정착 (trips 2개: readings=2)
→ station pair 0 → `undergroundSSOTConsensus` → null (station pair ≥ 1 필수)

**cellularTech의 추가 기여:**
- 설령 station pair 1개가 있었더라도, cellular='surface'면 hard-reject 발동
- Day 2 사용자 5G/LTE 환경: cellular vote='surface' 가능성 높음
- 이 경우 barometer stop이 있어도, accelerometer automotive가 있어도 null 반환
- **cellularTech 'surface' vote = underground SSOT 달성의 추가 장벽**

### 3.4 가설 검증 갭

cellularTech vote 값이 실시간 dump에 노출되지 않아 Day 2 trip에서 실제 vote 분포를 알 수 없다.
→ §4 결론에서 관측 인프라 강화를 권고.

---

## §4 결론 — 단독 채택 불가 + 가중치 조정 필요

### 4.1 결론 1택: **현행 분류 정책 부분 수정 필요 (underground 무효화 아님, 가중치 재조정)**

**현재 정책의 문제:**
- `surface` vote → hard-reject (undergroundSSOT)는 **한국 지하철에서 false positive 위험 높음**
- LTE/NRNSA = 지하에서도 흔히 잡힘 → surface hard-reject = underground 판정 차단 → unknown 고착

**수정 방향 (3가지 옵션):**

| 옵션 | 내용 | False positive | 변경 범위 |
|---|---|---|---|
| A. surface vote 무시 | surface vote → unknown 취급 (hard-reject 폐기) | 낮음 (hard-reject 효과 유지 불가) | cellularTech.ts 1줄 |
| B. surface vote → soft-reject | surface vote = envVotes −1 (카운터 감산) | 중간 | undergroundSSotConsensus.ts |
| C. surface vote hard-reject 유지, 측정 강화 | 현행 유지 + rawSignalBuffer에 cellular 필드 추가 + DebugModal 표시 | 영향 0 | rawSignalBuffer.ts, DebugModal |

### 4.2 권고 사항

**즉시:** 옵션 C (측정 강화) — doc only인 이 audit에서 결론을 코드 변경으로 이어갈 근거가 부족하다. Day 3+ trip에서 실제 cellular vote 분포를 관측해야 한다.

**1주 데이터 후:** 지하에서 cellular='surface' 비율이 높다면 옵션 A 또는 B 적용.

### 4.3 `surface` vote hard-reject의 설계 의도 재검토

현재 `undergroundSSOTConsensus.ts:129`:
```ts
// 환경 확정 모순 — cellular가 surface면 underground SSOT 자체 candidate X.
if (cellularEnvironmentVote === 'surface') return null;
```

이 설계는 **global assumption이 틀렸을 때 전체 underground 판정을 막는 강한 게이트**다.
서울 지하철에서 LTE 지하 커버가 100%라면, 이 게이트는:
- 5G/LTE 사용자 → 지하 진입 → LTE 유지 → surface vote → underground SSOT null → environment unknown

이는 **Day 2 35분 environment=unknown 100%의 직접 원인 후보**다.

### 4.4 cellular vote 분류 정책 신뢰성 매트릭스 (최종)

| 역할 | 신뢰도 | 근거 |
|---|---|---|
| `underground` vote (2G/3G) | 중간 | 발생 빈도 낮음. 발생 시 지하 확률 높음 |
| `surface` vote hard-reject | **낮음 (서울)** | LTE/NRNSA 지하 100% 커버 → false surface vote 높음 |
| `surface` vote 단독 채택 | 불가 | 위와 동일 |
| `underground` vote 단독 채택 | 불가 | 발생 시 보조 1표로는 유용 (station pair 필수) |

### 4.5 action item (follow-up 이슈 권고)

1. **rawSignalBuffer에 `cellular` 필드 추가** — 실기기 dump에서 vote 분포 관측 가능하게
2. **DebugModal `## Fusion > cellular vote` 표시** — 현재 미표시
3. **`surface` vote hard-reject → soft downgrade 전환** (1주 데이터 후 결정) — 별도 이슈

---

## §5 Acceptance

- audit plan doc 완성 (이 파일) — 결론 명시: **단독 채택 불가 + surface hard-reject 재검토 필요**
- doc only — 코드 수정 없음 → 100% coverage 불필요
- 라벨: `docs`

## §6 Wire-completion 5단 (PR 본문용)

1. **Orphan**: doc only — 신규 export 없음
2. **V/X dashboard**: cellular vote는 positionUpload.ts 통해 backend log에 `cellularEnvironmentVote` 필드 전송 중. 단, DebugModal에는 미표시 (follow-up 권고)
3. **의존 PR**: N/A — #1821 fix wave 독립
4. **측정 plan**: Day 3+ trip — wrangler tail로 `cellularEnvironmentVote` 분포 1주 관측 (surface vs underground vs unknown 비율)
5. **Device verify**: N/A — doc only (type+unit 아님, 코드 수정 없음)
