# Research Docs

코드 변경 없이 사전 조사 결과를 정착해두는 위치. 각 문서는 원본 GitHub 이슈 본문을 그대로 옮기고, frontmatter로 출처 이슈 번호를 보존한다.

## 인덱스

| 문서 | 이슈 | 주제 |
| --- | --- | --- |
| [447-coldstart-gps-policy.md](./447-coldstart-gps-policy.md) | #447 | 콜드스타트/저정확도 GPS 신뢰 정책 audit + risk 분석 + sub-issue 후보 |
| [1098-data-go-kr-api-catalog.md](./1098-data-go-kr-api-catalog.md) | #1098 | data.go.kr / KRIC 지하철 API 카탈로그 + 우선순위 + sub-epic 추천 |
| [563-region-monitoring-poc.md](./563-region-monitoring-poc.md) | #563 | iOS Region Monitoring(geofence) WhileInUse + BG wake 검증 — 결론: Always 강제로 폐기 |
| [494-geofence-bg-rejection.md](./494-geofence-bg-rejection.md) | #494 | Geofence/Region monitoring feat 이슈 폐기 결정 (#563 follow-up) + 대안(silent push + #918) 명시 |
| [1091-운행-차질-안내.md](./1091-운행-차질-안내.md) | #1091 | 운행 차질(사고/지연/무정차) 안내 API(15144070) 조사 + 구현 epic 후보 |
| [1092-exit-side-collection.md](./1092-exit-side-collection.md) | #1092 | exitSide(좌/우 문) 데이터 수집 전략 — 공공 API에 없음, 수동 수집 추천 |
| [583-silent-push-audit.md](./583-silent-push-audit.md) | #583 | Silent push 디바이스 미도달 audit — apnsEnv host 분기 / self-heal / payload 정상 확인 |

## 작성 규칙

- 파일명: `<이슈번호>-<slug>.md`
- frontmatter 필수: `issue`, `title`, `created`
- 본문은 이슈 본문 그대로 보존 (편집은 별도 PR)
- 후속 구현 epic은 별도 GitHub Issue로 분리
