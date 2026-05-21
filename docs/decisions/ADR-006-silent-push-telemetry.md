# ADR-006: silent push 게이트 outcome 텔레메트리 + privacy 정책

- 상태: Accepted
- 일자: 2026-05-22
- 관련 이슈: #498 (인프라), #499 (의사결정), #495 (임계값 튜닝), #496 (백엔드 progress)

## 컨텍스트

#478 PR1-2(PR #489)에서 silent push 수신 시 클라가 위치 게이트로 발사를 차단할 수 있게 됐다. 게이트 결과는 `src/utils/alarmLog.ts` ring buffer(200 entries)에 남지만 디바이스 로컬에 머물러 운영자가 집계할 수 없다.

#495(임계값 튜닝)와 #496(백엔드 progress 활성화 여부) 결정에 다음 두 지표가 필요하다.

- 정지 사용자 비율 = `silent-push-skipped` / `silent-push-received`
- 백엔드 발사 → 클라 차단 비율 = sum(skipped) / 백엔드 `ScheduledStats.pushed`

## 결정

클라가 30분 주기로 alarmLog의 `silent-push-*` 카운트를 누적해 `POST /telemetry/silent-push`로 백엔드에 올린다. 백엔드는 Cloudflare Analytics Engine(`silent_push_telemetry` dataset)에 카운터별 data point로 적재해 SQL로 일별 집계할 수 있게 한다.

- 트리거: 마운트 / 30분 주기 / AppState 'active' 진입
- 실패 시: graceful skip + `TELEMETRY_LAST_FLUSH_KEY` 미갱신 → 다음 flush 재시도
- 동작 변경 없음: 임계값/게이트 정책은 #495에서 데이터 본 뒤 결정

## Privacy 정책

본 텔레메트리는 다음 원칙을 따른다.

1. **카운트만 전송한다.** 개별 push 내용·시각·위치 좌표·역 이름은 payload에 포함하지 않는다. 모든 필드는 자연수 카운터.
2. **APNs token은 8자 prefix만 백엔드에 영구 저장한다.** 전체 token은 적재되지 않으며 anonymous aggregate (sampling key) 용도로만 사용된다. 로그에도 동일 prefix만 남긴다.
3. **사용자가 push 권한을 거부하면 token이 없어 flush가 skip되고 데이터는 0건 수집된다.** opt-out 경로가 자연스럽게 보장된다.
4. **Trip 존재 여부는 검증하지 않는다.** 만료된 trip 사용자의 텔레메트리도 보존해 데이터 완전성을 우선한다. 이는 위 1~2번 원칙 하에서 추가 PII를 노출하지 않는다.

## Limitations (알려진 손실)

- **Ring buffer 압박 시 silent loss**: 클라 alarmLog는 200 entries FIFO ring buffer. 한 flush 주기(30분) 동안 silent push가 200건을 초과하는 비정상 트래픽에선 오래된 entry가 trim되어 카운터가 누락된다. 정상 운영(주기당 수 건~수십 건)에선 발생하지 않는다.
- **R-M-W 비원자성**: flush는 `since` 읽기 → upload → `since` 쓰기. 동시 호출은 모듈 스코프 in-flight guard로 직렬화한다.

## 후속

#498 머지 후 1-2주 운영 데이터를 모으는 #499에서 분포 표를 산출해 #495·#496의 결정을 확정한다.
