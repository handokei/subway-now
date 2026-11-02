/**
 * #3162 — Swift는 jest로 실행할 수 없으므로, JS가 의존하는 native 계약을 소스 텍스트로 고정한다.
 * (Swift 타입체크는 PR 본문의 xcrun swiftc 검증이 담당 — 여기는 "계약이 지워지지 않았는가"만 본다.)
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const manager = readFileSync(join(IOS_DIR, 'LiveActivityManager.swift'), 'utf8');
const moduleSource = readFileSync(join(IOS_DIR, 'LiveActivityModule.swift'), 'utf8');

describe('LiveActivity native 계약 (#3162)', () => {
  it('시스템/원격 종료(.ended)는 사용자 dismiss로 분류하지 않는다 — dismiss는 .dismissed + 앱이 기대하지 않은 종료만', () => {
    const line = manager.split('\n').find((l) => l.includes('let wasUserDismiss'));
    expect(line).toBeDefined();
    expect(line).toContain('"dismissed"');
    expect(line).toContain('!expectingSystemEnd');
  });

  it('JS 불변식 복구용 requestPushToken AsyncFunction이 노출되고 manager의 현재 토큰 재조회로 연결된다', () => {
    expect(moduleSource.includes('AsyncFunction("requestPushToken")')).toBe(true);
    expect(moduleSource.includes('currentPushTokenHex()')).toBe(true);
    expect(manager.includes('func currentPushTokenHex()')).toBe(true);
  });
});

/**
 * #3221 PR-1 — 탑승 LA(`BoardingActivityAttributes`)를 여정 LA와 **타입으로 격리**하는 계약.
 * Swift는 jest로 실행할 수 없어 소스 텍스트로 고정한다(타입체크는 PR 본문의 xcrun swiftc 결과).
 */
const WIDGET_DIR = join(__dirname, '..', '..', '..', 'targets', 'subway-widget');
const SHARED_DIR = join(WIDGET_DIR, '_shared');
const intents = readFileSync(join(SHARED_DIR, 'BoardingIntents.swift'), 'utf8');
const stripComments = (src: string) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

/** `needle` 선언부터 중괄호 균형이 맞는 블록 끝까지 잘라낸다. */
function extractBlock(src: string, needle: string): string {
  const start = src.indexOf(needle);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block: ${needle}`);
}

describe('탑승 LA 타입 격리 (#3221 PR-1)', () => {
  it('(a) 여정 endAllActivities는 Activity<SubwayActivityAttributes>만 순회하고 탑승 타입을 건드리지 않는다', () => {
    const body = extractBlock(manager, 'private func endAllActivities()');
    expect(body).toContain('Activity<SubwayActivityAttributes>.activities');
    expect(body).not.toContain('BoardingActivityAttributes');
  });

  it('(a2) 여정 manager 전체가 탑승 타입을 참조하지 않는다 — 기존 LiveActivityManager 무변경', () => {
    expect(manager).not.toContain('BoardingActivityAttributes');
  });

  it('(b) 탑승 LA 종료 관측은 onBoardingActivityEnded로만 나가고 여정 dismiss sentinel을 emit하지 않는다', () => {
    const boardingManager = readFileSync(join(IOS_DIR, 'BoardingActivityManager.swift'), 'utf8');
    const code = stripComments(boardingManager);
    expect(code).not.toContain('onActivityDismissed');
    expect(code).not.toContain('emitActivityDismissed');
    expect(code).toContain('onActivityEnded');
    const wiringStart = moduleSource.indexOf('BoardingActivityManager.shared.setEventHandlers');
    expect(wiringStart).toBeGreaterThanOrEqual(0);
    const wiring = moduleSource.slice(
      wiringStart,
      moduleSource.indexOf('BoardingActivityManager.shared.observeActivityUpdates', wiringStart),
    );
    expect(wiring).toContain('"onBoardingPushToStartToken"');
    expect(wiring).toContain('"onBoardingActivityEnded"');
    expect(wiring).not.toContain('"onActivityDismissed"');
    expect(wiring).not.toContain('"onPushToken"');
    expect(moduleSource).toContain('"onBoardingPushToStartToken"');
  });

  it('(b2) 모듈 Events에 탑승 이벤트 2종이 등록되고 기존 5종이 유지된다', () => {
    const eventsLine = moduleSource.split('\n').find((l) => l.includes('Events('));
    expect(eventsLine).toBeDefined();
    for (const name of [
      'onPushToken',
      'onActivityEnded',
      'onActivityDismissed',
      'onActivityEndObserved',
      'onActivityAdopted',
      'onBoardingPushToStartToken',
      'onBoardingActivityEnded',
    ]) {
      expect(eventsLine).toContain(`"${name}"`);
    }
  });

  it('(c) 응답 intent의 낙관 갱신은 Activity<BoardingActivityAttributes>를 end(.immediate)한다', () => {
    const body = extractBlock(intents, 'private func markCurrentActivity(');
    expect(body).toContain('Activity<BoardingActivityAttributes>.activities');
    expect(body).toMatch(/\.end\([^)]*\.immediate\)/);
  });

  it('(c2) 응답 intent 5종 모두 markCurrentActivity를 호출한다(편측 방지)', () => {
    for (const name of [
      'BoardingConfirmIntent',
      'DisembarkConfirmIntent',
      'NotBoardedIntent',
      'DisembarkNotYetIntent',
      'EndTripIntent',
    ]) {
      const body = extractBlock(intents, `struct ${name}:`);
      expect(body).toContain('markCurrentActivity(');
    }
  });

  it('(d) ContinueGuidanceIntent는 네트워크 호출이 0이고 탑승 LA만 닫는다', () => {
    const body = stripComments(extractBlock(intents, 'struct ContinueGuidanceIntent:'));
    expect(body).toContain('LiveActivityIntent');
    expect(body).toContain('Activity<BoardingActivityAttributes>.activities');
    expect(body).not.toContain('URLSession');
    expect(body).not.toContain('URLRequest');
    expect(body).not.toContain('postBoardingConfirm');
    expect(body).not.toContain('postTripEnd');
    expect(body).not.toContain('SubwayActivityAttributes');
  });

  it('(e) BoardingActivityAttributes 사본 2벌이 코드 기준 동일하다(MIRROR)', () => {
    const a = readFileSync(join(IOS_DIR, 'BoardingActivityAttributes.swift'), 'utf8');
    const b = readFileSync(join(SHARED_DIR, 'BoardingActivityAttributes.swift'), 'utf8');
    expect(stripComments(a)).toBe(stripComments(b));
    for (const field of ['promptId', 'tripToken', 'phase', 'originStation', 'lineColorHex', 'title', 'nextLine']) {
      expect(a).toContain(`var ${field}`);
    }
  });

  it('(f) 탑승 Widget이 번들에 등록되고 버튼 3쌍이 Intent로 연결된다', () => {
    const bundle = readFileSync(join(WIDGET_DIR, 'SubwayWidgetBundle.swift'), 'utf8');
    expect(bundle).toContain('BoardingLiveActivityWidget()');
    const widget = readFileSync(join(WIDGET_DIR, 'BoardingLiveActivityWidget.swift'), 'utf8');
    for (const intent of [
      'NotBoardedIntent',
      'BoardingConfirmIntent',
      'DisembarkNotYetIntent',
      'DisembarkConfirmIntent',
      'ContinueGuidanceIntent',
      'EndTripIntent',
    ]) {
      expect(widget).toContain(`${intent}(`);
    }
    expect(widget).toContain('ActivityConfiguration(for: BoardingActivityAttributes.self)');
  });
});

/**
 * #3055 PR-2 — LA 버튼 native 응답 왕복 계약 (plan-2026-11-02-la-button-train-refresh.md §3.3).
 * native(위젯 확장)가 backend 응답을 App Group 엔트리의 `nativePost`로 되돌려 브릿지가 읽는다.
 */
const readWidget = (name: string) => readFileSync(join(WIDGET_DIR, name), 'utf8');
const readPod = (name: string) => readFileSync(join(IOS_DIR, name), 'utf8');

describe('LA 버튼 native 응답 왕복 (#3055 PR-2)', () => {
  const block = (needle: string) => stripComments(extractBlock(intents, needle));

  it('(1) 응답 body에서 resolvedTrainCode·lockState를 파싱해 App Group에 기록한다', () => {
    const post = block('private func postBoardingConfirm(');
    const record = block('private func recordNativePost(');
    expect(post).toContain('resolvedTrainCode');
    expect(post).toContain('lockState');
    expect(post).toContain('recordNativePost(');
    expect(record).toContain('"nativePost"');
    expect(record).toContain('"status"');
    expect(record).toContain('"atMs"');
    expect(record).toContain('defaults.set(');
  });

  it('(2) 기록은 저장 엔트리 id가 자기 id일 때만 — 불일치/삭제된 엔트리는 부활시키지 않는다', () => {
    const record = block('private func recordNativePost(');
    expect(record).toMatch(/storedId\s*==\s*entryId/);
    expect(record).toContain('else { return }');
  });

  it('(2b) 쓰기 시 nativePost "in-flight" 표식 + id를 반환해 응답 기록과 짝을 맞춘다', () => {
    const writePending = block('private func writePendingBoardingIntent(');
    expect(writePending).toContain('"nativePost"');
    expect(writePending).toContain('in-flight');
    expect(writePending).toContain('return id');
  });

  it('(3) body에 source:la-native + laCandidate를 싣고 trainCode 키는 싣지 않는다', () => {
    const post = block('private func postBoardingConfirm(');
    expect(post).toContain('"source"');
    expect(post).toContain('la-native');
    expect(post).toContain('"laCandidate"');
    expect(post).not.toMatch(/"trainCode"\s*:/);
    expect(post).not.toMatch(/\["trainCode"\]/);
  });

  it('(3b) laCandidate는 trainCode·issuedAtMs가 둘 다 있을 때만 만든다 — 없으면 현행 body', () => {
    expect(stripComments(intents)).toMatch(/if let trainCode[^{]*let trainCodeIssuedAtMs/);
  });

  it('(4) 두 위젯이 state.trainCode·state.trainCodeIssuedAtMs를 BoardingConfirmIntent에 넘긴다', () => {
    for (const file of ['BoardingLiveActivityWidget.swift', 'SubwayLiveActivityWidget.swift']) {
      const src = stripComments(readWidget(file));
      const idx = src.indexOf('BoardingConfirmIntent(');
      expect(idx).toBeGreaterThanOrEqual(0);
      const call = src.slice(idx, src.indexOf(')', src.indexOf('trainCodeIssuedAtMs', idx)) + 1);
      expect(call).toContain('trainCode: state.trainCode');
      expect(call).toContain('trainCodeIssuedAtMs: state.trainCodeIssuedAtMs');
    }
  });

  it('(5) 총 10s 마감 경쟁 — URLSession.data와 Task.sleep 중 먼저 끝난 쪽, 마감 시 status 0', () => {
    const post = block('private func postBoardingConfirm(');
    const deadline = block('private func performWithDeadline(');
    expect(deadline).toContain('withTaskGroup');
    expect(deadline).toContain('URLSession.shared.data(for:');
    expect(deadline).toContain('Task.sleep');
    expect(deadline).toContain('group.cancelAll()');
    expect(intents).toMatch(/NATIVE_POST_DEADLINE_SECONDS[^\n]*=\s*10/);
    expect(post).toContain('performWithDeadline(');
  });

  it('(6) Boarding·Disembark 두 intent가 같은 postBoardingConfirm 경로로 id를 넘겨 응답을 기록한다', () => {
    for (const name of ['BoardingConfirmIntent', 'DisembarkConfirmIntent']) {
      const body = stripComments(extractBlock(intents, `struct ${name}:`));
      expect(body).toContain('let entryId = writePendingBoardingIntent(');
      expect(body).toContain('entryId: entryId');
    }
  });

  it('(7) ContentState 미러 4파일에 trainCodeIssuedAtMs가 있고 Boarding에는 trainCode도 있다', () => {
    const boardingFiles = [
      readPod('BoardingActivityAttributes.swift'),
      readFileSync(join(SHARED_DIR, 'BoardingActivityAttributes.swift'), 'utf8'),
    ];
    const subwayFiles = [
      readPod('SubwayActivityAttributes.swift'),
      readFileSync(join(SHARED_DIR, 'SubwayActivityAttributes.swift'), 'utf8'),
    ];
    for (const src of boardingFiles) {
      expect(src).toContain('var trainCode: String?');
      expect(src).toContain('var trainCodeIssuedAtMs: Int?');
    }
    for (const src of subwayFiles) {
      expect(src).toContain('var trainCodeIssuedAtMs: Int?');
    }
  });
});
