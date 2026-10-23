import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #3006 PR-3 — `putPending` production 호출부 0개 고정.
 *
 * `fallback.ts`의 implicit-ACK 읽기(`deviceContact`)는 putPending이 만든 pending entry가 있어야
 * 도달하는데, #3148(`27411a52`) 이후 production에서 putPending을 부르는 곳이 없어 그 경로는
 * 도달 불가다. 그래서 /position의 W2(`deviceContact:` put)를 제거했다. 누군가 putPending 호출부를
 * 되살리면 W2 제거의 전제가 깨지므로 이 테스트가 즉시 실패시킨다(되살리려면 W2 재도입을 함께 판단).
 */
const SRC_DIR = join(__dirname, '..');
const DEFINITION_FILE = join(SRC_DIR, 'pendingPushes.ts');
const CALL_OR_IMPORT = /\bputPending\s*\(|import\b[^;]*\bputPending\b/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const DEFINITION_LINE = /export\s+async\s+function\s+putPending\s*\(/;

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('putPending production 호출부 0 (#3006 PR-3)', () => {
  it('정의(export async function putPending) 외에 호출·import가 src 비테스트 코드에 없다', () => {
    const violations: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, idx) => {
        if (COMMENT_LINE.test(line)) return;
        if (!CALL_OR_IMPORT.test(line)) return;
        if (file === DEFINITION_FILE && DEFINITION_LINE.test(line)) return;
        violations.push(`${file.slice(SRC_DIR.length + 1)}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('가드가 실제로 잡는다 — 호출/import 패턴 샘플', () => {
    expect(CALL_OR_IMPORT.test('await putPending(kv, entry);')).toBe(true);
    expect(CALL_OR_IMPORT.test("import { putPending } from './pendingPushes';")).toBe(true);
    expect(CALL_OR_IMPORT.test('const x = 1;')).toBe(false);
  });
});
