import fs from 'fs';
import os from 'os';
import path from 'path';

import { findDewiredSignals } from '../findDewiredSignals';
import { SIGNAL_PROVENANCE_REGISTRY } from '../signalProvenanceRegistry';
import type { SignalProvenanceEntry } from '../signalProvenanceRegistry';

/**
 * #2250 (ADR-029 Phase 3) — de-wire 감지 fixture 테스트.
 *
 * red-first: 정의만 있고 호출자가 없는 emitter(de-wired)는 violation을 낸다(red 재현).
 * 정상(정의 + 호출자 존재)은 violation 없이 통과(green)한다.
 */
describe('findDewiredSignals — fixture 기반 de-wire 감지', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dewire-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const fullPath = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  it('정의만 있고 호출자가 없는 emitter는 violation(red)을 낸다 — de-wire 재현', () => {
    writeFile('lib/emitterDefOnly.ts', "export function deadEmitter() { return 1; }\n");

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'deadMetric',
        emitterSymbol: 'deadEmitter',
        emitterFile: 'lib/emitterDefOnly.ts',
        description: 'fixture — 은퇴한 채널',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot, scanDirs: ['lib'] });

    expect(violations).toEqual([
      {
        metricKey: 'deadMetric',
        emitterSymbol: 'deadEmitter',
        referenceCount: 1,
        reason: "emitter symbol 'deadEmitter'이 정의만 있고 호출자가 없다 — 은퇴한 채널을 measure 중",
      },
    ]);
  });

  it('registry에 등재된 emitter 심볼이 소스에 전혀 없으면 violation(red)을 낸다', () => {
    writeFile('lib/unrelated.ts', 'export const noop = 1;\n');

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'missingMetric',
        emitterSymbol: 'missingEmitter',
        emitterFile: 'lib/nope.ts',
        description: 'fixture — registry 오타/삭제',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot, scanDirs: ['lib'] });

    expect(violations).toEqual([
      {
        metricKey: 'missingMetric',
        emitterSymbol: 'missingEmitter',
        referenceCount: 0,
        reason: "emitter symbol 'missingEmitter'을 소스에서 찾을 수 없다 (registry 오타 또는 삭제됨)",
      },
    ]);
  });

  it('정의 + 호출자가 존재하면 violation 없이 통과한다 (green)', () => {
    writeFile('lib/live.ts', 'export function liveEmitter() { return 2; }\n');
    writeFile(
      'lib/caller.ts',
      "import { liveEmitter } from './live';\nliveEmitter();\n",
    );
    // 하위 디렉토리도 재귀적으로 스캔되는지 검증
    writeFile('lib/nested/deep.ts', "liveEmitter();\n");

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'liveMetric',
        emitterSymbol: 'liveEmitter',
        emitterFile: 'lib/live.ts',
        description: 'fixture — 정상 배선',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot, scanDirs: ['lib'] });

    expect(violations).toEqual([]);
  });

  it('__tests__ / node_modules / coverage 디렉토리와 .test./.spec. 파일은 스캔에서 제외한다', () => {
    // liveEmitter의 유일한 "호출"이 제외 대상 안에만 있으면 여전히 de-wire(red)여야 한다.
    writeFile('lib/live.ts', 'export function liveEmitter() { return 2; }\n');
    writeFile('lib/__tests__/shouldSkip.ts', 'liveEmitter(); liveEmitter();\n');
    writeFile('lib/node_modules/pkg/shouldSkip.ts', 'liveEmitter();\n');
    writeFile('lib/coverage/shouldSkip.ts', 'liveEmitter();\n');
    writeFile('lib/caller.test.ts', 'liveEmitter();\n');
    writeFile('lib/caller.spec.ts', 'liveEmitter();\n');
    writeFile('lib/notes.md', 'liveEmitter liveEmitter liveEmitter\n');

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'liveMetric',
        emitterSymbol: 'liveEmitter',
        emitterFile: 'lib/live.ts',
        description: 'fixture — 제외 디렉토리/확장자 검증',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot, scanDirs: ['lib'] });

    expect(violations).toEqual([
      {
        metricKey: 'liveMetric',
        emitterSymbol: 'liveEmitter',
        referenceCount: 1,
        reason: "emitter symbol 'liveEmitter'이 정의만 있고 호출자가 없다 — 은퇴한 채널을 measure 중",
      },
    ]);
  });

  it('registry 정의 파일(signalProvenanceRegistry.ts) 자체의 언급은 참조로 카운트하지 않는다 — 자기참조 마스킹 방지', () => {
    // 실제 사고 재현: registry 파일이 emitterSymbol을 설명 문구에 언급하면(예: "stampSent로 …")
    // 그 언급 자체가 "호출자 있음"으로 오카운트돼 de-wire를 못 잡는 구멍이 생긴다.
    // 호출부(caller.ts)를 제거해 진짜 de-wire 상태를 만들고, registry 파일의 언급만으로는
    // 여전히 violation이 나야 한다(정의 1 + registry 언급 1 ≠ green).
    writeFile('lib/emitterDefOnly.ts', 'export function deadEmitter() { return 1; }\n');
    writeFile(
      'lib/signalProvenanceRegistry.ts',
      "export const REGISTRY = [{ emitterSymbol: 'deadEmitter', description: 'deadEmitter로 무언가를 한다' }];\n",
    );

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'deadMetric',
        emitterSymbol: 'deadEmitter',
        emitterFile: 'lib/emitterDefOnly.ts',
        description: 'fixture — registry 자기참조 마스킹 방지 검증',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot, scanDirs: ['lib'] });

    expect(violations).toEqual([
      {
        metricKey: 'deadMetric',
        emitterSymbol: 'deadEmitter',
        referenceCount: 1,
        reason: "emitter symbol 'deadEmitter'이 정의만 있고 호출자가 없다 — 은퇴한 채널을 measure 중",
      },
    ]);
  });

  it('scanDirs 미지정 시 기본값(src, backend/alarm-worker/src)을 사용하고 존재하지 않는 디렉토리는 무시한다', () => {
    writeFile('src/live.ts', 'export function liveEmitter() { return 2; }\nliveEmitter();\n');
    // backend/alarm-worker/src 는 fixture에 생성하지 않음 — 존재하지 않는 dir graceful skip 검증.

    const registry: readonly SignalProvenanceEntry[] = [
      {
        metricKey: 'liveMetric',
        emitterSymbol: 'liveEmitter',
        emitterFile: 'src/live.ts',
        description: 'fixture — 기본 scanDirs 검증',
      },
    ];

    const violations = findDewiredSignals(registry, { repoRoot: fixtureRoot });

    expect(violations).toEqual([]);
  });
});

describe('findDewiredSignals — 실제 SIGNAL_PROVENANCE_REGISTRY (통합 green 검증)', () => {
  it('현재 등재된 지표는 모두 배선돼 있다 (violation 0) — repoRoot 기본값 사용', () => {
    const violations = findDewiredSignals(SIGNAL_PROVENANCE_REGISTRY);

    expect(violations).toEqual([]);
  });
});
