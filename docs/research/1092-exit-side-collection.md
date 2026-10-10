---
issue: #1092
title: exitSide 데이터 수집 전략 조사 결과
created: 2026-06-11
---

## 배경

좌/우 문(exitSide) 안내 기능은 코드·i18n 모두 준비되어 있으나 데이터 소스 부재로 미작동. 본 문서는 데이터 출처 조사 결과와 수집 전략을 정리한다.

## 현재 코드 상태

- 타입: `src/shared/types/exitSide.ts` — `ExitSide = 'left' | 'right' | 'both'`, `TravelDirection = 'up' | 'down'`, `ExitSideMap = Record<string, { up?, down? }>`
- 조회: `src/features/route/utils/exitSide.ts` — `lookupExitSide(stationName, direction)` → 원본명 → 정규화명 순으로 매칭, 없으면 `null` 반환 (graceful fallback)
- 데이터: `src/data/exitSide.json` = `{}` (빈 객체)
- 소비처:
  - `src/features/alarm/utils/stationNotification.ts:165-178` — 알람 본문 suffix로 `alarms.exitSideLeft/Right/Both` 합성
  - `backend/alarm-worker/src/alertContent.ts:20` — 백엔드는 GPS 없어 의도적으로 생략
- 결론: **데이터만 채우면 즉시 기능 활성화**. 개발 작업 0.

## 데이터 출처 조사

### 1) 공공 API — 직접 매칭 없음
- **공공데이터포털 `서울교통공사_빠른하차정보` (15143840)** — 칸/문 번호 + 연결 이동설비 위치만 제공. **좌우(left/right) 필드 부재** (페이지 설명 + 빠른하차 = 이미 우리 `quickExit.json`으로 사용 중)
- **서울 열린데이터광장** — 승하차 인원/시간표/역 좌표 중심. 도어 방향 데이터셋 없음
- **레일포털(KRIC)**, TOPIS — 운행/혼잡도 중심. 도어 방향 없음
- 결론: **국내 공식 공개 데이터에 exitSide 필드는 존재하지 않음**

### 2) 차내 안내 / 3rd party
- 차내 LCD에 "내리실 문은 왼쪽/오른쪽" 표시되지만 데이터 배포는 없음
- 카카오지하철 등 상용 앱은 자체 큐레이션 데이터 보유 추정 — 라이선스/접근 불가

### 3) 수동 수집
- 528개 역 × 노선당 2방향(up/down) = 약 1100~1300 엔트리 (단일 노선역은 1세트, 환승역은 노선별 N세트)
- 작업량: 일 100엔트리 × 2주 = MVP 완성 가능. 출처: 차내 LCD 영상/이미지, 역 도면(서울교통공사 IR/시설), 위키 노선도, 실측
- 검증: 알람 fired log에 `exitSide` 표기 + 사용자 신고 버튼

### 4) 사용자 contribution
- 알람 직후 "내린 방향이 맞았나요? (좌/우/모름)" 1탭 피드백
- 첫 N건은 데이터 부재 → 신고로 매핑 학습. cold start 문제
- 권한·UX 비용 큼

### 5) 휴리스틱 (비추)
- 환승역 다른 노선 위치 기반 추정 → 정확도 50% 안팎. 잘못된 안내는 신뢰 훼손

## 추천 단계적 접근

1. **Phase 1 (즉시)** — 노선별 **종점 직전 역 + 환승역** 우선 수집 (체감 효용 가장 큼, 약 100~150 엔트리). 자체 수동 입력
2. **Phase 2** — 잔여 단일노선역을 노선당 일괄 수집 (방향이 같은 경우 다수). 약 2주 작업
3. **Phase 3** — 알람 사후 1탭 피드백으로 수정·보강. 백엔드 KV에 anonymized 집계
4. 데이터 포맷은 현행 `ExitSideMap` 그대로. 노선별 분기는 stationName 키에 노선 suffix가 필요한지 별도 검토 필요 (현재 키가 stationName only — 환승역에서 노선별 좌우가 다른 경우 스키마 확장 필요. 조사 후속 작업)

## TODO

- [ ] 스키마 검토: 환승역에서 노선마다 좌우가 다를 수 있는가? `ExitSideMap` 키에 lineId 포함하도록 확장 필요 검토
- [ ] Phase 1 수집 대상 역 리스트 산출 (종점 직전 + 환승역)
- [ ] 수집 작업 issue 분리 (chore: exitSide Phase 1 data entry)
- [ ] 사용자 피드백 UX 설계 (Phase 3)

## 참고

- `docs/requirements/05-realtime-progress.md:19,47,55-56` — 이미 미수집 상태로 기록
- 공공데이터포털 빠른하차정보: https://www.data.go.kr/data/15143840/openapi.do
