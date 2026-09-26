# Plan #1860 — barometer-stop hint (옵션 C) — 이미 지하 사용자 보완

Issue: https://github.com/handokei/subway-now/issues/1860
Parent: #1845 (barometer threshold audit)
Status: implementation plan

---

## §1 문제 정의

"이미 지하" 사용자가 앱을 실행하면 30s warmup 동안 dP ≈ 0 이므로 `evaluateSubsurfaceEnter` 는 항상 `detected=false`.
결과: `inferEnvironment` → `subsurface=false + surfaceSSOT=false + undergroundSSOT=false` → `'unknown'`.

downstream 영향:
- `stickyStationGates.ts:72` — `tripActive && subsurface===true` 조건 미충족 → sticky lock 없음
- `undergroundSSOTConsensus` — subsurface vote 1표 없음
- `useNearestStation` — `FG_WATCH_OPTIONS_SUBSURFACE` 미선택 → GPS throttle 미적용

---

## §2 해결 방향 (옵션 C)

`inferEnvironment` 에 hint 분기 추가:
- 입력: `tripActive: boolean`, `barometerStop: boolean | undefined`
- 조건: `subsurface===false + surfaceSSOT=false + undergroundSSOT=false + tripActive=true + barometerStop=true`
- 결과: label `'unknown'` 유지 (false positive 방지) + `hintReason: 'barometer-stop'` 추가

`InferEnvironmentResult` 래퍼로 확장:
```typescript
export interface InferEnvironmentResult {
  label: Environment;
  hintReason?: 'barometer-stop';
}
```

backward-compat: 기존 caller `useFusedNearestStation.ts` 는 `.label` 로 접근.
`Environment` 타입은 유지 (기존 export 그대로).

---

## §3 변경 파일

1. `src/features/nearest-station/utils/inferEnvironment.ts` — 핵심 변경
2. `src/features/nearest-station/utils/__tests__/inferEnvironment.test.ts` — 커버리지 매트릭스
3. `src/features/nearest-station/hooks/useFusedNearestStation.ts` — caller 업데이트 + environmentHintReason 반환
4. `src/features/debug/components/DebugModal.tsx` — hintReason 노출 (V/X dashboard)
5. `src/features/debug/components/__tests__/DebugModal.test.tsx` — DebugModal 힌트 케이스

---

## §4 Wire-completion 5단 체크

1. **Orphan**: 신규 export `InferEnvironmentResult` — `useFusedNearestStation` 가 caller. `environmentHintReason` — DebugModal이 caller. `npm run lint:orphan` pass 확인.
2. **V/X dashboard**: DebugModal Fusion 섹션 "environment" 라인에 `hint:barometer-stop` 노출.
3. **의존 PR**: #1848 머지됨 — N/A.
4. **측정 plan**: Day 3+ trip DebugModal dump로 `hintReason='barometer-stop'` 발생 빈도 1주 측정.
5. **Device verify**: 실기기 "이미 지하" trip 1건 (사용자 책임).
