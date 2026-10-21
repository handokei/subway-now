/**
 * PR-3b — "모든 sentinel 생산자가 종료를 알린다"는 불변식의 부분 강제 (plan 2026-10-21 §3.2/§3.5④).
 *
 * sentinel 소비 지점(`useStateRehydration` rehydration)은 **알림 주체가 아니다**(결정): 이미 다른 경로가
 * 끝낸 트립의 메모리 reset이라 여기서 알리면 생산자 알림과 중복된다. 이 결정은 "sentinel을 쓰는 모든
 * 생산자가 각자 알린다(또는 알림 부재의 사유가 명시돼 있다)"에 의존한다. 신규 `setTripEndedSentinel(` 호출처가
 * 생기면 이 테스트가 red가 되어 알림 정책을 **명시적으로 분류**하도록 강제한다 — 분류 없이 무음 종료가
 * 재발하는 경로를 막는다.
 *
 * 분류:
 *  - notifies        : 파일이 `notifyTripEnded(`를 생산자 수 이상 호출한다(이 테스트가 기계 확인).
 *  - backend-alert   : 종료가 backend 확정이고 backend alert push(B12, #2069)가 알린다 — 추정(U10).
 *  - caller-decides  : 공유 시퀀스. 알림 여부는 호출부 몫(사용자 직접 종료는 의도적으로 무알림 #2675).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const SENTINEL_CALL = 'setTripEndedSentinel(';
const NOTICE_CALL = 'notifyTripEnded(';
/** 정의 파일 — 생산자가 아니다. */
const DEFINITION_FILE = 'features/alarm/utils/tripEndedSentinel.ts';

type Policy = 'notifies' | 'backend-alert' | 'caller-decides';

/** 6개 생산자(verify-plan 2026-10-21 전수). 값 = [생산 지점 수, 정책, 사유]. */
const EXPECTED_PRODUCERS: Record<string, { sites: number; policy: Policy; why: string }> = {
  'shared/hooks/useStateRehydration.ts': {
    sites: 2,
    policy: 'notifies',
    why: '9h force-end(lifecycle) + 일시정지 backstop(paused)',
  },
  'features/alarm/hooks/useLaunchTripReconciliation.ts': {
    sites: 1,
    policy: 'notifies',
    why: 'Signal 4 backend 무음 self-end(backend-silent)',
  },
  'features/alarm/hooks/useDeviceSelfEnd.ts': {
    sites: 1,
    policy: 'notifies',
    why: '도착 자동 종료(arrived, #2675)',
  },
  'features/alarm/tasks/silentPushTask.ts': {
    sites: 1,
    policy: 'backend-alert',
    why: 'backend trip-ended push 수신 — backend alert push가 알린다(#2069 B12, 추정 U10)',
  },
  'features/alarm/utils/tripEndedCleanupSequence.ts': {
    sites: 1,
    policy: 'caller-decides',
    why: '정본 시퀀스 — 사용자 직접 종료는 무알림(#2675), backend-confirmed는 backend alert, B(backend-gone)는 호출부가 알린다',
  },
};

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 주석 줄(`//`, `*`, `/*` 시작)은 호출이 아니므로 제외하고 호출 수를 센다. */
function countCalls(source: string, needle: string): number {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .reduce((n, line) => n + (line.includes(needle) ? 1 : 0), 0);
}

describe('sentinel 생산자 전수 — 알림 정책 분류 (PR-3b)', () => {
  const found: Record<string, { sites: number; source: string }> = {};
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (rel === DEFINITION_FILE) continue;
    const source = fs.readFileSync(file, 'utf8');
    const sites = countCalls(source, SENTINEL_CALL);
    if (sites > 0) found[rel] = { sites, source };
  }

  it('sentinel을 쓰는 파일·지점 수가 분류표와 정확히 일치한다(신규 생산자는 분류 필수)', () => {
    const actual = Object.fromEntries(Object.entries(found).map(([f, { sites }]) => [f, sites]));
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_PRODUCERS).map(([f, { sites }]) => [f, sites]),
    );
    expect(actual).toEqual(expected);
  });

  it('생산 지점 총 6곳(verify-plan 전수)', () => {
    const total = Object.values(found).reduce((n, { sites }) => n + sites, 0);
    expect(total).toBe(6);
  });

  it.each(
    Object.entries(EXPECTED_PRODUCERS).filter(([, { policy }]) => policy === 'notifies'),
  )('%s — notifies 정책이면 생산 지점 수 이상 notifyTripEnded를 호출한다', (file, { sites }) => {
    const { source } = found[file];
    expect(countCalls(source, NOTICE_CALL)).toBeGreaterThanOrEqual(sites);
  });

  it.each(
    Object.entries(EXPECTED_PRODUCERS).filter(([, { policy }]) => policy !== 'notifies'),
  )('%s — 무알림 정책은 사유가 명시돼 있다', (_file, { why }) => {
    expect(why.length).toBeGreaterThan(10);
  });

  it('sentinel 소비 지점(rehydration cycle)은 알림 주체가 아니다 — 생산자 분기 밖에서 notifyTripEnded를 부르지 않는다', () => {
    const { source } = found['shared/hooks/useStateRehydration.ts'];
    const consumeStart = source.indexOf('async function runRehydrationCycle');
    const lifecycleStart = source.indexOf('async function runLifecycleBackstop');
    expect(consumeStart).toBeGreaterThan(-1);
    expect(lifecycleStart).toBeGreaterThan(consumeStart);
    const consumeBody = source.slice(consumeStart, lifecycleStart);
    // runRehydrationCycle 본문에는 생산자 호출이 있어서는 안 된다(소비 + 위임만).
    expect(consumeBody).not.toContain(NOTICE_CALL);
  });
});
