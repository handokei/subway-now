# Gold Standard Trip Fixture (#1580)

Phase 0 epic #1576의 핵심 ground truth. V/X acceptance의 self-referential 문제 해결.

## 무엇을 추가하는가

`tests/fixtures/trip-ground-truth-{YYYY-MM-DD}-{seq}.json` 형식으로 사용자가 직접 annotation한 trip을 commit한다.

- `trip-ground-truth.template.json` — 빈 template. 복사해서 수정한다.
- `trip-ground-truth.schema.ts` — TypeScript type + validator. CI가 강제.

## Trip 5건 선정 가이드

| # | trip 종류 | 검증 대상 |
|---|----------|----------|
| 1 | 출근 (직선, 환승 X) | V2/V4 단순 case ground truth |
| 2 | 출근 환승 1회 | V2 (transfer alarm) + 환승 시점 정확도 |
| 3 | 퇴근 (직선) | 양방향 검증 |
| 4 | 주말 장거리 (환승 2회+) | 복잡 case + hop ≤ 1정거장 |
| 5 | 지하 전용 trip | V7 underground SSoT advance 비율 |

## Annotation 절차

1. 지하철 탑승 직전 시계 노출 + 음성/메모 시작 (출발역 도착 시각 기록).
2. 매 역 도착/출발 시각 메모.
3. 환승 시 이전 노선 마지막 역 도착 시각 + 새 노선 열차 출발 시각.
4. 최종 도착역 도착 시각.
5. 귀가 후 `trip-ground-truth.template.json`을 복사하여 채운다.
6. ISO 8601 (`YYYY-MM-DDTHH:mm:ss+09:00`) 형식. KST timezone 권장.

## Acceptance test runner

`tests/acceptance/__tests__/*.test.ts`가 본 디렉토리의 모든 `trip-ground-truth-*.json`을 glob으로 자동 로드한다.

- fixture 0건이면 silently skip (P0-3 R2 archive 진행 중인 동안).
- 1건이라도 있으면 모든 fixture에 대해 V2/V3/V4/X3/X6 acceptance 검증.
- `trip-ground-truth-{date}-{seq}.r2.ndjson`이 옆에 있으면 archive 비교까지 수행. 없으면 schema/관계만 검증.

## CI hook

`npm test`가 acceptance suite를 자동 실행한다 (Wire-completion 5단 룰).

- schema 위반 → CI fail
- archive 비교 실패 → CI fail (fixture가 device 측정과 어긋남 = 회귀)
- fixture 0건 → CI pass (warning만)

## 본 PR 범위

- 인프라(schema/validator/runner/CI hook)만 포함
- **사용자 trip 5건 annotation은 본 PR 머지 후 사용자 직접 commit으로 같은 issue #1580에서 진행**
