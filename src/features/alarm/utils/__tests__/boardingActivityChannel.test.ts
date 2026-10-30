/**
 * #3221 PR-4 — 탑승여부 LA device 채널(`boardingActivityChannel.ts`).
 *
 * 스펙(이슈/plan §4-3·§5-A)만 보고 작성한 테스트다. 구현 모양을 베끼지 않는다.
 */
const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockEndBoardingActivities = jest.fn();
const mockStartBoardingActivity = jest.fn();
const mockRequestToken = jest.fn();
const mockAddTokenListener = jest.fn();
const mockIsLaEnabled = jest.fn();
jest.mock('live-activity', () => ({
  endBoardingActivities: (...a: unknown[]) => mockEndBoardingActivities(...a),
  startBoardingActivity: (...a: unknown[]) => mockStartBoardingActivity(...a),
  requestBoardingPushToStartToken: (...a: unknown[]) => mockRequestToken(...a),
  addBoardingPushToStartTokenListener: (...a: unknown[]) => mockAddTokenListener(...a),
  isLiveActivityEnabled: () => mockIsLaEnabled(),
}));

const mockLogBoardingLaWrite = jest.fn();
jest.mock('../alarmLog', () => ({
  logBoardingLaWrite: (...a: unknown[]) => mockLogBoardingLaWrite(...a),
}));

import { AppState, Platform } from 'react-native';
import * as fs from 'fs';
import * as path from 'path';
import {
  BOARDING_END_WRITER,
  buildBoardingRegisterFields,
  endBoardingActivity,
  readBoardingPushToStartToken,
  resolveBoardingStartMode,
  startBoardingActivityFromPrompt,
  startBoardingPushToStartTokenCapture,
  type BoardingEndReason,
} from '../boardingActivityChannel';
import { BOARDING_PUSH_TO_START_TOKEN_KEY } from '../../../../shared/constants/storageKeys';

const originalOs = Platform.OS;
const originalVersion = Platform.Version;
const originalAppState = AppState.currentState;

function setPlatform(os: string, version: string | number): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
}
function setAppState(state: string): void {
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
}
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  mockEndBoardingActivities.mockResolvedValue(undefined);
  mockStartBoardingActivity.mockResolvedValue(undefined);
  mockRequestToken.mockResolvedValue(null);
  mockAddTokenListener.mockReturnValue({ remove: jest.fn() });
  mockIsLaEnabled.mockReturnValue(true);
  setPlatform('ios', '17.4');
  setAppState('active');
});

afterAll(() => {
  setPlatform(originalOs, originalVersion);
  setAppState(originalAppState);
});

describe('resolveBoardingStartMode — iOS 버전/LA 설정 판정', () => {
  it.each([
    ['17.2', 'push-to-start'],
    ['17.4.1', 'push-to-start'],
    ['18.0', 'push-to-start'],
    ['26.1', 'push-to-start'],
    ['17.1', 'fg-only'],
    ['17.1.2', 'fg-only'],
    ['17.0', 'fg-only'],
    ['16.4', 'none'],
    ['16.2', 'none'],
    ['17', 'fg-only'], // minor 생략
    ['18', 'push-to-start'],
  ])('iOS %s -> %s', (version, expected) => {
    setPlatform('ios', version);
    expect(resolveBoardingStartMode()).toBe(expected);
  });

  it('LA가 꺼져 있으면 버전과 무관하게 none', () => {
    mockIsLaEnabled.mockReturnValue(false);
    expect(resolveBoardingStartMode()).toBe('none');
  });

  it('iOS가 아니면 null (LA 개념 자체가 없다)', () => {
    setPlatform('android', 34);
    expect(resolveBoardingStartMode()).toBeNull();
  });
});

describe('buildBoardingRegisterFields — trip register body 조각', () => {
  it('push-to-start 기기: laClient + 캐시된 token을 싣는다', async () => {
    mockStore.set(BOARDING_PUSH_TO_START_TOKEN_KEY, 'abc123');
    expect(await buildBoardingRegisterFields()).toEqual({
      laClient: { split: true, boardingStart: 'push-to-start' },
      boardingPushToStartToken: 'abc123',
    });
  });

  it('push-to-start 기기라도 token 미발급이면 token 필드는 생략', async () => {
    expect(await buildBoardingRegisterFields()).toEqual({
      laClient: { split: true, boardingStart: 'push-to-start' },
    });
  });

  it('17.0~17.1(fg-only): token이 캐시돼 있어도 보내지 않는다', async () => {
    setPlatform('ios', '17.1');
    mockStore.set(BOARDING_PUSH_TO_START_TOKEN_KEY, 'abc123');
    expect(await buildBoardingRegisterFields()).toEqual({
      laClient: { split: true, boardingStart: 'fg-only' },
    });
  });

  it('16.x: none, token 없음', async () => {
    setPlatform('ios', '16.4');
    expect(await buildBoardingRegisterFields()).toEqual({
      laClient: { split: true, boardingStart: 'none' },
    });
  });

  it('Android: 아무 필드도 싣지 않는다', async () => {
    setPlatform('android', 34);
    expect(await buildBoardingRegisterFields()).toEqual({});
  });
});

describe('push-to-start token 캐시', () => {
  it('readBoardingPushToStartToken: 없으면 null', async () => {
    expect(await readBoardingPushToStartToken()).toBeNull();
  });

  it('capture: 이벤트 token을 캐시하고 값이 바뀐 경우에만 onChange', async () => {
    const onChange = jest.fn();
    let emit: (e: { token: string }) => void = () => undefined;
    const remove = jest.fn();
    mockAddTokenListener.mockImplementation((cb: (e: { token: string }) => void) => {
      emit = cb;
      return { remove };
    });
    const stop = startBoardingPushToStartTokenCapture(onChange);

    emit({ token: 't1' });
    await flush();
    expect(mockStore.get(BOARDING_PUSH_TO_START_TOKEN_KEY)).toBe('t1');
    expect(onChange).toHaveBeenCalledTimes(1);

    emit({ token: 't1' }); // 동일 token 재방출 — 재등록 유발 금지
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);

    emit({ token: 't2' }); // 회전
    await flush();
    expect(mockStore.get(BOARDING_PUSH_TO_START_TOKEN_KEY)).toBe('t2');
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('capture: 시작 시 native 조회 결과도 캐시한다(onChange 없이도 안전)', async () => {
    mockRequestToken.mockResolvedValue('boot-token');
    startBoardingPushToStartTokenCapture();
    await flush();
    expect(mockStore.get(BOARDING_PUSH_TO_START_TOKEN_KEY)).toBe('boot-token');
  });

  it('capture: native 조회가 null/reject여도 throw하지 않고 캐시를 건드리지 않는다', async () => {
    mockStore.set(BOARDING_PUSH_TO_START_TOKEN_KEY, 'keep');
    mockRequestToken.mockRejectedValueOnce(new Error('boom'));
    startBoardingPushToStartTokenCapture();
    await flush();
    mockRequestToken.mockResolvedValueOnce(null);
    startBoardingPushToStartTokenCapture();
    await flush();
    expect(mockStore.get(BOARDING_PUSH_TO_START_TOKEN_KEY)).toBe('keep');
  });

  it('capture: 이벤트 token 캐시(storage write)가 실패해도 throw하지 않고 onChange도 호출하지 않는다', async () => {
    const onChange = jest.fn();
    let emit: (e: { token: string }) => void = () => undefined;
    mockAddTokenListener.mockImplementation((cb: (e: { token: string }) => void) => {
      emit = cb;
      return { remove: jest.fn() };
    });
    const AsyncStorage = jest.requireMock('@react-native-async-storage/async-storage');
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    startBoardingPushToStartTokenCapture(onChange);
    emit({ token: 't-fail' });
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('capture: iOS가 아니면 구독하지 않는다', () => {
    setPlatform('android', 34);
    const stop = startBoardingPushToStartTokenCapture();
    expect(mockAddTokenListener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});

describe('endBoardingActivity — 종료 writer B2/B3/B4', () => {
  const REASONS = Object.keys(BOARDING_END_WRITER) as BoardingEndReason[];

  it('reason -> writer 표', () => {
    expect(BOARDING_END_WRITER).toEqual({
      'intent-response': 'B2',
      'lock-created': 'B3',
      'not-boarded-response': 'B3',
      'hop-end-response': 'B3',
      'trip-cleanup': 'B4',
      'clear-station-notification': 'B4',
      'bg-refresh-dest-absent': 'B4',
    });
  });

  it.each(REASONS)('%s: endBoardingActivities 호출 + writer 로그', async (reason) => {
    await endBoardingActivity(reason);
    expect(mockEndBoardingActivities).toHaveBeenCalledTimes(1);
    expect(mockLogBoardingLaWrite).toHaveBeenCalledWith({
      writer: BOARDING_END_WRITER[reason],
      source: reason,
    });
  });

  it('native end가 reject해도 throw하지 않고(종료 경로를 막지 않는다) 로그는 남긴다', async () => {
    mockEndBoardingActivities.mockRejectedValue(new Error('native down'));
    await expect(endBoardingActivity('trip-cleanup')).resolves.toBeUndefined();
    expect(mockLogBoardingLaWrite).toHaveBeenCalledTimes(1);
  });

  it('iOS가 아니면 no-op', async () => {
    setPlatform('android', 34);
    await endBoardingActivity('trip-cleanup');
    expect(mockEndBoardingActivities).not.toHaveBeenCalled();
    expect(mockLogBoardingLaWrite).not.toHaveBeenCalled();
  });
});

describe('startBoardingActivityFromPrompt — B1 (17.0~17.1 FG 시작)', () => {
  const prompt = {
    originStation: '중곡',
    line: '7',
    tripToken: 'apns-trip-179',
    pushId: 'push-1',
    sentAt: 1_000,
    title: '지금 탑승하셨나요?',
    body: '7호선 중곡',
  };

  it('fg-only + FG: 프롬프트를 BoardingActivityData로 매핑해 시작하고 B1 로그', async () => {
    setPlatform('ios', '17.1');
    await startBoardingActivityFromPrompt(prompt);
    expect(mockStartBoardingActivity).toHaveBeenCalledTimes(1);
    expect(mockStartBoardingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        promptId: 'push-1',
        tripToken: 'apns-trip-179',
        phase: 'pre-boarding',
        originStation: '중곡',
        line: '7',
        lineColorHex: '#747F00',
        title: '지금 탑승하셨나요?',
        body: '7호선 중곡',
      }),
    );
    expect(mockLogBoardingLaWrite).toHaveBeenCalledWith({ writer: 'B1', source: 'fg-start' });
  });

  it('hop-end 프롬프트는 phase=hop-end + nextLine 전달', async () => {
    setPlatform('ios', '17.0');
    await startBoardingActivityFromPrompt({ ...prompt, hopEndKind: 'disembark', nextLine: '2' });
    expect(mockStartBoardingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'hop-end', nextLine: '2' }),
    );
  });

  it('pushId가 없으면 trip+역+sentAt으로 promptId를 만든다(같은 입력=같은 id)', async () => {
    setPlatform('ios', '17.1');
    const { pushId: _omit, ...noPush } = prompt;
    await startBoardingActivityFromPrompt(noPush);
    await startBoardingActivityFromPrompt(noPush);
    const [first] = mockStartBoardingActivity.mock.calls[0];
    const [second] = mockStartBoardingActivity.mock.calls[1];
    expect(first.promptId).toBe(second.promptId);
    expect(first.promptId.length).toBeGreaterThan(0);
  });

  it('title이 없으면 역명으로 대체, 알 수 없는 노선은 중립색', async () => {
    setPlatform('ios', '17.1');
    await startBoardingActivityFromPrompt({
      originStation: '중곡',
      line: 'unknown-line',
      tripToken: 't',
    });
    expect(mockStartBoardingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ title: '중곡', lineColorHex: '#8E8E93', lineName: 'unknown-line' }),
    );
  });

  it.each([
    ['17.2+ (서버 push-to-start가 띄운다 — 기기는 시작하지 않는다)', '17.4', 'active'],
    ['16.x (탑승 LA 없음)', '16.4', 'active'],
    ['fg-only지만 BG (기기는 BG에서 LA 시작 불가)', '17.1', 'background'],
  ])('시작하지 않는다: %s', async (_label, version, appState) => {
    setPlatform('ios', version);
    setAppState(appState);
    await startBoardingActivityFromPrompt(prompt);
    expect(mockStartBoardingActivity).not.toHaveBeenCalled();
    expect(mockLogBoardingLaWrite).not.toHaveBeenCalled();
  });

  it('native start가 reject해도 throw하지 않는다', async () => {
    setPlatform('ios', '17.1');
    mockStartBoardingActivity.mockRejectedValue(new Error('denied'));
    await expect(startBoardingActivityFromPrompt(prompt)).resolves.toBeUndefined();
  });
});

describe('계약(텍스트) — 채널 분리', () => {
  // 주석은 제외하고 코드만 본다(설명 주석이 금지 심볼 이름을 언급할 수 있다).
  const read = (rel: string): string =>
    fs
      .readFileSync(path.join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('탑승 모듈은 ADR-049 권위 게이트(shouldSkipDeviceLiveActivityWrite)나 여정 채널을 import하지 않는다', () => {
    const src = read('../boardingActivityChannel.ts');
    expect(src).not.toMatch(/shouldSkipDeviceLiveActivityWrite/);
    expect(src).not.toMatch(/from\s+['"]\.\/liveActivityPushChannel['"]/);
  });

  it('ambient listener(여정)는 탑승 push-to-start 이벤트를 구독하지 않는다', () => {
    const src = read('../liveActivityPushChannel.ts');
    expect(src).not.toMatch(/addBoardingPushToStartTokenListener/);
    expect(src).not.toMatch(/boardingActivityChannel/);
  });
});
