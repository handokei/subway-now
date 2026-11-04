import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countByDecl, declBody, findLockWriteSites, PROGRESS_FIELDS } from './helpers/lockWriteSites';

/**
 * #3055 / #3300 옵션 D PR-4b — 진행 필드 직접 쓰기 가드 (`lockWriteGuard.test.ts` 패턴, plan §9 "PR-4 guard 테스트로 강제").
 *
 * 셀 권위 단계(`progress@N`)에서 `waypoints | routeWaypoints | currentLegAnchor | legBoardingEligibleAt | legBoardingPromptState |
 * legResolveStreak | transferObservedAt | lastTrackedArrivalEpoch | lastLaPushEpoch | lastLaPushAt`를 **셀 op 없이** 바꾸는 직접
 * 대입/객체 리터럴 쓰기는 조용히 무시된다(다음 overlay가 셀 값으로 되돌린다 -> 소비한 역이 부활하거나 스탬프가 사라진다).
 * 이 테스트는 `scheduled.ts`·`index.ts`의 쓰기 지점이
 *  (1) 함수 단위 허용 목록 안에 머무는지(허용 = flag off 현행 동작을 보존하는 메모리 구성 / 입력 검증 파싱 / 순수 계산),
 *  (2) 영속 권한을 가진 함수 본문에 셀 op 호출 표식이 남아 있는지
 * 를 강제한다. 새 직접 쓰기가 필요하면 op를 추가하고 이 허용 목록을 같은 PR에서 갱신한다.
 */
const SRC_DIR = join(__dirname, '..');
const GUARDED_SOURCES = new Set(['scheduled.ts', 'index.ts']);

/** 파일 -> 선언 -> 허용되는 직접 쓰기 최대 개수. */
const ALLOWED_WRITES: Record<string, Record<string, number>> = {
  'scheduled.ts': {},
  'index.ts': {},
};

/** 선언 -> 본문에 반드시 있어야 하는 셀 op 호출 표식(파일별). */
const REQUIRED_OPS: Record<string, Record<string, string[]>> = {
  'scheduled.ts': {
    completeWaypointAdvance: ["'advanceHead'", "'setLegAnchor'"],
    stampCurrentLegAnchor: ["'setLegAnchor'"],
    catchUpToLockTrain: ["'advanceHead'"],
    reconcileLockTripProgress: ["'reanchor'"],
    advanceBoardingLockWaypoint: ["'advanceHead'"],
    runScheduled: ['flushProgressStamps('],
  },
  'index.ts': {
    applyRegisterCells: ["'registerProgress'"],
  },
};

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (entry === '__tests__' || entry === 'node_modules') continue;
    if (statSync(fullPath).isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const SOURCES = listTsFiles(SRC_DIR)
  .map((file) => ({ rel: relative(SRC_DIR, file), source: readFileSync(file, 'utf-8') }))
  .filter(({ rel }) => GUARDED_SOURCES.has(rel));

describe('#3055 PR-4b — 진행 필드 직접 쓰기 가드 (scheduled.ts·index.ts)', () => {
  it('직접 쓰기는 허용 목록 선언 안에서만, 허용 개수를 넘지 않는다', () => {
    const violations = SOURCES.flatMap(({ rel, source }) => {
      const sites = findLockWriteSites(source, PROGRESS_FIELDS);
      const counts = countByDecl(sites);
      return Object.entries(counts)
        .filter(([decl, count]) => count > (ALLOWED_WRITES[rel]?.[decl] ?? 0))
        .map(([decl, count]) => ({
          file: rel,
          decl,
          count,
          allowed: ALLOWED_WRITES[rel]?.[decl] ?? 0,
          lines: sites.filter((s) => s.decl === decl).map((s) => s.line),
        }));
    });
    expect(violations).toEqual([]);
  });

  it('허용 목록의 선언이 실제로 소스에 존재한다(이름 변경으로 허용이 무의미해지지 않게)', () => {
    const missing = Object.entries(ALLOWED_WRITES).flatMap(([rel, decls]) => {
      const entry = SOURCES.find((s) => s.rel === rel);
      return Object.keys(decls)
        .filter((decl) => entry === undefined || declBody(entry.source, decl) === '')
        .map((decl) => `${rel}:${decl}`);
    });
    expect(missing).toEqual([]);
  });

  const requiredCases = Object.entries(REQUIRED_OPS).flatMap(([rel, decls]) =>
    Object.entries(decls).map(([decl, markers]) => [rel, decl, markers] as const),
  );
  it.each(requiredCases)('%s %s 본문에 셀 op 호출 표식이 있다', (rel, decl, markers) => {
    const entry = SOURCES.find((s) => s.rel === rel);
    const body = entry === undefined ? '' : declBody(entry.source, decl);
    expect(body, `${rel}:${decl} 선언을 찾지 못함`).not.toBe('');
    for (const marker of markers) expect(body).toContain(marker);
  });

  it('가드 자체 검증: 허용 목록 밖 함수의 직접 대입은 위반으로 잡힌다', () => {
    const scheduled = SOURCES.find((s) => s.rel === 'scheduled.ts');
    const injected = `${scheduled?.source}\nfunction sneakyProgressWrite(trip: Trip) {\n  trip.waypoints = [];\n  trip.lastLaPushAt = 0;\n}\n`;
    const counts = countByDecl(findLockWriteSites(injected, PROGRESS_FIELDS));
    expect(counts.sneakyProgressWrite).toBe(2);
    expect(ALLOWED_WRITES['scheduled.ts'].sneakyProgressWrite).toBeUndefined();
  });
});
