/**
 * #3300 PR-3a — `index.ts`의 lock/LA 필드 쓰기 지점을 "둘러싼 최상위 선언" 단위로 센다 (lockWriteGuardHttp.test.ts 입력).
 *
 * 쓰기 = 객체 리터럴 키(`boardingLock: x`) 또는 대입(`.boardingLock = x`). 읽기·비교·타입 선언·주석은 제외.
 * 최상위 선언 = 들여쓰기 0칸에서 시작하는 `function` / `async function` / `export ... function` / `app.<verb>(...)` 줄.
 */
export const GUARDED_FIELDS = [
  'boardingLock',
  'activityPushToken',
  'activityState',
  'consecutiveEtaMissing',
  'lockCodeHistory',
  'renumberSuccessor',
  'lockEverAttached',
] as const;

/**
 * #3055 PR-4b — 진행 셀 필드. lock/LA 가드와 같은 방식으로 `progressWriteGuard.test.ts`가 직접 쓰기를 센다.
 * (`promptDisplay`는 읽기·로그 리터럴이 너무 많아 제외 — 쓰기는 `registerProgress`/`setLegAnchor` op가 소유하고 가드는 `waypoints`·anchor 계열로 충분하다.)
 */
export const PROGRESS_FIELDS = [
  'waypoints',
  'routeWaypoints',
  'currentLegAnchor',
  'legBoardingEligibleAt',
  'legBoardingPromptState',
  'legResolveStreak',
  'transferObservedAt',
  'lastTrackedArrivalEpoch',
  'lastLaPushEpoch',
  'lastLaPushAt',
] as const;

// 객체 리터럴 키 `field:`(삼항 `? a : b`의 콜론과 구분하려고 앞이 식별자 경계) 또는 대입 `.field =`(비교 `===`/`==` 제외).
// 배열 in-place 변경(`.waypoints.shift()` 등)도 쓰기다.
const writePattern = (fields: readonly string[]): RegExp => {
  const alt = fields.join('|');
  return new RegExp(`(?:[{,(]\\s*|^\\s*)(?:${alt})\\s*:(?!:)|\\.(?:${alt})\\s*=(?!=)|\\.(?:${alt})\\.(?:shift|splice|push|pop|unshift|sort|reverse)\\(`);
};
const WRITE_PATTERN = writePattern(GUARDED_FIELDS);
const DECL_PATTERN = /^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)|^app\.(get|post|put|delete)\(\s*'([^']+)'/;

// 쓰기가 아닌 매칭: 구조 분해 `const { boardingLock: x } = ...`, 타입 멤버 `activityPushToken: string;`.
// 진행 셀 op 입력(`set: { lastLaPushAt: now }`)과 타입 주석(`waypoints: Trip['waypoints']`)도 쓰기가 아니다.
const NOT_A_WRITE = [/^(?:const|let)\s*\{/, /:\s*(?:string|number|boolean)\s*;$/, /(?:^|[\s({,])set:\s*\{/, /:\s*Trip\['waypoints'\]/];

export interface WriteSite {
  decl: string;
  line: number;
  text: string;
}

export function findLockWriteSites(source: string, fields?: readonly string[]): WriteSite[] {
  const pattern = fields === undefined ? WRITE_PATTERN : writePattern(fields);
  const sites: WriteSite[] = [];
  let decl = '<module>';
  source.split('\n').forEach((text, index) => {
    const declMatch = DECL_PATTERN.exec(text);
    if (declMatch) decl = declMatch[1] ?? `${declMatch[2]} ${declMatch[3]}`;
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (NOT_A_WRITE.some((pattern) => pattern.test(trimmed))) return;
    if (pattern.test(text)) sites.push({ decl, line: index + 1, text: trimmed });
  });
  return sites;
}

export function countByDecl(sites: WriteSite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { decl } of sites) counts[decl] = (counts[decl] ?? 0) + 1;
  return counts;
}

/** 최상위 선언 본문 텍스트(다음 최상위 선언 직전까지). */
export function declBody(source: string, declName: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((text) => {
    const m = DECL_PATTERN.exec(text);
    return m !== null && (m[1] ?? `${m[2]} ${m[3]}`) === declName;
  });
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (DECL_PATTERN.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}
