import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARDING_PROMPT_CATEGORY,
  DISEMBARK_PROMPT_CATEGORY,
  buildApnsJwt,
  buildSilentPushData,
  resetApnsJwtCache,
  sendAlertPush,
  sendBoardingPromptPush,
  sendLiveActivityUpdate,
  sendReschedulePush,
  sendSilentPush,
  sendSleepAlarmCompanionPush,
  sendTripEndedAlertPush,
  type ApnsConfig,
  type SilentPushPayload,
} from '../apns';
import { TRIP_ENDED_ALERT_BODY, TRIP_ENDED_ALERT_TITLE } from '../alertContent';
import { PUSH_CONTRACT_VERSION } from '../../../../src/shared/types/pushContract';

let privateKeyPem = '';

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  // atob exists in Workers / modern Node
  return atob(padded);
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  privateKeyPem = await exportPKCS8(privateKey);
});

const TEST_HOST = 'api.push.apple.com';

function makeConfig(): ApnsConfig {
  return {
    keyId: 'KEY123',
    teamId: 'TEAM456',
    privateKeyPem,
    bundleId: 'com.example.app',
  };
}

describe('buildApnsJwt', () => {
  beforeEach(() => resetApnsJwtCache());

  it('signs JWT with ES256', async () => {
    const token = await buildApnsJwt(makeConfig());
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(base64UrlDecode(parts[0]));
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('KEY123');
  });

  it('caches JWT across calls within TTL', async () => {
    const t1 = await buildApnsJwt(makeConfig(), 1_000_000);
    const t2 = await buildApnsJwt(makeConfig(), 1_000_000 + 60_000);
    expect(t1).toBe(t2);
  });

  it('regenerates after TTL expires', async () => {
    const t1 = await buildApnsJwt(makeConfig(), 1_000_000);
    // 51분 후 → 캐시 무효
    const t2 = await buildApnsJwt(makeConfig(), 1_000_000 + 51 * 60_000);
    expect(t1).not.toBe(t2);
  });
});

describe('sendSilentPush', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts with correct headers and body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('', { status: 200 }),
    );
    const result = await sendSilentPush({
      deviceToken: 'devicetoken-hex',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 60,
        phase: 'early',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'push-uuid-1',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://${TEST_HOST}/3/device/devicetoken-hex`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.data.nextWaypoint).toBe('강남');
    expect(body.data.etaSeconds).toBe(60);
    expect(body.data.phase).toBe('early');
    expect(body.data.kind).toBe('destination');
    expect(body.data.sentAt).toBe(1_700_000_000_000);
    expect(body.data.pushId).toBe('push-uuid-1');
  });

  it('returns failure with reason', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: 'X',
        etaSeconds: 10,
        phase: 'imminent',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.reason).toBe('BadDeviceToken');
  });

  it('handles non-json error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain text', { status: 500 }));
    const result = await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: 'X',
        etaSeconds: 10,
        phase: 'imminent',
        kind: 'destination',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  // Epic #1204 그룹 2 D3 (#1273) — payload.hopIndex wire 검증.
  describe('hopIndex (#1273)', () => {
    it('payload.hopIndex 지정 시 body.data.hopIndex로 전달', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
      await sendSilentPush({
        deviceToken: 'tok',
        payload: {
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
          sentAt: 1_700_000_000_000,
          pushId: 'p',
          hopIndex: 5,
        },
        config: makeConfig(),
        host: TEST_HOST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
      expect(body.data.hopIndex).toBe(5);
    });

    it('payload.hopIndex 미지정 시 body.data에서 누락 (구 client 호환)', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
      await sendSilentPush({
        deviceToken: 'tok',
        payload: {
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
          sentAt: 1_700_000_000_000,
          pushId: 'p',
        },
        config: makeConfig(),
        host: TEST_HOST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
      expect('hopIndex' in body.data).toBe(false);
    });

    it('payload.hopIndex=0 (첫 hop) 도 정상 wire', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
      await sendSilentPush({
        deviceToken: 'tok',
        payload: {
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
          sentAt: 1_700_000_000_000,
          pushId: 'p',
          hopIndex: 0,
        },
        config: makeConfig(),
        host: TEST_HOST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
      expect(body.data.hopIndex).toBe(0);
    });
  });

  // #1307 — payload.subsurface wire 검증 (server-authoritative 지하 flag).
  // true일 때만 wire, false/미지정은 byte-level 호환 위해 omit.
  it.each([
    ['true면 body.data.subsurface로 전달', true, true],
    ['false면 body.data에서 omit (구 client/byte 호환)', false, false],
    ['미지정이면 body.data에서 omit', undefined, false],
  ])('subsurface %s (#1307)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { subsurface: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('subsurface' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.subsurface).toBe(true);
  });

  // #1322 — payload.boardingLine/trainCode wire 검증 (lock-path self-describing fire).
  // 지정 시 wire, 미지정은 byte-level 호환 위해 omit.
  it.each([
    ['지정 시 body.data.boardingLine으로 전달', '7', true],
    ['미지정이면 body.data에서 omit (구 client/backend 호환)', undefined, false],
  ])('boardingLine %s (#1322)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '군자',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'transfer',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { boardingLine: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('boardingLine' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.boardingLine).toBe('7');
  });

  it.each([
    ['지정 시 body.data.trainCode로 전달', '7246', true],
    ['미지정이면 body.data에서 omit', undefined, false],
  ])('trainCode %s (#1322)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '군자',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'transfer',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { trainCode: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('trainCode' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.trainCode).toBe('7246');
  });

  // #1365 — payload.occupiedLine wire 검증 (server-authoritative line, 환승역 cross-validation).
  // 지정 시 wire, 미지정은 byte-level 호환 위해 omit.
  it.each([
    ['지정 시 body.data.occupiedLine으로 전달', '7', true],
    ['미지정이면 body.data에서 omit (구 client/backend 호환)', undefined, false],
  ])('occupiedLine %s (#1365)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '건대입구',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { occupiedLine: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('occupiedLine' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.occupiedLine).toBe('7');
  });

  // #1438 (E5) — payload.lockReleasedReason wire 검증 (backend → device lock release sync).
  // 지정 시 wire, 미지정은 byte-level 호환 위해 omit.
  it.each([
    ['transfer 지정 시 body.data.lockReleasedReason으로 전달', 'transfer' as const, true],
    ['vanish 지정 시 body.data.lockReleasedReason으로 전달', 'vanish' as const, true],
    ['미지정이면 body.data에서 omit (구 client/backend 호환)', undefined, false],
  ])('lockReleasedReason %s (#1438)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '군자',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'transfer',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { lockReleasedReason: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('lockReleasedReason' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.lockReleasedReason).toBe(input);
  });

  // #1539 (S6) — payload.passedStations wire 검증. non-empty 배열만 wire, undefined/빈 배열은 omit.
  it.each([
    ['non-empty 배열은 body.data.passedStations로 전달', ['군자', '중곡'], true],
    ['빈 배열은 omit (구 device 호환)', [], false],
    ['미지정은 omit (구 backend 호환)', undefined, false],
  ])('passedStations %s (#1539)', async (_label, input, expectPresent) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '용마산',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ...(input === undefined ? {} : { passedStations: input }),
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('passedStations' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.passedStations).toEqual(input);
  });

  // #1561 (T8, ADR-017 / S2 #1535 흡수) — payload.ssot wire 검증.
  // ssot이 정의되면 currentStationId/motionState/lastAdvanceEvidence/lastAdvanceAt/passedStations가
  // body.data.ssot으로 그대로 forward. undefined면 omit (구 device 호환).
  it('forwards ssot to body.data.ssot when defined (#1561)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const ssotInput = {
      currentStationId: '강남',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 1_700_000_000_500,
      passedStations: ['교대', '서초'],
    };
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ssot: ssotInput,
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.ssot).toEqual(ssotInput);
    // passedStations은 새 배열로 forward되어 caller mutate가 wire에 영향 주지 않아야.
    expect(body.data.ssot.passedStations).not.toBe(ssotInput.passedStations);
  });

  // #1572 (T9, ADR-017) — payload.ssot.alarmEvents wire 검증. 정의 시만 forward, undefined는 omit.
  it('forwards ssot.alarmEvents to body.data.ssot.alarmEvents when defined (#1572 T9)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const alarmEvents = [
      {
        alarmId: 'abc123',
        stationId: '용마산',
        type: 'station-passed' as const,
        decidedAt: 1_700_000_000_400,
      },
    ];
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '중곡',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ssot: {
          currentStationId: '중곡',
          motionState: 'moving',
          lastAdvanceEvidence: 'arvlcd-confirmed-train',
          lastAdvanceAt: 1_700_000_000_500,
          passedStations: ['용마산'],
          alarmEvents,
        },
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.ssot.alarmEvents).toEqual(alarmEvents);
  });

  // #1705 — currentStationLine wire 검증
  it('forwards ssot.currentStationLine when defined (#1705)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '합정',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ssot: {
          currentStationId: '합정',
          motionState: 'moving',
          lastAdvanceEvidence: 'arvlcd-confirmed-train',
          lastAdvanceAt: 1_700_000_000_500,
          passedStations: [],
          currentStationLine: '2',
        },
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.ssot.currentStationLine).toBe('2');
  });

  it('omits ssot.currentStationLine when undefined (#1705 legacy 호환)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '합정',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ssot: {
          currentStationId: '합정',
          motionState: 'moving',
          lastAdvanceEvidence: 'arvlcd-confirmed-train',
          lastAdvanceAt: 1_700_000_000_500,
          passedStations: [],
        },
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('currentStationLine' in body.data.ssot).toBe(false);
  });

  it('omits ssot.alarmEvents when undefined (#1572 T9 구 device 호환)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        ssot: {
          currentStationId: '강남',
          motionState: 'moving',
          lastAdvanceEvidence: 'arvlcd-confirmed-train',
          lastAdvanceAt: 1_700_000_000_500,
          passedStations: ['교대'],
        },
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('alarmEvents' in body.data.ssot).toBe(false);
  });

  it('omits ssot field when undefined (#1561 구 device 호환)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('ssot' in body.data).toBe(false);
  });

  // #1788 — apns-thread-id 헤더 wire 검증 (sendSilentPush).
  it('tripToken 지정 시 apns-thread-id 헤더로 전달 (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
        tripToken: 'trip-abc',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-thread-id']).toBe('trip-abc');
  });

  it('tripToken 미지정 시 apns-thread-id 헤더 omit (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendSilentPush({
      deviceToken: 'tok',
      payload: {
        nextWaypoint: '강남',
        etaSeconds: 0,
        phase: 'imminent',
        kind: 'intermediate',
        sentAt: 1_700_000_000_000,
        pushId: 'p',
      },
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect('apns-thread-id' in headers).toBe(false);
  });

  it('uses sandbox host when provided', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('', { status: 200 }),
    );
    await sendSilentPush({
      deviceToken: 'tok',
      payload: { nextWaypoint: 'X', etaSeconds: 10, phase: 'early', kind: 'destination', sentAt: 0, pushId: 'p' },
      config: makeConfig(),
      host: 'api.sandbox.push.apple.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.sandbox.push.apple.com/3/device/tok');
  });
});

const TEST_HOST_2 = 'api.push.apple.com';

describe('sendAlertPush (#572 P2c)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts with alert-type headers + aps.alert + data.pushId', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendAlertPush({
      deviceToken: 'devicetoken-hex',
      title: '도착 임박',
      body: '곧 강남에 도착합니다.',
      pushId: 'p-alert-1',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST_2}/3/device/devicetoken-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.alert).toEqual({ title: '도착 임박', body: '곧 강남에 도착합니다.' });
    expect(body.aps.sound).toBe('default');
    expect(body.data.pushId).toBe('p-alert-1');
  });

  it('returns failure with reason on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  it('handles non-json error body', async () => {
    const fetchImpl = vi.fn(async () => new Response('plain text', { status: 500 }));
    const result = await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  // #1788 — apns-thread-id 헤더 wire 검증 (sendAlertPush).
  it('tripToken 지정 시 apns-thread-id 헤더로 전달 (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      tripToken: 'trip-xyz',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-thread-id']).toBe('trip-xyz');
  });

  it('tripToken 미지정 시 apns-thread-id 헤더 omit (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect('apns-thread-id' in headers).toBe(false);
  });

  // #1798 P2 — category 필드 wire 검증.
  it('category 지정 시 aps.category에 전달된다 (#1798)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      category: 'ALARM_CATEGORY',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.category).toBe('ALARM_CATEGORY');
  });

  it('category 미지정 시 aps.category omit (#1798)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendAlertPush({
      deviceToken: 't',
      title: 'T',
      body: 'B',
      pushId: 'p',
      config: makeConfig(),
      host: TEST_HOST_2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('category' in body.aps).toBe(false);
  });

  // #2063 (ADR-023 개정) — 매역 알림(station-notif) 전용 옵션 wire 검증.
  describe('#2063 station-notif 옵션 (sound/interruptionLevel/collapseId/expiration/data)', () => {
    it('sound 미지정 시 기존 default 유지 (backward compat)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.aps.sound).toBe('default');
    });

    it('sound=null 지정 시 aps.sound 필드 자체가 생략된다 (매역 알림 무소리)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        sound: null,
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect('sound' in body.aps).toBe(false);
    });

    it('interruptionLevel 지정 시 aps.interruption-level로 wire', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        interruptionLevel: 'active',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.aps['interruption-level']).toBe('active');
    });

    it('interruptionLevel 미지정 시 aps.interruption-level omit', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect('interruption-level' in body.aps).toBe(false);
    });

    it('collapseId 지정 시 apns-collapse-id 헤더로 wire (station-<tripToken> 형태)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        collapseId: 'station-trip-abc',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = call[1].headers as Record<string, string>;
      expect(headers['apns-collapse-id']).toBe('station-trip-abc');
    });

    it('collapseId 미지정 시 apns-collapse-id 헤더 omit', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = call[1].headers as Record<string, string>;
      expect('apns-collapse-id' in headers).toBe(false);
    });

    it('expirationEpochSec 지정 시 apns-expiration 헤더로 wire (epoch seconds, now+90s)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const now = 1_700_000_000_000;
      const expirationEpochSec = Math.floor((now + 90_000) / 1000);
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        expirationEpochSec,
        config: makeConfig(),
        host: TEST_HOST_2,
        now,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = call[1].headers as Record<string, string>;
      expect(headers['apns-expiration']).toBe(String(expirationEpochSec));
    });

    it('expirationEpochSec 미지정 시 apns-expiration 헤더 omit', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const headers = call[1].headers as Record<string, string>;
      expect('apns-expiration' in headers).toBe(false);
    });

    it('data 지정 시 pushId와 함께 병합돼 wire (SSoT/게이트 필드 forward)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        data: { nextWaypoint: '중곡', kind: 'intermediate', phase: 'imminent' },
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.data).toEqual({
        pushId: 'p',
        nextWaypoint: '중곡',
        kind: 'intermediate',
        phase: 'imminent',
      });
    });

    it('data 미지정 시 data는 { pushId }만 (backward compat)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.data).toEqual({ pushId: 'p' });
    });

    // #2092 — content-available 병기 (SSoT mirror·BG 위젯 채널 복원).
    it('contentAvailable=true 지정 시 aps.alert와 content-available이 동시 wire', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        contentAvailable: true,
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.aps.alert).toEqual({ title: 'T', body: 'B' });
      expect(body.aps['content-available']).toBe(1);
    });

    it('contentAvailable 미지정 시 aps[content-available] 필드 omit (backward compat)', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect('content-available' in body.aps).toBe(false);
    });

    it('contentAvailable=false 지정 시 aps[content-available] 필드 omit', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      await sendAlertPush({
        deviceToken: 't',
        title: 'T',
        body: 'B',
        pushId: 'p',
        contentAvailable: false,
        config: makeConfig(),
        host: TEST_HOST_2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect('content-available' in body.aps).toBe(false);
    });
  });
});

describe('sendReschedulePush (#585)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts background push with reschedule payload', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendReschedulePush({
      deviceToken: 'devicetoken-hex',
      pushId: 'rsch-1',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/devicetoken-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.data).toEqual({
      pushId: 'rsch-1',
      kind: 'reschedule',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
    });
  });

  it('returns failure with reason on non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await sendReschedulePush({
      deviceToken: 't',
      pushId: 'p',
      trainCode: '7',
      nextStation: 'x',
      newArrivalTimeEpoch: 0,
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  // #918 A3 PR4 — channels 옵션 wire 검증.
  it("channels=['bl','tba']이 payload에 그대로 직렬화된다", async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendReschedulePush({
      deviceToken: 'devicetoken-hex',
      pushId: 'rsch-2',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      channels: ['bl', 'tba'],
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.channels).toEqual(['bl', 'tba']);
  });

  it('channels 미지정 시 payload에서 omit (구 backend wire 호환)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendReschedulePush({
      deviceToken: 'devicetoken-hex',
      pushId: 'rsch-3',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('channels' in body.data).toBe(false);
  });

  // #1193 — 중복역 trip의 occurrenceIdx wire 검증.
  it.each([
    ['양의 정수면 payload에 그대로 직렬화', 2, true, 2],
    ['0이면 wire에서 omit (base ID와 동등, byte-level 호환)', 0, false, undefined],
    ['미지정이면 wire에서 omit (구 client/backend 호환)', undefined, false, undefined],
  ])('occurrenceIdx %s', async (_label, input, expectPresent, expectValue) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendReschedulePush({
      deviceToken: 'devicetoken-hex',
      pushId: 'rsch-occ',
      trainCode: '7246',
      nextStation: '중곡',
      newArrivalTimeEpoch: 1_700_000_120_000,
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...(input === undefined ? {} : { occurrenceIdx: input as number }),
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('occurrenceIdx' in body.data).toBe(expectPresent);
    if (expectPresent) expect(body.data.occurrenceIdx).toBe(expectValue);
  });
});

describe('sendLiveActivityUpdate (#586 C)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('posts with LA headers + aps event/content-state (update default priority 10)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendLiveActivityUpdate({
      activityToken: 'activity-token-hex',
      contentState: { nextStation: '강남', etaSeconds: 90 },
      event: 'update',
      timestamp: 1_700_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/activity-token-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-topic']).toBe('com.example.app.push-type.liveactivity');
    expect(headers['apns-push-type']).toBe('liveactivity');
    expect(headers['apns-priority']).toBe('10');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.event).toBe('update');
    expect(body.aps.timestamp).toBe(1_700_000_000);
    expect(body.aps['content-state']).toEqual({ nextStation: '강남', etaSeconds: 90 });
    expect(body.aps['stale-date']).toBeUndefined();
    expect(body.aps['dismissal-date']).toBeUndefined();
  });

  it('includes stale-date and dismissal-date for end event with priority 5', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendLiveActivityUpdate({
      activityToken: 'tok',
      contentState: {},
      event: 'end',
      timestamp: 100,
      staleDate: 200,
      dismissalDate: 300,
      priority: 5,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-priority']).toBe('5');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.event).toBe('end');
    expect(body.aps['stale-date']).toBe(200);
    expect(body.aps['dismissal-date']).toBe(300);
  });

  it('defaults timestamp to now/1000 when omitted', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await sendLiveActivityUpdate({
      activityToken: 'tok',
      contentState: {},
      event: 'update',
      config: makeConfig(),
      host: TEST_HOST,
      now: 1_700_000_123_456,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.timestamp).toBe(1_700_000_123);
  });

  it('returns failure with reason on 410 (token invalid)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const result = await sendLiveActivityUpdate({
      activityToken: 't',
      contentState: {},
      event: 'update',
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 410, reason: 'BadDeviceToken' });
  });
});

describe('sendBoardingPromptPush (#819)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('alert push + category + data payload 송신', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p1',
      title: 'Are you on board?',
      body: '2 · 강남',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
      sentAt: 1234,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/device-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.alert).toEqual({ title: 'Are you on board?', body: '2 · 강남' });
    expect(body.aps.category).toBe(BOARDING_PROMPT_CATEGORY);
    expect(body.aps.sound).toBe('default');
    // #2069 리뷰 P1-1 — B8(로컬 timeSensitive) 제거 후 단일 채널의 Focus/DND 관통 보장.
    expect(body.aps['interruption-level']).toBe('time-sensitive');
    expect(body.data).toEqual({
      pushId: 'p1',
      kind: 'boarding-prompt',
      originStation: '강남',
      line: '2',
      tripToken: 'tok',
      sentAt: 1234,
    });
  });

  it('non-OK 응답은 status/reason을 그대로 반환', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const result = await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p1',
      title: 'T',
      body: 'B',
      originStation: 'O',
      line: 'L',
      tripToken: 't',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 410, reason: 'BadDeviceToken' });
  });

  // #1788 — apns-thread-id 헤더 wire 검증 (sendBoardingPromptPush, tripToken required).
  it('apns-thread-id 헤더에 tripToken이 그대로 전달된다 (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-thread',
      title: 'T',
      body: 'B',
      originStation: 'O',
      line: 'L',
      tripToken: 'trip-boarding-123',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-thread-id']).toBe('trip-boarding-123');
  });

  it.each([['cron' as const], ['instant' as const]])(
    '#1536 (S3) — triggerKind=%s payload.data.triggerKind forward',
    async (triggerKind) => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
      await sendBoardingPromptPush({
        deviceToken: 'device-hex',
        pushId: 'p-trigger',
        title: 'T',
        body: 'B',
        originStation: 'O',
        line: 'L',
        tripToken: 't',
        sentAt: 0,
        triggerKind,
        config: makeConfig(),
        host: TEST_HOST,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.data.triggerKind).toBe(triggerKind);
    },
  );

  // #1798 P3 — subtitle wire 검증.
  it('subtitle 지정 시 aps.alert.subtitle에 전달된다 (#1798)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-sub',
      title: 'T',
      body: 'B',
      originStation: 'O',
      line: '2',
      tripToken: 't',
      sentAt: 0,
      subtitle: '2호선 상행방면',
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.alert.subtitle).toBe('2호선 상행방면');
  });

  it('subtitle 미지정 시 aps.alert.subtitle omit (#1798)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-nosub',
      title: 'T',
      body: 'B',
      originStation: 'O',
      line: '2',
      tripToken: 't',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('subtitle' in body.aps.alert).toBe(false);
  });

  // #2034 — hop-end (환승역 하차) prompt payload 검증.
  it('hopEndKind + nextLine + nextStation 을 payload 로 wire 한다 (#2034)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-hop-end',
      title: '성수에서 하차하셨나요?',
      body: '2호선 성수에서 내려주세요. 다음은 수인분당선 왕십리 방면입니다.',
      originStation: '성수',
      line: '2',
      tripToken: 'trip-hop',
      sentAt: 0,
      hopEndKind: 'disembark',
      nextLine: 'K',
      nextStation: '왕십리',
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.hopEndKind).toBe('disembark');
    expect(body.data.nextLine).toBe('K');
    expect(body.data.nextStation).toBe('왕십리');
    // 기존 필드는 그대로 유지
    expect(body.data.kind).toBe('boarding-prompt');
    expect(body.data.originStation).toBe('성수');
  });

  // #2282 — hop-end(disembark) 질문은 BOARDING_PROMPT 재사용이 아니라 전용 category로 발사돼야
  // iOS가 질문에 맞는 버튼([하차했어요]/[아직이요])을 노출한다.
  it('hopEndKind=disembark 시 DISEMBARK_PROMPT category로 발사 (#2282)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-hop-end-cat',
      title: '성수에서 하차하셨나요?',
      body: '2호선 성수에서 내려주세요.',
      originStation: '성수',
      line: '2',
      tripToken: 'trip-hop',
      sentAt: 0,
      hopEndKind: 'disembark',
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.category).toBe(DISEMBARK_PROMPT_CATEGORY);
    expect(body.aps.category).not.toBe(BOARDING_PROMPT_CATEGORY);
  });

  it('hopEndKind 미지정 시 payload 에서 hop-end 필드 자연 누락 (#2034)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: 'p-legacy',
      title: 'T',
      body: 'B',
      originStation: 'O',
      line: '2',
      tripToken: 't',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('hopEndKind' in body.data).toBe(false);
    expect('nextLine' in body.data).toBe(false);
    expect('nextStation' in body.data).toBe(false);
  });
});

// #1337 — trip-ended를 silent → alert로 전환. killed 앱에 OS banner로 즉시 표시.
// headers/payload는 PR2 디바이스 핸들러와 byte-level 정렬 (kind='trip-ended', tripToken, reason, sentAt, pushId).
describe('sendTripEndedAlertPush (#1337)', () => {
  beforeEach(() => resetApnsJwtCache());

  type TripEndedReason = 'eta-missing' | 'expired' | 'push-unrecoverable' | 'destination-arrived';
  type TripEndedOverrides = Partial<{
    deviceToken: string;
    pushId: string;
    reason: TripEndedReason;
    sentAt: number;
    tripToken: string;
    corrId: string;
  }>;
  const runTripEndedAlertPush = (fetchImpl: ReturnType<typeof vi.fn>, o: TripEndedOverrides = {}) =>
    sendTripEndedAlertPush({
      deviceToken: o.deviceToken ?? 't',
      pushId: o.pushId ?? 'p',
      reason: o.reason ?? 'expired',
      sentAt: o.sentAt ?? 0,
      tripToken: o.tripToken ?? 'trip-x',
      corrId: o.corrId,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

  it('posts alert-type headers + aps.alert(trip-ended 본문, 무소리) + data byte-level contract', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await runTripEndedAlertPush(fetchImpl, {
      deviceToken: 'devicetoken-hex',
      pushId: 'pid-end-1',
      reason: 'destination-arrived',
      sentAt: 1_700_000_000_000,
      tripToken: 'trip-abc',
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/devicetoken-hex`);
    expect(call[1].headers).toMatchObject({
      'apns-topic': 'com.example.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'apns-thread-id': 'trip-abc',
    });
    const body = JSON.parse(call[1].body as string);
    expect(body.aps.alert).toEqual({
      title: TRIP_ENDED_ALERT_TITLE,
      body: TRIP_ENDED_ALERT_BODY,
    });
    // #2069 (Phase 3) — 무소리 배너. sound 필드 자체가 payload에서 생략된다.
    expect('sound' in body.aps).toBe(false);
    expect(body.data).toEqual({
      pushId: 'pid-end-1',
      kind: 'trip-ended',
      tripToken: 'trip-abc',
      reason: 'destination-arrived',
      sentAt: 1_700_000_000_000,
    });
  });

  it.each<{ reason: TripEndedReason }>([
    { reason: 'eta-missing' },
    { reason: 'expired' },
    { reason: 'push-unrecoverable' },
    { reason: 'destination-arrived' },
  ])('reason=$reason 가 data에 그대로 전달된다', async ({ reason }) => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runTripEndedAlertPush(fetchImpl, { reason });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.reason).toBe(reason);
  });

  it('returns parseApnsError result on 4xx with JSON reason', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400 }),
    );
    const result = await runTripEndedAlertPush(fetchImpl, { reason: 'expired' });
    expect(result).toEqual({ ok: false, status: 400, reason: 'BadDeviceToken' });
  });

  it('returns parseApnsError result on 5xx with non-json body (reason undefined)', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream broken', { status: 503 }));
    const result = await runTripEndedAlertPush(fetchImpl, { reason: 'eta-missing' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.reason).toBeUndefined();
  });

  // #1788 — apns-thread-id 헤더 wire 검증 (sendTripEndedAlertPush, tripToken required).
  it('apns-thread-id 헤더에 tripToken이 그대로 전달된다 (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runTripEndedAlertPush(fetchImpl, { tripToken: 'trip-ended-tok' });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-thread-id']).toBe('trip-ended-tok');
  });

  // #2120 — corrId echo (#2114 근본 수리 Phase 2).
  it('corrId 지정 시 data.corrId로 echo된다', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runTripEndedAlertPush(fetchImpl, { corrId: 'corr-xyz' });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.corrId).toBe('corr-xyz');
  });

  it('corrId 미지정 시 data에 corrId 필드 자체가 없다 (구 레코드/legacy 호환)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    await runTripEndedAlertPush(fetchImpl);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('corrId' in body.data).toBe(false);
  });
});

// #2066 (Phase 2-backend) — sleep-alarm-companion silent push. 취침 알람 companion 채널(TTS/진동 보강 + OS 예약 cancel).
// ADR-023: backend는 취침 무관 발사, device가 sleepMode read 후 결정.
describe('sendSleepAlarmCompanionPush (#2066)', () => {
  beforeEach(() => resetApnsJwtCache());

  it('background silent push headers + data payload byte-level contract', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-1',
      originStation: '성수',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: '뚝섬',
      tripToken: 'tok-sta',
      sentAt: 1_700_000_000_000,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`https://${TEST_HOST}/3/device/device-hex`);
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    expect(headers['apns-thread-id']).toBe('tok-sta');
    expect(headers['apns-topic']).toBe('com.example.app');
    const body = JSON.parse(call[1].body as string);
    expect(body.aps).toEqual({ 'content-available': 1 });
    expect(body.data).toEqual({
      kind: 'sleep-alarm-companion',
      originStation: '성수',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: '뚝섬',
      tripToken: 'tok-sta',
      pushId: 'sta-1',
      sentAt: 1_700_000_000_000,
    });
  });

  it('title/body 지정 시 data payload에 forward', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-1',
      originStation: '성수',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: '뚝섬',
      tripToken: 'tok-sta',
      sentAt: 0,
      title: '곧 환승역입니다',
      body: '성수에서 2호선 뚝섬으로 환승',
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.title).toBe('곧 환승역입니다');
    expect(body.data.body).toBe('성수에서 2호선 뚝섬으로 환승');
  });

  it('title/body 미지정 시 data payload에 omit (구 device fallback trigger)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-1',
      originStation: '성수',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: '뚝섬',
      tripToken: 'tok-sta',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect('title' in body.data).toBe(false);
    expect('body' in body.data).toBe(false);
  });

  it('non-OK 응답은 status/reason을 그대로 반환', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 410 }),
    );
    const result = await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-1',
      originStation: 'O',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: 'N',
      tripToken: 't',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: false, status: 410, reason: 'BadDeviceToken' });
  });

  it('5xx non-json body → reason undefined (parseApnsError branch)', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream broken', { status: 503 }));
    const result = await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-1',
      originStation: 'O',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: 'N',
      tripToken: 't',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.reason).toBeUndefined();
  });

  // #1788 — apns-thread-id 헤더로 trip 알림 group.
  it('apns-thread-id 헤더에 tripToken이 그대로 전달된다 (#1788)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendSleepAlarmCompanionPush({
      deviceToken: 'device-hex',
      pushId: 'sta-thread',
      originStation: 'O',
      targetKind: 'transfer',
      nextLine: '2',
      nextStation: 'N',
      tripToken: 'trip-sleep-999',
      sentAt: 0,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers['apns-thread-id']).toBe('trip-sleep-999');
  });
});

// #2243 (ADR-029 Phase 1, G2) — buildSilentPushData 발신 경계 값 스키마 검증.
describe('buildSilentPushData contract skew (#2243, ADR-029 Phase 1 G2)', () => {
  function validPayload(): SilentPushPayload {
    return {
      nextWaypoint: '강남',
      etaSeconds: 60,
      phase: 'early',
      kind: 'destination',
      sentAt: 1_700_000_000_000,
      pushId: 'push-uuid-skew',
    };
  }

  it('정상 payload면 console.warn을 호출하지 않는다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildSilentPushData(validPayload());
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('etaSeconds가 음수면 console.warn(fields=etaSeconds)을 남기지만 data는 그대로 wire한다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = buildSilentPushData({ ...validPayload(), etaSeconds: -5 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fields=etaSeconds'));
    expect(data.etaSeconds).toBe(-5);
    warnSpy.mockRestore();
  });

  it('nextWaypoint가 빈 문자열이면 console.warn(fields=nextWaypoint)을 남긴다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildSilentPushData({ ...validPayload(), nextWaypoint: '' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fields=nextWaypoint'));
    warnSpy.mockRestore();
  });

  it('phase가 SSoT 밖 값이면 console.warn(fields=phase)을 남긴다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildSilentPushData({ ...validPayload(), phase: 'late' as SilentPushPayload['phase'] });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fields=phase'));
    warnSpy.mockRestore();
  });

  it('여러 필드가 동시에 어긋나면 fields 목록에 전부 포함된다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildSilentPushData({
      ...validPayload(),
      nextWaypoint: '',
      etaSeconds: NaN,
      phase: 'late' as SilentPushPayload['phase'],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('fields=nextWaypoint,etaSeconds,phase'),
    );
    warnSpy.mockRestore();
  });
});

// #2253 (ADR-029 Phase 5, G1) — buildSilentPushData가 항상 현재 계약 버전을 stamp한다.
describe('buildSilentPushData contractVersion stamp (#2253, ADR-029 Phase 5 G1)', () => {
  function validPayload(): SilentPushPayload {
    return {
      nextWaypoint: '강남',
      etaSeconds: 60,
      phase: 'early',
      kind: 'destination',
      sentAt: 1_700_000_000_000,
      pushId: 'push-uuid-version',
    };
  }

  it('caller가 contractVersion을 전달하지 않아도 SSoT 현재 값을 stamp한다', () => {
    const data = buildSilentPushData(validPayload());
    expect(data.contractVersion).toBe(PUSH_CONTRACT_VERSION);
  });
});
