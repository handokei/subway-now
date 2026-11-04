/**
 * PR-3b — "모든 sentinel 생산자가 종료를 알린다"는 불변식의 부분 강제 (plan 2026-10-21 §3.2/§3.5④).
 *
 * sentinel 소비 지점(`useStateRehydration` rehydration)은 **알림 주체가 아니다**(결정): 이미 다른 경로가
 * 끝낸 트립의 메모리 reset이라 여기서 알리면 생산자 알림과 중복된다. 이 결정은 "sentinel을 쓰는 모든
 * 생산자가 각자 알린다(또는 알림 부재의 사유가 명시돼 있다)"에 의존한다. 신규 `setTripEndedSentinel(` 호출처가
 * 생기면 이 테스트가 red가 되어 알림 정책을 **명시적으로 분류**하도록 강제한다 — 분류 없이 무음 종료가
 * 재발하는 경로를 막는다.
 *
 * #3005 PR-C — device가 스스로 종료를 판정하는 4경로(Signal 4 / 9h / 일시정지 / device self-end)는 sentinel을 직접
 * 쓰지 않고 정본(`cleanupDeviceSelfEndedTrip`)을 호출한다. sentinel 생산 지점은 정본 1곳 + silent push 1곳으로
 * 줄었고, "각 경로가 알린다"는 불변식은 호출부가 `notifyReason`을 넘기는지로 옮겨 강제한다.
 *
 * 분류:
 *  - backend-alert   : 종료가 backend 확정이고 backend alert push(B12, #2069)가 알린다 — 추정(U10).
 *  - caller-decides  : 공유 시퀀스. 알림 여부는 호출부 몫(사용자 직접 종료는 의도적으로 무알림 #2675).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../..');
const SENTINEL_CALL = 'setTripEndedSentinel(';
/** 정의 파일 — 생산자가 아니다. */
const DEFINITION_FILE = 'features/alarm/utils/tripEndedSentinel.ts';
/** 정본 파일 — 자기 정의/주석은 호출처가 아니다. */
const SEQUENCE_FILE = 'features/alarm/utils/tripEndedCleanupSequence.ts';

type Policy = 'backend-alert' | 'caller-decides';

/** sentinel 생산자 전수. 값 = [생산 지점 수, 정책, 사유]. */
const EXPECTED_PRODUCERS: Record<string, { sites: number; policy: Policy; why: string }> = {
  'features/alarm/tasks/silentPushTask.ts': {
    sites: 1,
    policy: 'backend-alert',
    why: 'backend trip-ended push 수신 — backend alert push가 알린다(#2069 B12, 추정 U10)',
  },
  [SEQUENCE_FILE]: {
    sites: 1,
    policy: 'caller-decides',
    why: '정본 시퀀스 — 사용자 직접 종료는 무알림(#2675), backend-confirmed는 backend alert, 그 외 device 자가 종료는 호출부가 notifyReason으로 알린다',
  },
};

/** 정본의 device 자가 종료 진입점 호출처 — 값 = 호출 지점 수. */
const DEVICE_SELF_END_CALL = 'cleanupDeviceSelfEndedTrip(';
const NOTICE_REASON_ARG = 'notifyReason:';
const EXPECTED_SELF_END_CALLERS: Record<string, number> = {
  'shared/hooks/useStateRehydration.ts': 2, // 9h force-end(lifecycle) + 일시정지 backstop(paused)
  'features/alarm/hooks/useLaunchTripReconciliation.ts': 1, // Signal 4(backend-silent)
  'features/alarm/hooks/useDeviceSelfEnd.ts': 1, // 도착 자동 종료(arrived, #2675)
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
function countCalls(source: string, needles: readonly string[]): number {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .reduce((n, line) => n + (needles.some((needle) => line.includes(needle)) ? 1 : 0), 0);
}

describe('sentinel 생산자 전수 — 알림 정책 분류 (PR-3b, #3005 PR-C)', () => {
  const sources: Record<string, string> = {};
  const producerSites: Record<string, number> = {};
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (rel === DEFINITION_FILE) continue;
    const source = fs.readFileSync(file, 'utf8');
    sources[rel] = source;
    const sites = countCalls(source, [SENTINEL_CALL]);
    if (sites > 0) producerSites[rel] = sites;
  }

  it('sentinel을 쓰는 파일·지점 수가 분류표와 정확히 일치한다(신규 생산자는 분류 필수)', () => {
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_PRODUCERS).map(([file, { sites }]) => [file, sites]),
    );
    expect(producerSites).toEqual(expected);
  });

  it('생산 지점 총 2곳(정본 + silent push) — device 자가 종료 4경로는 정본으로 수렴했다', () => {
    const total = Object.values(producerSites).reduce((n, sites) => n + sites, 0);
    expect(total).toBe(2);
  });

  it.each(Object.entries(EXPECTED_PRODUCERS))(
    '%s — 무알림 정책은 사유가 명시돼 있다',
    (_file, { why }) => {
      expect(why.length).toBeGreaterThan(10);
    },
  );

  it('device 자가 종료 호출처가 분류표와 정확히 일치한다(신규 호출처는 분류 필수)', () => {
    const actual = Object.fromEntries(
      Object.entries(sources)
        .filter(([file]) => file !== SEQUENCE_FILE)
        .map(([file, source]) => [file, countCalls(source, [DEVICE_SELF_END_CALL])] as const)
        .filter(([, sites]) => sites > 0),
    );
    expect(actual).toEqual(EXPECTED_SELF_END_CALLERS);
  });

  it.each(Object.entries(EXPECTED_SELF_END_CALLERS))(
    '%s — 호출 지점마다 notifyReason을 넘겨 종료를 알린다(무음 종료 재발 차단)',
    (file, sites) => {
      expect(countCalls(sources[file], [NOTICE_REASON_ARG])).toBeGreaterThanOrEqual(sites);
    },
  );

  it('sentinel 소비 지점(rehydration cycle)은 알림 주체가 아니다 — 소비 분기에서 종료 알림을 부르지 않는다', () => {
    const source = sources['shared/hooks/useStateRehydration.ts'];
    const consumeStart = source.indexOf('async function runRehydrationCycle');
    const lifecycleStart = source.indexOf('async function runLifecycleBackstop');
    expect(consumeStart).toBeGreaterThan(-1);
    expect(lifecycleStart).toBeGreaterThan(consumeStart);
    const consumeBody = source.slice(consumeStart, lifecycleStart);
    // runRehydrationCycle 본문에는 알림 호출이 있어서는 안 된다(소비 + 위임만).
    expect(consumeBody).not.toContain('notifyTripEnded(');
    expect(consumeBody).not.toContain(NOTICE_REASON_ARG);
  });
});
