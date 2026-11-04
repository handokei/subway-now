import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countByDecl, declBody, findLockWriteSites } from './helpers/lockWriteSites';

/**
 * #3055 / #3300 옵션 D PR-3b — lock 필드 직접 쓰기 가드 (`noRawSqlGuard.test.ts` 패턴, plan §1(b)·§4 PR-3b).
 *
 * 셀 권위 단계(`lock@N`)에서 `boardingLock | consecutiveEtaMissing | lockCodeHistory | renumberSuccessor | lockEverAttached`
 * (+ LA 셀 필드 `activityPushToken | activityState`)를 **셀 op 없이** 바꾸는 직접 대입/객체 리터럴 쓰기는 조용히 무시된다
 * (다음 overlay가 셀 값으로 되돌린다 -> 해제된 lock이 부활하거나 사용자 의향이 사라진다). 이 테스트는
 *  (1) `src/` 전체(테스트·lockOps/laCellOps 제외)의 쓰기 지점이 함수 단위 허용 목록 안에 머무는지,
 *  (2) 허용된 함수 본문에 셀 op 호출 표식이 남아 있는지를 강제한다.
 * 허용 목록 = "flag off 현행 동작을 보존하는 메모리 구성" 또는 "입력 검증 파싱"이다. 영속 권한은 (2)의 op가 가진다.
 * 새 직접 쓰기가 필요하면 op를 추가하고 이 허용 목록을 같은 PR에서 갱신한다.
 *
 * `index.ts`(HTTP)는 PR-3a의 `lockWriteGuardHttp.test.ts`가 같은 helper로 이미 강제한다 — 여기서는 제외한다.
 */
const SRC_DIR = join(__dirname, '..');
const EXCLUDED_FILES = new Set(['index.ts', 'lockOps.ts', 'laCellOps.ts']);

/** 파일 -> 선언 -> 허용되는 직접 쓰기 최대 개수. */
const ALLOWED_WRITES: Record<string, Record<string, number>> = {
  'trips.ts': {
    // lockEverAttached 자동 stamp(#2628) — 직렬화 직전 사본.
    putTrip: 1,
    // 메모리 정리(read-only 의미) — cell 모드에서는 listTrips가 이 함수를 우회하고 releaseAuto로 영속한다.
    clearStaleBoardingLock: 1,
  },
  'tripDoCells.ts': {
    // seedFromKv/seedLaFromKv op 입력 조립.
    seedCells: 4,
  },
  'liveActivity.ts': {
    // token-invalid clear / dismissal의 메모리 전이 — cell 모드의 영속은 clearLaTokenViaCell.
    fireLiveActivityUpdate: 2,
    fireLiveActivityDismissal: 2,
  },
  'scheduled.ts': {
    // 쓰기가 아닌 매칭: 타입 술어 `trip is Trip & { boardingLock: BoardingLockMeta }`.
    isBoardingLockActive: 1,
    // 쓰기가 아닌 매칭: progress KV 사본 객체 리터럴(`consecutiveEtaMissing: trip.consecutiveEtaMissing` — trip을 읽기만 한다).
    mirrorProgress: 1,
    // #10/#11 cron attach — 영속은 attachIfNone op, legacy(flag off)만 직접 대입.
    runScheduled: 6,
    // #12 reanchor segment — setSegment.
    reconcileLockTripProgress: 1,
    // #13 vanish swap / #14 timetable successor — swapAuto.
    attemptVanishSwap: 5,
    attemptTimetableSuccessorReattach: 4,
    // #15/#16/#17 — releaseAuto / setEtaMissing.
    handleEtaMissing: 11,
    // #17 성공 사이클 카운터 0 — setEtaMissing.
    runTrainCodeTracking: 1,
    // #18 환승 해제 — releaseAuto(cron) / 메모리(HTTP sync-mixed는 index.ts가 op).
    completeWaypointAdvance: 2,
  },
};

/** 선언 -> 본문에 반드시 있어야 하는 op 호출 표식(파일별). */
const REQUIRED_OPS: Record<string, Record<string, string[]>> = {
  'scheduled.ts': {
    runScheduled: ["'attachIfNone'", 'overlayCronTrips('],
    reconcileLockTripProgress: ["'setSegment'"],
    attemptVanishSwap: ["'swapAuto'"],
    attemptTimetableSuccessorReattach: ["'swapAuto'"],
    handleEtaMissing: ["'releaseAuto'", "'setEtaMissing'"],
    runTrainCodeTracking: ["'setEtaMissing'"],
    completeWaypointAdvance: ["'releaseAuto'"],
    fireBoardingPromptForAnchor: ['freshLockActive('],
  },
  'liveActivity.ts': {
    fireLiveActivityUpdate: ['clearLaTokenViaCell('],
    cleanupTripWithLa: ['endLockSession('],
  },
  'trips.ts': {
    // 셀 모드의 cron 열거는 stale-line 메모리 정리를 건너뛴다(셀이 권위 — 정리는 cronLockCell의 releaseAuto).
    listTrips: ['rawLock'],
  },
  'cronLockCell.ts': {
    overlayCronTrips: ["'releaseAuto'", "'stale-line'"],
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
  .filter(({ rel }) => !EXCLUDED_FILES.has(rel));

describe('#3055 PR-3b — lock/LA 필드 직접 쓰기 가드 (index.ts·lockOps.ts·laCellOps.ts 제외 전 소스)', () => {
  it('직접 쓰기는 허용 목록 선언 안에서만, 허용 개수를 넘지 않는다', () => {
    const violations = SOURCES.flatMap(({ rel, source }) => {
      const sites = findLockWriteSites(source);
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
    const injected = `${scheduled?.source}\nfunction sneakyLockWrite(trip: Trip) {\n  trip.boardingLock = undefined;\n  trip.consecutiveEtaMissing = 0;\n}\n`;
    const counts = countByDecl(findLockWriteSites(injected));
    expect(counts.sneakyLockWrite).toBe(2);
    expect(ALLOWED_WRITES['scheduled.ts'].sneakyLockWrite).toBeUndefined();
  });
});
