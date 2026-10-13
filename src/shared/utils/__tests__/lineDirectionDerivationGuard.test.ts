/**
 * #2949 C-3/C-4 — closed-loop 방향 재발 차단 가드.
 *
 * C-3: `shortestLinePathIndices`가 만든 경로의 `path[1]`(또는 그 변수명 `firstStepIdx`)을
 * idx와 다시 크기 비교해서 방향('up'/'down')을 재도출하는 패턴을 금지한다. 이 패턴이 바로
 * #2949 버그의 원인이다 — seam station(시청 idx=0, 충정로 idx=42)을 기준점으로 쓰면
 * wraparound 여부와 무관하게 비교 결과가 항상 같은 값으로 고정돼 방향이 오판된다.
 * 방향은 `travelDirectionSign`(`lineLoopPath.ts`)이 반환하는 부호로만 얻는다(#2949).
 *
 * C-4: closed-loop seam(`isClosedLoopMainStation`/`travelDirectionSign`, `lineLoopPath.ts`)을
 * import하는 새 파일이 화이트리스트 밖에서 생기면 CI가 차단한다 — closed-loop 방향을 판정하려면
 * 반드시 이 두 symbol을 거쳐야 하므로, import 파일 목록이 곧 "closed-loop 방향을 다루는 코드
 * 전체"의 정확한 집합이다. 새 호출자를 추가하려면 이 가드 파일의 화이트리스트도 함께 수정해야
 * 하므로 자동으로 리뷰 대상이 된다(`backend/alarm-worker/src/__tests__/noRawSqlGuard.test.ts` 패턴).
 * 함수명 매칭(예: `/Direction/`)은 쓰지 않는다 — `filterArrivalsByDirection`/`resolveAlarmDirection`
 * 같은 기존의 무관한 "Direction" 함수를 false-positive로 잡기 때문이다.
 *
 * 스캔 전 주석(`/* ... *\/`, `//`)을 제거한다 — 설명 주석에 과거 버그 패턴을 인용한 문장
 * (예: `boardingPromptContext.ts`가 `firstStepIdx > fromIdx` 비교를 역사적으로 언급)이
 * false-positive로 걸리지 않게 한다.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'backend', 'alarm-worker', 'src')];

/**
 * 방향 재도출 금지 패턴 — `path[1]`/`firstStepIdx`를 idx와 다시 크기 비교하는 코드.
 * 비교 연산자(`<`/`>`/`<=`/`>=`)와 함께 쓰일 때만 위험하다 — `lineStations[path[1]].name`처럼
 * "다음 역 조회" 용도(`stationRoute.ts`, 방향 판정 아님)는 매칭하지 않는다.
 */
const FORBIDDEN_DIRECTION_RECOMPUTE_PATTERN = /\bfirstStepIdx\b|path\s*\[\s*1\s*\]\s*[<>]=?/;

/**
 * closed-loop seam symbol(`isClosedLoopMainStation`/`travelDirectionSign`)을 import할 수 있는
 * 파일 화이트리스트 (#2949 C-4). 새 호출자가 필요하면 이 목록에 추가 — 그 행위 자체가 리뷰에서
 * "closed-loop 방향 판정이 왜 새로 생기는가"를 드러나게 한다.
 */
const ALLOWED_CLOSED_LOOP_IMPORTERS = new Set([
  join(REPO_ROOT, 'src', 'shared', 'utils', 'lineLoopPath.ts'), // 단일 primitive 구현체 — #2949 C-1
  join(REPO_ROOT, 'src', 'shared', 'utils', 'stationRoute.ts'), // 경로/다음역 조회(방향 판정 아님, 기존)
  join(REPO_ROOT, 'src', 'features', 'route', 'utils', 'tripDirection.ts'),
  join(REPO_ROOT, 'src', 'features', 'route', 'utils', 'directionOnLine.ts'),
  join(REPO_ROOT, 'backend', 'alarm-worker', 'src', 'legDirection.ts'),
]);

const CLOSED_LOOP_IMPORT_PATTERN = /\b(isClosedLoopMainStation|travelDirectionSign)\b/;

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, ''); // line comments
}

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...listTsFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function isTestFile(file: string): boolean {
  return file.includes(`${join('__tests__', '')}`) || file.endsWith('.test.ts');
}

describe('closed-loop 방향 재발 차단 가드 (#2949 C-3/C-4)', () => {
  it('C-3: path[1]/firstStepIdx를 idx와 다시 크기 비교하는 코드가 없다', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (isTestFile(file)) continue;
        const code = stripComments(readFileSync(file, 'utf-8'));
        if (FORBIDDEN_DIRECTION_RECOMPUTE_PATTERN.test(code)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('C-4: closed-loop seam symbol을 import하는 파일이 화이트리스트 밖에 없다', () => {
    const violations: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        if (isTestFile(file)) continue;
        if (ALLOWED_CLOSED_LOOP_IMPORTERS.has(file)) continue;
        const code = stripComments(readFileSync(file, 'utf-8'));
        if (CLOSED_LOOP_IMPORT_PATTERN.test(code)) {
          violations.push(`${file} (ALLOWED_CLOSED_LOOP_IMPORTERS 갱신 필요)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
