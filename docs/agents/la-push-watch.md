# LA push 관측 (`la-push`) 와 #2795 감시 쿼리 정의 (#2747 PR-2)

backend가 여정 Live Activity를 **언제 어떤 내용으로** 밀었는지를 D1 `trip_events`(kind=`la-push`)로 남긴다.
device 쪽 LA 쓰기(`la-write` D2/D3)와 같은 trip 타임라인에서 대조해 "backend가 쓴 직후 device가 덮어썼는가"를 사후에 판정하기 위한 기록이다.

## 기록 규칙

- 기록 지점은 `fireLiveActivityUpdate` / `fireLiveActivityDismissal`(`backend/alarm-worker/src/liveActivity.ts`) 한 곳. APNs가 수락(2xx)한 push만 남긴다. 구현은 `laPushLog.ts`.
- 직전 `la-push` 행(같은 `token_hash`)의 digest `(path, stationName, stopsRemaining, etaMinutes 유무)`와 같으면 INSERT하지 않는다. KV write 0, D1만 사용.
- 탑승 LA start는 별도 kind `la-boarding-start`(`boardingLaStart.ts`)이며 여기에 중복 기록하지 않는다.
- `meta` = `{ activity:'journey', path, stationName, stopsRemaining, hasEta, etaMinutes? }`, `station`=stationName, `line`=lineName.

| path | 호출부 |
| --- | --- |
| `update` | `maybeFireLiveActivityUpdate` (ΔETA / heartbeat / 즉시 trigger) |
| `advance` | `completeWaypointAdvance` (waypoint 통과 직후 새 hop) |
| `station-passed` | `trySendStationPassedAsLaUpdate` (split trip 매역 무음 update) |
| `prompt-alert` | `firePromptLaAlert` non-split 폴백 (질문 alert를 여정 LA update로) |
| `end` | `fireLiveActivityDismissal` (event=end) |

## 조회

```bash
cd backend/alarm-worker
npx wrangler d1 execute <DB> --remote --config wrangler.toml --command \
  "SELECT ts, station, json_extract(meta,'$.path') AS path, json_extract(meta,'$.stopsRemaining') AS stops, json_extract(meta,'$.hasEta') AS hasEta
   FROM trip_events WHERE token_hash = '<hash>' AND kind = 'la-push' ORDER BY ts"
```

(bare `wrangler d1 ...`는 `--config` 없이 쓰지 않는다 — CLAUDE.md #2698.)

## #2795 감시 쿼리 정의 — LA 침묵/덮어쓰기 회귀

**회귀 정의**: `lock=1` trip에서 연속한 두 `la-push` 사이 구간에 device `la-write` D2/D3(device가 LA content를 직접 쓴 경로)가 발생 = **0** 이어야 한다. 1건이라도 있으면 backend push가 device 쓰기로 덮였을 가능성이 있는 회귀다.

판정 절차:

1. D1: lock이 붙은 trip의 `token_hash` 선별 — `kind='lock-attached'` 행이 있는 `token_hash`.
2. D1: 그 trip의 `la-push` 타임라인 `[(ts_i, path_i)]`을 `ts` 순으로 얻는다. 같은 digest 연속은 기록되지 않으므로 **행 사이 간격 = "내용이 바뀌지 않은 구간"** 이다(침묵이 아니다 — `trip-end` 직전까지 마지막 digest가 유효).
3. device 덤프(`~/.claude/uploads/*.txt`)의 `la-write` D2/D3 타임스탬프를 같은 trip의 구간 `(ts_i, ts_{i+1})`에 대응시켜 개수를 센다.
4. 합격 = 구간 내 D2/D3 = 0. 이 대조는 라이드 없이 **기존 덤프 + D1 backfill**로 수행한다(CLAUDE.md "검증은 새 실기기 라이드에 의존하지 않는다").

해석 주의:
- `la-push` 0행은 "push가 없었다"와 "D1 미바인딩/기록 실패"를 구별하지 못한다 — 후자는 `D1-write-failure`(Sentry)로 보인다.
- 행 수 ≤ push 수(중복 digest 생략), ≥ advance 수(전진마다 digest가 바뀐다). 이 부등식이 깨지면 기록 지점 누락/중복 의심.
