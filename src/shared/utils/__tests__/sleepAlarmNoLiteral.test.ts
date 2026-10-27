/**
 * #3100 — 취침 알람 "N역 전" 리터럴 가드. 칸 수(1·2·3)는 `constants/sleepAlarm.ts`에서만 온다.
 *
 * 세 층:
 *  1. 신규 모듈 엄격 검사 — 숫자 리터럴 [1-9]가 하나도 없어야 한다(주석 제외).
 *  2. 기존 파일 함수 단위 검사 — 이름으로 잘라낸 함수 본문 + 호출 표현식에 RE1~RE6.
 *  3. 기기 파일 전체 검사 — 기기 PR이 고친 파일을 `DEVICE_FILES`에 추가한다(PR-1은 기기 변경 없음).
 *
 * 한계(의도적): 정규식은 "1/2/3 숫자 리터럴"만 본다. `=== SLEEP_ALARM_MIN_STOPS_BEFORE`처럼 상수를 쓰되
 * 의미가 "1역 전 하나만"인 하드코딩이나 인접 쌍 같은 구조 하드코딩은 못 잡는다 — MAX=4 mock
 * end-to-end table(`scheduled.sleepAlarmN.max4.test.ts`)이 보완한다.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
const read = (relPath: string): string => readFileSync(join(ROOT, relPath), 'utf8');

/** 주석(블록·줄) 제거. 가드 대상 함수에는 `//`를 포함한 문자열 리터럴이 없다. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `function name(` 부터 첫 줄머리 `}` 까지의 본문. 없으면 undefined. */
function extractFunctionBody(source: string, name: string): string | undefined {
  const start = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(source);
  if (!start) return undefined;
  const end = source.indexOf('\n}', start.index);
  return end === -1 ? undefined : source.slice(start.index, end + 2);
}

/** `name(` 호출 표현식(정의 제외)을 균형 괄호로 잘라 모두 돌려준다. */
function extractCallExpressions(source: string, name: string): string[] {
  const calls: string[] = [];
  const marker = `${name}(`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    if (/function\s+$/.test(source.slice(0, at))) continue; // 정의
    let depth = 1;
    let i = from;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    calls.push(source.slice(at, i));
  }
  return calls;
}

const RE1 = /\b(remainingStops|stopsBefore|stopsRemaining|APPROACH_STOPS|band|remaining|stops)\b\s*(<=|<|===|!==|==|>=|>|=)\s*[1-9]\b/;
const RE2 = /\b(remainingStops|stopsBefore|band|remaining)\s*[-+]\s*[1-9]\b/;
const RE3 = /\[\s*1\s*,\s*2\s*(,\s*3\s*)?\]/;
const RE4 = /legMs\s*\/\s*(wp|target)\.stops/;
const RE5 = /\b(from|to)\w*\s*:\s*[1-9]\b/;
const RE6 = /\.slice\(\s*[1-9]\s*\)|waypoints\[\s*[1-9]\s*\]/;

const FUNCTION_RES: [string, RegExp][] = [['RE1', RE1], ['RE2', RE2], ['RE3', RE3], ['RE4', RE4], ['RE5', RE5], ['RE6', RE6]];
const FILE_RES: [string, RegExp][] = [['RE1', RE1], ['RE2', RE2], ['RE3', RE3], ['RE4', RE4]];

function violations(code: string, res: [string, RegExp][]): string[] {
  return res.filter(([, re]) => re.test(code)).map(([id]) => id);
}

/** 라인 단위 파일 검사 — 주석 줄과 0과의 비교는 제외(RE1~RE4는 [1-9]만 보므로 0은 원래 안 걸린다). */
function fileViolations(source: string): string[] {
  return violations(stripComments(source), FILE_RES);
}

// ── 층 1: 신규 모듈 ──────────────────────────────────────────────────────────────────────
const STRICT_MODULES = [
  'src/shared/utils/sleepAlarmCells.ts',
  'backend/alarm-worker/src/sleepAlarmCrossing.ts',
];

describe('층 1 — 신규 모듈에는 숫자 리터럴 [1-9]가 없다', () => {
  it.each(STRICT_MODULES)('%s', (relPath) => {
    const code = stripComments(read(relPath));
    const hits = code.split('\n').filter((line) => /[1-9]/.test(line));
    expect(hits).toEqual([]);
  });
});

// ── 층 2: 기존 파일의 함수 본문 / 호출 표현식 ───────────────────────────────────────────────
const FUNCTION_TARGETS: { file: string; names: string[] }[] = [
  {
    file: 'backend/alarm-worker/src/scheduled.ts',
    names: [
      'evaluateSleepAlarmTrigger',
      'maybeFireSleepAlarm',
      'selectConsumedPrecedingAlarmPairs',
      'fireSyncConsumedPrecedingAlarms',
      'sleepAlarmFireKey',
    ],
  },
  { file: 'backend/alarm-worker/src/collapseId.ts', names: ['sleepAlarmCollapseId'] },
  { file: 'backend/alarm-worker/src/i18n.ts', names: ['sleepAlarmContent'] },
];

describe('층 2 — 대상 함수 본문에 1/2/3 리터럴이 없다', () => {
  for (const { file, names } of FUNCTION_TARGETS) {
    const source = stripComments(read(file));
    it.each(names)(`${file} :: %s`, (name) => {
      const body = extractFunctionBody(source, name);
      expect(body).toBeDefined();
      expect(violations(body as string, FUNCTION_RES)).toEqual([]);
    });
  }

  it('crossingForConsumed( … ) 호출 인자에 숫자 리터럴이 없다 (ONE_STATION_STEP 등 상수만)', () => {
    const source = stripComments(read('backend/alarm-worker/src/scheduled.ts'));
    const calls = extractCallExpressions(source, 'crossingForConsumed');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(call).not.toMatch(/\b[1-9]\b/);
  });

  it('maybeFireSleepAlarm({ … }) 호출 표현식은 waypoints[<숫자>]를 직접 참조하지 않는다', () => {
    const source = stripComments(read('backend/alarm-worker/src/scheduled.ts'));
    const calls = extractCallExpressions(source, 'maybeFireSleepAlarm');
    // 호출부: completeWaypointAdvance / runLocklessIntermediate / sync 루프.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call).not.toMatch(/waypoints\[/);
  });
});

// ── 층 3: 기기 파일 전체 (기기 PR이 목록에 추가) ──────────────────────────────────────────────
const DEVICE_FILES: string[] = [
  'src/features/alarm/tasks/silentPushTask.ts',
  'src/features/alarm/utils/alarmLocalAuthority.ts',
  'src/features/alarm/utils/safetyNetScheduler.ts',
  'src/features/alarm/utils/scheduledAlarmReceiver.ts',
  'src/features/alarm/utils/companionAlarmEvent.ts',
  'src/features/alarm/utils/stationNotification.ts',
  'src/features/alarm/hooks/useSafetyNetScheduler.ts',
  'src/features/alarm/hooks/useApnsTripRegistration.ts',
  'src/features/alarm/api/alarmBackend.ts',
  'src/features/alarm/components/SleepAlarmOverlay.tsx',
  'src/features/settings/store/useSettingsStore.ts',
  'src/features/settings/components/SleepAlarmStops.tsx',
];

describe('층 3 — 기기 파일 전체 검사', () => {
  for (const relPath of DEVICE_FILES) {
    it(relPath, () => {
      expect(fileViolations(read(relPath))).toEqual([]);
    });
  }
});

// ── 가드 자체 검증: 알려진 위반 패턴을 실제로 잡는가 ─────────────────────────────────────────
describe('가드 자체 — 위반 샘플을 잡고 정상 샘플은 통과시킨다', () => {
  it.each([
    ['RE1', 'function f() { if (remaining <= 1) return; }'],
    ['RE1', 'function f() { const band = 2; }'],
    ['RE2', 'function f() { return remaining - 1; }'],
    ['RE3', 'function f() { return [1, 2, 3]; }'],
    ['RE4', 'function f() { return legMs / wp.stops; }'],
    ['RE5', 'function f() { return { fromRemaining: 2, toRemaining: 1 }; }'],
    ['RE6', 'function f() { return list.slice(1); }'],
    ['RE6', 'function f() { return trip.waypoints[1]; }'],
  ])('%s 위반 샘플', (id, code) => {
    expect(violations(code, FUNCTION_RES)).toContain(id);
  });

  it('정상 샘플(상수 참조, 0 비교)은 통과', () => {
    const ok = 'function f() { return remaining === SLEEP_ALARM_MIN_STOPS_BEFORE || remaining > 0; }';
    expect(violations(ok, FUNCTION_RES)).toEqual([]);
  });

  it('파일 전체 검사(층 3)도 위반을 잡고 주석 줄은 건너뛴다', () => {
    expect(fileViolations('const APPROACH_STOPS = 1;')).toContain('RE1');
    expect(fileViolations('// const APPROACH_STOPS = 1;\nconst ok = SLEEP_ALARM_MIN_STOPS_BEFORE;')).toEqual([]);
  });

  it('주석 속 리터럴은 제외', () => {
    expect(stripComments('const a = b; // remaining <= 1\n/* [1, 2, 3] */')).not.toMatch(/\[1, 2, 3\]|remaining <= 1/);
  });

  it('함수 본문 / 호출 표현식 추출', () => {
    const src = 'async function foo(a) {\n  return bar({ x: [a] });\n}\nfoo(1);\n';
    expect(extractFunctionBody(src, 'foo')).toContain('return bar');
    expect(extractCallExpressions(src, 'foo')).toEqual(['foo(1)']);
    expect(extractFunctionBody(src, 'missing')).toBeUndefined();
  });
});
