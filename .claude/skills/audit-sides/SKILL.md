---
name: audit-sides
description: fix 배치의 단방향(편측) 여부 교차추적 감사. fix가 한 경로/방향/레이어에만 적용되고 형제 경로가 미보호로 남았는지 file:line로 전수 판정. '단방향 감사', '양방향 체크', 'audit sides', fix 머지 전후, "이 fix 편측인지 봐줘" 요청 시 트리거. CLAUDE.md 룰에 따라 fix 배치 완료 시 필수 실행.
---

# 단방향(편측) 감사 — audit-sides

**목적**: "part green ≠ whole" 재발 차단. 실제 사고 계보: #2806이 update-only 가드를 한 분기에만 적용("이 분기는 건드리지 않는다" 주석) → 나머지 분기가 9/30 LA 사망 root. 2026-09-30 첫 실전 감사에서 당일 fix 4개 중 2개가 실질 편측으로 판정됨(#2842 GPS 9단 미배선, #2843 BG LA/위젯 미커버).

## 절차

1. **스코프 수집**: 감사 대상 fix 목록(오늘 머지/머지 대기 PR 번호 + 각 fix의 choke point file:line). `git log origin/dev --oneline`과 `gh pr list`로 확정.
2. **read-only 감사 에이전트 spawn** (Explore, sonnet, very thorough) — 아래 축 체크리스트와 산출물 형식을 프롬프트에 포함, fix별 choke point를 명시해 전달.
3. 결과를 심각도순으로 사용자에게 보고 + 처분(§처분 룰).

## 형제-경로 열거 축 (에이전트 프롬프트에 반드시 포함)

각 fix에 대해 다음 축으로 형제를 **전수 열거**하고 각각 판정:

- **경로**: 같은 신호/행위의 다른 발사·소비 경로 — 공유 본체를 안 타는 자체 구현(예: GPS 9단의 자체 sendBoardingPromptPush), 다른 caller, retry/pending 큐 재진입.
- **방향(역방향)**: 생성↔소멸(start↔end), 쓰기↔읽기, 등록↔해제, 승격↔강등. fix가 한 방향만 막았으면 반대 방향 오발동 감사(예: LA start 가드 후 end 오발동).
- **레이어**: backend ↔ device(JS) ↔ native(Swift) ↔ widget. 특히 Swift는 CI 테스트 부재 — MIRROR 사본·계약 drift.
- **상태 매트릭스**: FG/BG(headless 모듈상태 비공유) · lock/lockless · 지상/지하(arvlCd null) · archFlag on/off · 권한(WhileInUse/Always).
- **시간축**: 트립 시작/중간/**꼬리**(마지막 1-hop은 임계값 우회 상습 — 성수-stuck 계보) / 환승 경계.

## 판정 형식 (추측 금지)

`경로 | 커버됨(어디서 file:line) / 미커버(발동조건+사용자-가시 영향 1줄) / 해당없음(근거)` — 매트릭스 + **편측 최종 리스트 심각도순**. "커버됨" 판정은 실제 가드/테스트 file:line을 대야 하며, 못 대면 "미커버(미확인)".

## 처분 룰 (이슈 남발 금지)

- **머지 전 PR이 편측** → 같은 PR에서 확장 완결(담당 agent SendMessage로 속행)이 1순위.
- **별개 root** → 기존 이슈 검색·매핑 우선, 없을 때만 1개 생성 + **즉시 실행**(방치 금지).
- **무해 편측**(더 엄격한 구게이트가 커버 등) → `docs/agents/invariants.md`에 기록만.
- 형제 경로에 load-bearing 미강제 불변식 발견 시 → invariants 승격 룰 적용(fix PR에 테스트 동봉).

## 한계 (정직)

코드 도달가능성 기반 정적 감사다 — 런타임 빈도(어느 경로가 실제로 발사되는지)는 D1/덤프 소급으로 별도 확인. mock 기반 "커버됨"은 mock↔runtime 괴리를 못 본다(native/분산계는 device verify·배포 후 관측이 잔여 층).
