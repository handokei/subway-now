import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countByDecl, declBody, findLockWriteSites } from './helpers/lockWriteSites';

/**
 * #3300 PR-3a — HTTP(`index.ts`) lock/LA 필드 쓰기 가드 (`noRawSqlGuard.test.ts` 패턴, cron `scheduled.ts`는 PR-3b에서 확장).
 *
 * 셀 권위 단계에서 lock·LA 필드를 바꾸는 직접 대입은 DO op 호출과 짝이어야 한다 — 짝 없는 직접 대입은 셀 모드에서
 * **조용히 무시되어**(다음 overlay가 셀 값으로 되돌림) 해제된 lock이 부활하거나 사용자 의향이 사라진다(plan §1(b)).
 * 이 테스트는 (1) 쓰기 지점이 허용 목록(최상위 선언 단위) 밖으로 늘지 않았는지, (2) 허용된 선언 안에 op 호출이
 * 남아 있는지를 강제한다.
 *
 * 허용 목록은 "메모리 trip을 구성하는" 선언들이다 — 영속 권한은 아래 (2)의 op 호출이 가진다.
 * 새 직접 쓰기가 필요하면 op를 추가하고 여기 허용 목록을 같은 PR에서 갱신한다.
 */
const INDEX_SOURCE = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

/** 선언 -> 허용되는 직접 쓰기 최대 개수(메모리 구성; 영속은 op). */
const ALLOWED_WRITES: Record<string, number> = {
  // 메모리 trip 구성 후 attachIfNone op 결과를 applyLockResult로 덮는다.
  resolveBoardingAnchorAtRegister: 2,
  // register 병합 — flag on이면 applyRegisterCells(registerSession op + 셀 값)가 최종 권위.
  'post /trips': 8,
  // confirm 메모리 판정(release 2) — 영속은 commitConfirmLockOp.
  'post /trips/:token/boarding-confirm': 2,
  attachBoardedLock: 2,
  // sync 승격 2 + TTL 갱신 1 — 영속은 attachIfNone / refreshExpiry / releaseAuto.
  'post /boarding-lock/sync': 3,
  // LA — 메모리 구성, 영속은 registerLaToken / clearLaToken.
  'post /live-activity/register': 1,
  'delete /live-activity/:tripToken': 2,
  // 입력 검증 파싱(요청 payload -> Trip).
  validateTrip: 2,
  validateLiveActivityRegister: 1,
};

/** 선언 -> 본문에 반드시 있어야 하는 op 호출 표식. */
const REQUIRED_OPS: Record<string, string[]> = {
  resolveBoardingAnchorAtRegister: ["'attachIfNone'"],
  'post /trips': ['applyRegisterCells('],
  applyRegisterCells: ["'registerSession'"],
  'post /trips/:token/boarding-confirm': ['commitConfirmLockOp('],
  commitConfirmLockOp: ["'userBoarded'", "'userDisembarked'"],
  'post /boarding-lock/sync': ["'attachIfNone'", "'refreshExpiry'", "'releaseAuto'"],
  'post /live-activity/register': ["'registerLaToken'"],
  'delete /live-activity/:tripToken': ["'clearLaToken'"],
};

describe('#3300 PR-3a — index.ts lock/LA 직접 쓰기 가드', () => {
  const sites = findLockWriteSites(INDEX_SOURCE);

  it('직접 쓰기는 허용 목록 선언 안에서만, 허용 개수를 넘지 않는다', () => {
    const counts = countByDecl(sites);
    const violations = Object.entries(counts)
      .filter(([decl, count]) => count > (ALLOWED_WRITES[decl] ?? 0))
      .map(([decl, count]) => ({
        decl,
        count,
        allowed: ALLOWED_WRITES[decl] ?? 0,
        lines: sites.filter((s) => s.decl === decl).map((s) => s.line),
      }));
    expect(violations).toEqual([]);
  });

  it.each(Object.entries(REQUIRED_OPS))('%s 본문에 셀 op 호출이 있다', (decl, markers) => {
    const body = declBody(INDEX_SOURCE, decl);
    expect(body).not.toBe('');
    for (const marker of markers) expect(body).toContain(marker);
  });

  it('가드 자체 검증: 허용 목록 밖 함수의 직접 대입은 위반으로 잡힌다', () => {
    const injected = `${INDEX_SOURCE}\nfunction sneakyLockWrite(trip: Trip) {\n  trip.boardingLock = undefined;\n}\n`;
    const counts = countByDecl(findLockWriteSites(injected));
    expect(counts.sneakyLockWrite).toBe(1);
    expect(ALLOWED_WRITES.sneakyLockWrite).toBeUndefined();
  });
});
