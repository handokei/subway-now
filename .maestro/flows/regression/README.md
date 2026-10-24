# Maestro 회귀 fixture (#922)

2026-06-05 실기기에서 발생한 4건의 알람 회귀(Seam B/C/E/F)와 후속 Seam A(#897 lock 지연 칩),
Seam D(#456 DebugModal 진입), Seam G(#903 barometer sticky wireup), LA refresh heartbeat
(#900), Epic #912 P1 A1(#916 backend 자동 lock) / A3(#918 사전 예약 fire delta)를 단위
테스트 외에 실기기-동등 환경에서 회귀 가드로 잡기 위한 Maestro flow 모음.

## 구성

- `scripts/maestro-mock-backend.ts` — BFF arrival + alarm-worker endpoint를 mock하는
  단일 파일 HTTP 서버. fixture(JSON) driven 으로 시나리오 추가는 파일 1개만 더하면 된다.
- `scripts/fixtures/regression/<scenario>.json` — 시나리오별 station 응답 phase.
- `.maestro/flows/regression/<scenario>.yaml` — GPS 좌표 + UI 검증 step.

## 로컬 실행

```bash
# 1) mock backend 기동 (별도 터미널, plain Node — 추가 의존성 없음)
SCENARIO=seam-b-13-19 PORT=8788 node scripts/maestro-mock-backend.js

# 2) 시뮬레이터에 mock-wired 빌드 설치 (env 주입은 ios/.xcode.env.local로)
echo 'export EXPO_PUBLIC_USE_BFF=true' >> ios/.xcode.env.local
echo 'export EXPO_PUBLIC_BFF_URL=http://localhost:8788' >> ios/.xcode.env.local
echo 'export EXPO_PUBLIC_ALARM_BACKEND_URL=http://localhost:8788' >> ios/.xcode.env.local
# Seam D (DebugModal 진입) 시나리오를 release 빌드로 실행할 때만 필요. dev 빌드(__DEV__=true)는 불필요.
echo 'export EXPO_PUBLIC_DEBUG_MODAL=true' >> ios/.xcode.env.local
npm run ios

# 3) flow 실행
maestro test .maestro/flows/regression/seam-b-13-19.yaml
```

## 시나리오 인덱스

| 파일 | Seam | 회귀 시점 | 검증 내용 |
| --- | --- | --- | --- |
| `seam-b-13-19.yaml` | B | 13:19 transfer/early/건대입구 fired @ 성수 | 성수 정지 + 건대입구 5분 후 ETA → false-positive 발사 없음 |
| `seam-c-hydration.yaml` | C | #899 hydration seam (#922 deferred / #1200) | 강남→역삼 trip 형성 후 destination 해제 + BG/FG cycle 재수화 → stale chip/ghost 알람 0건 |
| `seam-e-13-39.yaml` | E | 13:39~45 lockMissing | `/boarding-lock/sync` 응답이 advanced=true여도 ghost 알람 발사 0건, chip 안정 |
| `seam-f-13-24.yaml` | F | 13:24~28 trainCode 7174 사라짐 | 25s 시점 trainCode drop 후에도 lockMissing/ghost 알람 발사 0건 |
| `seam-a-delay-chip.yaml` | A | #897 lock 지연 칩 | 어린이대공원에서 7180 lock 후 phase 30s 전환 → `boarding-lock-hop-delay-chip` `+4분 지연` 노출 |
| `seam-d-debug-entry.yaml` | D | #456 DebugModal 진입 | 설정 탭 → version footer 7-tap → `debug-modal` + `debug-arrival-summary` 노출, close 정상 |
| `seam-g-sticky-wireup.yaml` | G | #903 barometer sticky wireup | 지하 좌표(보문) 단순 trip 90s 안정 — sticky 강등/알람 게이트 wire-up 회귀 시 ghost 알람 표면화 |
| `seam-la-refresh-heartbeat.yaml` | LA-heartbeat | #900 LA refresh heartbeat | ETA 정체(arrivalSeconds=180 stable) 90s 동안 트립 chip + 알람 안정. heartbeat 게이트 회귀 시 ghost 표면화 |
| `a1-auto-lock.yaml` | A1 | #916 backend 자동 lock | 강남 → 역삼 destination만 설정 → `autoLockCandidate` 응답으로 row 탭 없이 `boarding-lock-hop-card` 노출 |
| `a3-preschedule-fire-delta.yaml` | A3 | #918 사전 예약 burst | 어린이대공원 자동 lock 후 30초 안에 `alarm-overlay` 미노출 — fire 시각 가드(`fireMs <= nowMs`) 회귀 방지 |

보류 → 해제:
- Seam C — 원래 #922에서 transfer-leg / FG-return / silent push 이벤트 mock 설계 결함으로
  보류됐다. H5(#1012, hydration state machine) 머지 후 #1200에서 **client-observable 경로**
  (사용자 destination 해제 + stopApp/launchApp BG/FG cycle 재수화)만 가드하는 형태로
  추가됨. server-side trip-ended silent push / 환승 waypoint 통과 검증은 fixture 구조상
  여전히 단위 테스트 영역(#899 acceptance)에 위임한다.

## fixture 작성 가이드

`scripts/fixtures/regression/<name>.json` 스키마:

```jsonc
{
  "name": "사람이 읽을 시나리오 설명",
  "seam": "A|A1|A3|B|C|D|E|F|G|LA-heartbeat",
  "arrivals": {
    "<역 이름>": [
      {
        "fromMs": 0,           // 서버 기동 시점 기준 활성화 오프셋(ms)
        "body": {
          "up":   [/* ArrivalInfo[] */],
          "down": [/* ArrivalInfo[] */],
          "source": "realtime" // optional, 기본 "realtime"
        }
      }
    ]
  },
  "strictStations": false,     // optional, 없는 역 요청 시 200 빈 응답(false) vs 404(true)
  "boardingLockSync": {        // optional (Seam E). POST /boarding-lock/sync 응답.
    "response": {              // 없으면 기본 { ok:true, advanced:false } 반환.
      "ok": true,
      "advanced": true,
      "currentWaypoint": "군자",
      "nextStation": "중곡",
      "autoLockCandidate": { "trainCode": "7180", "line": "7", "subwayId": "1077" }
    }
  }
}
```

`receivedAtMs`는 서버가 phase activation 시각으로 자동 주입하므로 fixture에는 0으로 둔다.

## CI

`.github/workflows/e2e.yml`의 `regression` job이 nightly로 실행. 시나리오 추가 시
job의 `scenarios` matrix에 fixture 이름만 추가하면 된다.
