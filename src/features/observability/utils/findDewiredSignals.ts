import fs from 'fs';
import path from 'path';

import type { SignalProvenanceEntry } from './signalProvenanceRegistry';

/**
 * de-wire 감지 스캐너 (#2250, ADR-029 Phase 3).
 *
 * `SIGNAL_PROVENANCE_REGISTRY`의 각 항목에 대해, 비-테스트 소스 트리에서 `emitterSymbol`이
 * "정의 외에 최소 1회 이상" 참조(호출/발사)되는지 검사한다. 정의만 있고 호출자가 0이면
 * 그 emitter는 은퇴한 채널이고, 그걸 measure하던 지표는 죽은 지표다 → violation.
 */
export interface DewireViolation {
  readonly metricKey: string;
  readonly emitterSymbol: string;
  readonly referenceCount: number;
  readonly reason: string;
}

export interface FindDewiredSignalsOptions {
  /** 스캔 루트 (기본: repo root — 이 파일 기준 4단계 상위) */
  readonly repoRoot?: string;
  /** repoRoot 기준 스캔 대상 디렉토리 목록 */
  readonly scanDirs?: readonly string[];
}

const DEFAULT_SCAN_DIRS = ['src', 'backend/alarm-worker/src'];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const EXCLUDED_DIR_NAMES = new Set(['__tests__', 'node_modules', 'coverage']);

// registry 정의 파일 자체는 스캔에서 제외한다. 그 파일은 emitterSymbol을 문자열/설명 산문으로
// "언급"할 뿐 실제로 호출/발사하지 않는데, 포함시키면 언급 자체가 참조로 카운트돼
// (정의 1 + registry 언급 1 = 2) de-wire를 절대 감지 못 하는 구멍이 생긴다.
const EXCLUDED_FILE_NAMES = new Set(['signalProvenanceRegistry.ts']);

function isTestFile(fileName: string): boolean {
  return /\.test\.tsx?$/.test(fileName) || /\.spec\.tsx?$/.test(fileName);
}

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const dirEntry of entries) {
    if (dirEntry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(dirEntry.name)) continue;
      files.push(...collectSourceFiles(path.join(dir, dirEntry.name)));
      continue;
    }

    if (!SOURCE_EXTENSIONS.has(path.extname(dirEntry.name))) continue;
    if (isTestFile(dirEntry.name)) continue;
    if (EXCLUDED_FILE_NAMES.has(dirEntry.name)) continue;

    files.push(path.join(dir, dirEntry.name));
  }

  return files;
}

/**
 * registry의 각 (지표 → emitter 심볼) 쌍이 비-테스트 코드에서 실제 참조되는지 검증한다.
 * 참조 count < 2 (정의 1회 + 호출 0회, 또는 완전히 미발견)이면 violation을 반환한다.
 */
export function findDewiredSignals(
  registry: readonly SignalProvenanceEntry[],
  options: FindDewiredSignalsOptions = {},
): DewireViolation[] {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '../../../../');
  const scanDirs = options.scanDirs ?? DEFAULT_SCAN_DIRS;

  const files = scanDirs.flatMap((scanDir) => collectSourceFiles(path.join(repoRoot, scanDir)));
  const contents = files.map((file) => fs.readFileSync(file, 'utf8'));

  const violations: DewireViolation[] = [];

  for (const entry of registry) {
    const symbolPattern = new RegExp(`\\b${entry.emitterSymbol}\\b`, 'g');
    const referenceCount = contents.reduce((total, content) => {
      const matches = content.match(symbolPattern);
      return total + (matches?.length ?? 0);
    }, 0);

    // 1회 미만: 정의조차 없음(등재 오타/삭제). 1회: 정의만 있고 호출자 없음(de-wire).
    // 둘 다 "이 지표가 measure하는 채널이 죽었다"는 동일 신호.
    if (referenceCount < 2) {
      violations.push({
        metricKey: entry.metricKey,
        emitterSymbol: entry.emitterSymbol,
        referenceCount,
        reason:
          referenceCount === 0
            ? `emitter symbol '${entry.emitterSymbol}'을 소스에서 찾을 수 없다 (registry 오타 또는 삭제됨)`
            : `emitter symbol '${entry.emitterSymbol}'이 정의만 있고 호출자가 없다 — 은퇴한 채널을 measure 중`,
      });
    }
  }

  return violations;
}
