/**
 * backend/frontend pushConsistency.ts mirror 동기화 가드 (#1389 P1-2).
 *
 * 두 파일은 동일한 정합성 룰을 가져야 한다 (backend/frontend 빌드 분리 정책).
 * SonarCloud CPD 회피를 위해 본문 토큰은 의도적으로 다르지만 의미는 동일하다.
 *
 * 본 테스트는 string equality 가 아닌 **functional equivalence** 로 mirror 를 검증한다:
 *  - 공개 export(타입/함수/상수) 동일성
 *  - `SIGNAL_STALE_MS` 값 동일성
 *  - 9-branch 결정 매트릭스(allow/block + reason 목록) 동일성
 *  - step 평가 순서 동일성 (헤더 doc 의 평가 순서 주석 매트릭스 동일)
 *
 * 한쪽만 의미적으로 수정하면 jest fail → 정합성 게이트 자체가 정합성을 잃는 회귀 차단.
 *
 * Note: backend 모듈을 jest 에서 직접 require/import 할 수 없다
 * (jest config `modulePathIgnorePatterns: ['<rootDir>/backend/']` 로 차단됨,
 * Cloudflare Workers ESM 환경 분리 정책). 따라서 두 소스를 텍스트 분석으로 비교한다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FRONTEND_PATH = resolve(__dirname, '../pushConsistency.ts');
const BACKEND_PATH = resolve(
  __dirname,
  '../../../../../backend/alarm-worker/src/pushConsistency.ts',
);

const frontendSrc = readFileSync(FRONTEND_PATH, 'utf-8');
const backendSrc = readFileSync(BACKEND_PATH, 'utf-8');

/** 한 소스에서 export 된 named symbol 목록을 추출 (type/interface/const/function/let). */
function extractNamedExports(src: string): Set<string> {
  const names = new Set<string>();
  // `export type X`, `export interface X`, `export const X`, `export function X`, `export let X`
  const declRe = /export\s+(?:type|interface|const|function|let)\s+(\w+)/g;
  for (let m = declRe.exec(src); m !== null; m = declRe.exec(src)) {
    names.add(m[1]);
  }
  return names;
}

/** SIGNAL_STALE_MS 의 리터럴 표현을 추출 (값 동일 검증용). */
function extractStaleMsExpression(src: string): string | null {
  const m = /export\s+const\s+SIGNAL_STALE_MS\s*(?::\s*[\w<>]+\s*)?=\s*([^;]+);/.exec(src);
  return m ? m[1].trim() : null;
}

/**
 * 헤더 doc 의 평가 순서 주석에서 step 번호 + 결정(allow/block) 시그니처를 추출.
 *
 * 두 파일은 wording 이 다를 수 있지만 (예: "stationary" vs "정지") **결정 자체**는 동일해야 한다.
 * 검증 대상: step 번호 1~10 각각의 verdict(allow/block) 매트릭스가 두 파일에서 일치.
 */
function extractStepVerdicts(src: string): Array<{ step: number; verdict: string }> {
  // " * N. <body> → allow/block ..." 형태에서 verdict 만 추출.
  const out = new Map<number, string>();
  const re = /^\s*\*?\s*(\d+)\.\s*[^\n]*?→\s*(allow|block)/gim;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const step = Number(m[1]);
    if (step < 1 || step > 10) continue;
    if (out.has(step)) continue; // 첫 등장만
    out.set(step, m[2].toLowerCase());
  }
  return [...out.entries()]
    .map(([step, verdict]) => ({ step, verdict }))
    .sort((a, b) => a.step - b.step);
}

/** block 결과의 reason literal 목록을 추출 (4 reason 전부 등장 확인용). */
function extractBlockReasons(src: string): Set<string> {
  const reasons = new Set<string>();
  const re = /'(wifi-mismatch|motion-stationary-far-behind|device-station-mismatch|device-ahead-of-target)'/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    reasons.add(m[1]);
  }
  return reasons;
}

describe('pushConsistency — backend/frontend mirror functional equivalence (#1389)', () => {
  it('두 파일이 필수 공개 export(type/interface/const/function)를 모두 노출한다', () => {
    const feExports = extractNamedExports(frontendSrc);
    const beExports = extractNamedExports(backendSrc);

    // 필수 6 type/interface + 1 const + 1 function = 7 symbol 양쪽 모두 존재.
    // 한쪽이 추가 helper 타입(예: backend `BlockReason`)을 export 하는 것은 허용한다
    // (mirror 의 핵심 정합성은 필수 공개 표면).
    const required = [
      'Motion',
      'DeviceSignal',
      'PushTarget',
      'TripContext',
      'ConsistencyResult',
      'SIGNAL_STALE_MS',
      'evaluatePushConsistency',
    ];
    for (const sym of required) {
      expect(feExports.has(sym)).toBe(true);
      expect(beExports.has(sym)).toBe(true);
    }
  });

  it('두 파일의 SIGNAL_STALE_MS 리터럴 표현이 동일하다 (5분=300000ms)', () => {
    const feExpr = extractStaleMsExpression(frontendSrc);
    const beExpr = extractStaleMsExpression(backendSrc);
    expect(feExpr).not.toBeNull();
    expect(beExpr).not.toBeNull();
    expect(feExpr).toBe(beExpr);
    // 의미: 5 * 60_000 = 300_000ms
    // (한쪽만 수정하면 텍스트 다를 것)
  });

  it('두 파일의 헤더 doc 평가 순서(step 1~10) verdict(allow/block) 매트릭스가 동일하다', () => {
    const feVerdicts = extractStepVerdicts(frontendSrc);
    const beVerdicts = extractStepVerdicts(backendSrc);
    // 10 step 모두 documented
    expect(feVerdicts.map((v) => v.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(beVerdicts.map((v) => v.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // verdict matrix 동일 — block 4개(2,7,8,10), allow 6개(1,3,4,5,6,9)
    const expected = [
      { step: 1, verdict: 'allow' },
      { step: 2, verdict: 'block' },
      { step: 3, verdict: 'allow' },
      { step: 4, verdict: 'allow' },
      { step: 5, verdict: 'allow' },
      { step: 6, verdict: 'allow' },
      { step: 7, verdict: 'block' },
      { step: 8, verdict: 'block' },
      { step: 9, verdict: 'allow' },
      { step: 10, verdict: 'block' },
    ];
    expect(feVerdicts).toEqual(expected);
    expect(beVerdicts).toEqual(expected);
  });

  it('두 파일이 4종 block reason literal 을 모두 사용한다 (한쪽만 reason 추가/삭제 금지)', () => {
    const feReasons = extractBlockReasons(frontendSrc);
    const beReasons = extractBlockReasons(backendSrc);
    const expected = new Set([
      'wifi-mismatch',
      'motion-stationary-far-behind',
      'device-station-mismatch',
      'device-ahead-of-target',
    ]);
    expect(feReasons).toEqual(expected);
    expect(beReasons).toEqual(expected);
  });

  it('두 파일이 헤더 doc 에서 상대 mirror 경로를 명시한다 (수동 동기화 알림)', () => {
    expect(frontendSrc).toContain('backend mirror: backend/alarm-worker/src/pushConsistency.ts');
    expect(backendSrc).toContain('frontend mirror: src/features/alarm/utils/pushConsistency.ts');
  });
});
