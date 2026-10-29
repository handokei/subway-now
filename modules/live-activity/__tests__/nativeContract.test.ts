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
    const wiring = extractBlock(moduleSource, 'BoardingActivityManager.shared.setEventHandlers');
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
