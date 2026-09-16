# wrangler tail watchdog 운영 (#1453)

backend `alarm-worker`의 `wrangler tail` 스트림을 좀비 없이 유지하기 위한 운영 절차.

배경: `memory/lesson_wrangler_tail_wrapper_reliability.md`. 단순 `while true; do wrangler tail; sleep N; done` 루프는 wrangler 프로세스가 살아있는데 스트림만 죽는 "좀비"를 복구하지 못한다.

## 구성요소

| 파일 | 역할 |
| --- | --- |
| `scripts/tail-watchdog.sh` | wrangler tail 무한 spawn + mtime 기반 좀비 감지 + log rotation + max-restarts |
| `scripts/prune-wrangler-logs.sh` | `~/Library/Preferences/.wrangler/logs/` 7일 이상 자동 prune |
| `scripts/launchd/com.subway-now.wrangler-log-prune.plist` | 매일 03:00 KST에 prune 실행하는 LaunchAgent |

출력:
- `tasks/wrangler-tail-watchdog.jsonl` — tail 본 스트림 (10MB 도달 시 `.jsonl.<ts>`로 회전)
- `tasks/wrangler-tail-watchdog.err` — 재spawn / 좀비 kill / 회전 로그
- `tasks/wrangler-tail-watchdog.alert` — `MAX_RESTARTS` 초과 시 ALERT 한 줄 + 종료

## 일상 사용

```bash
# 새 trip 캡처 전에 watchdog 띄우기 (포그라운드)
scripts/tail-watchdog.sh trip-2026-06-18

# 백그라운드 (세션 종료 후에도 유지하려면 nohup + & 또는 tmux)
nohup scripts/tail-watchdog.sh trip-2026-06-18 \
  > tasks/tail-watchdog-stdout.log 2>&1 &

# 상태 점검 — jsonl mtime이 살아있는지
ls -la tasks/wrangler-tail-watchdog.jsonl
date; stat -f '%Sm' tasks/wrangler-tail-watchdog.jsonl

# 좀비 발생 흔적 (err 파일에 "stale" 라인이 누적되면 wrangler/네트워크 점검 필요)
grep stale tasks/wrangler-tail-watchdog.err | tail
```

## 튜닝

| 환경변수 | 기본 | 의미 |
| --- | --- | --- |
| `STALE_SECS` | 90 | jsonl mtime이 N초 stale이면 wrangler kill |
| `CHECK_INTERVAL` | 30 | watchdog poll 주기 |
| `MAX_BYTES` | 10485760 (10MB) | jsonl 회전 임계 |
| `MAX_RESTARTS` | 100 | 누적 spawn 상한 (초과 시 alert + 종료) |
| `RESPAWN_SLEEP` | 3 | EXIT → 재spawn 대기 |
| `OUT_DIR` | `tasks/` | 출력 디렉토리 |
| `TAIL_CMD` | wrangler tail | override (테스트 전용) |

## 로그 prune LaunchAgent 설치

```bash
# 1) plist 복사 (절대경로가 박혀있으니 워크트리가 아닌 메인 repo의 scripts/ 사용)
cp scripts/launchd/com.subway-now.wrangler-log-prune.plist \
   ~/Library/LaunchAgents/

# 2) load
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.subway-now.wrangler-log-prune.plist

# 3) 즉시 한 번 실행 (검증)
launchctl kickstart -k gui/$(id -u)/com.subway-now.wrangler-log-prune
cat tasks/launchd-prune-stdout.log
```

## 기존 `com.subway-now.scheduled-tail.plist` 제거

이 plist는 존재하지 않는 `scripts/scheduled-deploy-and-tail.sh`를 참조해 매일 08:00 KST에 실패만 로그로 남기던 좀비였다. #1453로 본 watchdog + prune 체계로 대체. 다음 명령으로 제거:

```bash
launchctl bootout gui/$(id -u)/com.subway-now.scheduled-tail 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.subway-now.scheduled-tail.plist
# 누적된 launchd 로그도 제거
rm -f tasks/launchd-stdout.log tasks/launchd-stderr.log
```

## Acceptance 자가 검증

- 6시간 watchdog 띄운 후 `tasks/wrangler-tail-watchdog.err`에 "stale" 라인이 발생해도 jsonl이 다시 자라기 시작했는가? (좀비 복구 성공)
- `tasks/wrangler-tail-watchdog.jsonl` 크기가 10MB를 넘긴 적이 있는가? (회전 정상)
- `~/Library/Preferences/.wrangler/logs/`가 LaunchAgent 설치 후 7일 분량으로 안정되는가? (prune 정상)

## 수동 검증 절차

```bash
# 좀비 시뮬레이션: 무한히 응답 없는 mock 명령으로 watchdog 띄움
STALE_SECS=5 CHECK_INTERVAL=2 \
  TAIL_CMD='sleep 600' \
  OUT_DIR=/tmp/wd-test \
  scripts/tail-watchdog.sh stale-test &
WD=$!
sleep 12
# err에 "killing wrangler tail" 라인이 찍혀야 함
grep stale /tmp/wd-test/wrangler-tail-watchdog.err
kill $WD
```

수동 검증 결과는 PR 본문에 evidence로 첨부.
