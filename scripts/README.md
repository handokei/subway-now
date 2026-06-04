# scripts/

이 디렉토리에는 backend/data/측정 워크플로우 보조 스크립트가 있다.

## measure:blocked-reasons — boarding-prompt 9단 게이트 분포 측정

`#854`. 실기기 trip 중 backend `boarding-prompt: gate blocked` 로그를 30분 캡처해
9단 AND 게이트 중 어느 단계에서 차단됐는지 분포를 집계한다.

### 사용 (1줄)

```bash
# 다음 trip 출발 직전에 실행. 30분 자동 종료. Ctrl+C로도 정상 종료.
npm run measure:blocked-reasons -- --token=35b3502c --duration=30m
```

- `--token=<8글자 prefix>`: 특정 trip 토큰만 필터 (생략 시 전체)
- `--duration=30m | 15m | 600s | 1h`: 캡처 길이
- `--output=path/file.jsonl`: 결과 jsonl 경로
- `--no-aggregate`: capture만, 집계 생략

결과:
- `tasks/blocked-reasons-<ts>-<label>.jsonl` — 필터된 blocked 이벤트 raw
- `tasks/blocked-reasons-<ts>-<label>.raw.jsonl` — wrangler tail 원본
- `tasks/blocked-reasons-<ts>-<label>.summary.md` — reason별 카운트 표 + 임계값 stamp

### 결과 해석

reason 분포에서 비중 1위가 다음 작업의 후보:

| reason | 의미 | 다음 작업 후보 |
| --- | --- | --- |
| `accuracy-too-poor` | 평균 accuracy ≥ 50m | 임계 완화 또는 위치 ingest 가중치 검토 |
| `window-too-small` | 60s 윈도우 sample < 3 | foreground 위치 폴링 cadence 점검 |
| `direction-mismatch` | cosine < 0.7 | 환승 leg 방향 데이터 정합 확인 |
| `origin-too-far` | 출발역 > 100m | BoardingLock 동기화 / 출발역 좌표 정합 |
| `speed-too-low` | fused speed < 5 km/h | fused speed weight 또는 Kalman 튜닝 |
| `motion-not-moving` | motion 불일치 | Core Motion 권한/캘리브레이션 |
| `silenced` / `already-fired` | 정상 운영 차단 | 행동 변경 불필요 |

`__unknown:<reason>`이 보이면 backend가 새 reason을 추가했지만 본 스크립트가 미반영 —
실제로는 `boardingPrompt.ts`에서 정규식으로 자동 추출하므로 backend 빌드 직후 재실행으로 해소.

### 신뢰성 메모

`wrangler tail`은 inactivity로 silent disconnect 될 수 있다 (lesson_wrangler_tail_wrapper_reliability).
스크립트 종료 시 raw tail line 수가 0이면 인증/접속/disconnect를 즉시 의심하라는 경고가
stderr에 출력된다. 0건이 정상이라고 결론짓기 전에 raw tail에 다른 이벤트가 있는지 확인.

### SSOT 정합

`scripts/aggregate-blocked-reasons.js`는 `backend/alarm-worker/src/boardingPrompt.ts`의
`GateSkipReason` union literals와 임계값 export 상수를 정규식으로 직접 추출한다 —
새 reason/임계값 추가 시 스크립트 수정 불필요 (CLAUDE.md 글로벌 룰 3).

## tail:capture — 일반 wrangler tail (#622)

`scripts/capture-tail.sh`. backend 전반 진단용 raw tail. boarding-prompt 특화 분석은
위 `measure:blocked-reasons`를 사용.
