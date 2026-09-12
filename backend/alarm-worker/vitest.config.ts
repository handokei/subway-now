import { defineConfig } from 'vitest/config';

// #2081 — coverage ratchet 게이트.
// 100% 강제가 아니라 "현재 실측값" 기준 floor. 기존 미커버 코드로 인한
// 일괄 실패를 막으면서, 신규 코드가 커버리지를 깎아먹는 회귀는 차단한다.
// 실측 기준선 (2026-07-29): stmts 97.16 / branch 96.31 / funcs 99.36 / lines 97.16
// threshold는 실측치보다 낮은 정수로 내림해 소수점 노이즈로 인한 flaky fail을 방지.
// funcs 99→98 (2026-07-30, PR #2085): CI(Node 20)의 V8 계측이 로컬(Node 25)보다 낮게 측정
// (recallAlerts.ts funcs CI 90.9% vs 로컬 100%, diff 무관 파일). floor는 CI 환경 실측 기준.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 97,
        branches: 96,
        functions: 98,
        lines: 97,
      },
    },
  },
});
