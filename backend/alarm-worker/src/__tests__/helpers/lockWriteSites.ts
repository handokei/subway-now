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

const FIELD_ALT = GUARDED_FIELDS.join('|');
// 객체 리터럴 키 `field:`(삼항 `? a : b`의 콜론과 구분하려고 앞이 식별자 경계) 또는 대입 `.field =`(비교 `===`/`==` 제외).
const WRITE_PATTERN = new RegExp(`(?:[{,(]\\s*|^\\s*)(?:${FIELD_ALT})\\s*:(?!:)|\\.(?:${FIELD_ALT})\\s*=(?!=)`);
const DECL_PATTERN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^app\.(get|post|put|delete)\(\s*'([^']+)'/;

// 쓰기가 아닌 매칭: 구조 분해 `const { boardingLock: x } = ...`, 타입 멤버 `activityPushToken: string;`.
const NOT_A_WRITE = [/^(?:const|let)\s*\{/, /:\s*(?:string|number|boolean)\s*;$/];

export interface WriteSite {
  decl: string;
  line: number;
  text: string;
}

export function findLockWriteSites(source: string): WriteSite[] {
  const sites: WriteSite[] = [];
  let decl = '<module>';
  source.split('\n').forEach((text, index) => {
    const declMatch = DECL_PATTERN.exec(text);
    if (declMatch) decl = declMatch[1] ?? `${declMatch[2]} ${declMatch[3]}`;
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (NOT_A_WRITE.some((pattern) => pattern.test(trimmed))) return;
    if (WRITE_PATTERN.test(text)) sites.push({ decl, line: index + 1, text: trimmed });
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
