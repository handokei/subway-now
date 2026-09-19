import { syncBoardingLock } from '../boardingLockSync';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  globalThis.fetch = jest.fn();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('syncBoardingLock (#901)', () => {
  const basePayload = {
    token: 'tok',
    observedStationName: '강남',
    observedAtMs: 1000,
    accuracy: 10,
  };

  it('URL 미설정 → skipped=true, fetch 미호출', async () => {
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({ ok: false, skipped: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('정상 200 — body parse 후 currentWaypoint/nextStation/advanced 반환', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          advanced: true,
          currentWaypoint: '역삼',
          nextStation: '역삼',
        }),
    });
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({
      ok: true,
      status: 200,
      advanced: true,
      currentWaypoint: '역삼',
      nextStation: '역삼',
    });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test.dev/boarding-lock/sync');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(basePayload);
  });

  // #2352 — 구 #915/#916 autoLockCandidate 응답 필드는 backend에서 삭제됐다. 응답에 있어도
  // (구버전 backend 잔존/캐시) client가 forward하지 않는지 확인 — 무탭 hydrate 채널 완전 제거.
  it('#2352 — 응답에 autoLockCandidate가 있어도 forward하지 않음', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          advanced: false,
          currentWaypoint: '역삼',
          nextStation: '역삼',
          autoLockCandidate: { trainCode: '7246', line: '2', subwayId: '1002' },
        }),
    });
    const r = await syncBoardingLock(basePayload);
    expect(r).not.toHaveProperty('autoLockCandidate');
  });

  it('subsurface 옵션 필드 forward', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, advanced: false, currentWaypoint: '강남' }),
    });
    await syncBoardingLock({ ...basePayload, subsurface: false });
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).subsurface).toBe(false);
  });

  // D4 (#1210) — 환승 leg trainCode + 노선 동봉 정확성. payload extra 분기만 다르고 검증
  // 셰이프는 동일하므로 1 시나리오 1 케이스로 일괄 검증.
  it.each<{
    label: string;
    payloadExtra: Record<string, string>;
    expectedPresent: Record<string, string>;
    expectedAbsent: ReadonlyArray<string>;
  }>([
    {
      label: 'trainCode + boardingLine 제공 → body에 그대로 포함',
      payloadExtra: { trainCode: 'T-2', boardingLine: '2' },
      expectedPresent: { trainCode: 'T-2', boardingLine: '2' },
      expectedAbsent: [],
    },
    {
      label: 'trainCode/boardingLine 미제공 → body에 키 미포함 (구버전 backend 호환)',
      payloadExtra: {},
      expectedPresent: {},
      expectedAbsent: ['trainCode', 'boardingLine'],
    },
  ])('#1210 — $label', async ({ payloadExtra, expectedPresent, expectedAbsent }) => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
    await syncBoardingLock({ ...basePayload, ...payloadExtra });
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(init.body);
    for (const [k, v] of Object.entries(expectedPresent)) {
      expect(parsed[k]).toBe(v);
    }
    for (const k of expectedAbsent) {
      expect(parsed).not.toHaveProperty(k);
    }
  });

  it('non-OK status → ok=false + status', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 });
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({ ok: false, status: 404 });
  });

  it('fetch reject → ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({ ok: false });
  });

  it('200이지만 json parse 실패 → fallback null 값 반환', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('bad json')),
    });
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({
      ok: true,
      status: 200,
      advanced: false,
      currentWaypoint: null,
      nextStation: null,
    });
  });

  it('200이지만 응답 필드 누락 → defaults (false / null / null)', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    const r = await syncBoardingLock(basePayload);
    expect(r).toEqual({
      ok: true,
      status: 200,
      advanced: false,
      currentWaypoint: null,
      nextStation: null,
    });
  });

  it('trailing slash trim', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
    await syncBoardingLock(basePayload);
    const [url] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.test.dev/boarding-lock/sync');
  });

  it('타임아웃 — abort 후 ok=false', async () => {
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    (globalThis.fetch as jest.Mock).mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    jest.useFakeTimers();
    const promise = syncBoardingLock(basePayload);
    jest.advanceTimersByTime(6000);
    const r = await promise;
    expect(r).toEqual({ ok: false });
    jest.useRealTimers();
  });
});
