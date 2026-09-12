---
template: epic-1008-acceptance-result
source: tasks/epic-lockless-overfire-guard.md §7.1
filled-at: YYYY-MM-DD
filled-by: 운영자명
---

# Epic #1008 Acceptance — 회귀 7개 1주 측정 결과

> 이 파일은 템플릿 `epic-1008-acceptance-result.template.md`의 사본입니다.
> 실제 측정 종료 후 `epic-1008-acceptance-result.md`로 저장 + dev 머지로 정착하세요.

## 측정 환경

| 항목 | 값 |
|---|---|
| 측정 기간 (시작) | YYYY-MM-DD HH:MM KST |
| 측정 기간 (종료) | YYYY-MM-DD HH:MM KST |
| Production 빌드 | EAS production 번호 (예: 1.2.5 build 56) |
| 운영자 수 | N |
| 누적 trip 수 | M |
| 측정 도구 | DebugModal Share / wrangler tail / BFF telemetry |

## 회귀 7개 측정 결과

(회귀 정의: SSOT §7.1)

| # | 패턴 | sub-issue | 측정 발생 건수 | 0건 여부 | 비고 |
|---|---|---|---|---|---|
| 1 | hydrate 직후 station-passed warmup 우회 | #1010 | __ | ✅/❌ | |
| 2 | client lock acceptance 무검증 hydrate | #1014 | __ | ✅/❌ | |
| 3 | fusion forward-only 검증 누락 | #1015 | __ | ✅/❌ | |
| 4 | 지하/저정확도 GPS gate 3 hole | #1016 | __ | ✅/❌ | |
| 5 | trackTrainProgress source-level forward 가드 | #1017 | __ | ✅/❌ | |
| 6 | backend attemptAutoLock arvlCd=2 무조건 채택 | #1018 | __ | ✅/❌ | |
| 7 | motion warmup 부재 cold-start phase 우회 | #1013 | __ | ✅/❌ | |

## Risk monitor 결과 (R-1 ~ R-10)

(SSOT §5 기준)

| 리스크 | 측정 신호 | 결과 |
|---|---|---|
| R-6 | boardingPrompt 발사 빈도 (#1021) | __건 / 일 |
| R-8 | Cloudflare quota 도달률 (#1022) | __% |
| R-2/R-9 | backend down 발생 횟수 | __ |
| R-3 | lock 탭 round-trip 평균 | __ms |
| R-10 | fusion 신호 우선순위 모호 사고 | __건 |

## Acceptance 판정

- [ ] 7개 회귀 모두 0건 — Epic A close 가능
- [ ] 1+ 건 발생 — 회귀별 sub-issue 발행 (B14 = B 영역 follow-up)
- [ ] R-1~R-10 monitor 정상 작동

## 분석 노트 + 후속

- 발견된 새 회귀 (있다면): #__, #__
- 권장 후속 sub-issue: ...
- ADR-011 폐기/수정 필요사항: ...
