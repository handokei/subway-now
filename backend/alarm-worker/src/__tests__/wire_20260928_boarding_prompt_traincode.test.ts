import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sendBoardingPromptPush, type ApnsConfig } from '../apns';
import {
  BOARDING_PROMPT_WIRE_DATA,
  BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE,
  BOARDING_PROMPT_WIRE_FIXTURE,
  BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE,
} from '../../../../src/shared/types/__fixtures__/boardingPromptTrainCodeWireFixture';

/**
 * #2655 — leg-2 trainCode embed(#2820, 이미 머지)의 backend→device wire 계약 replay.
 *
 * 기존 replay는 전부 한쪽만 검증했다:
 *   - backend `apns.test.ts` (#2819) — `sendBoardingPromptPush`가 trainCode를 wire에 싣는지만.
 *   - device `useBoardingPromptResponder.test.ts` (#2819) — 손으로 만든 mock payload가
 *     `extractBoardingPromptPayload`/`tryAutoLock`에서 올바르게 소비되는지만.
 *
 * 이 파일은 공유 fixture(`src/shared/types/__fixtures__/boardingPromptTrainCodeWireFixture.ts`)를
 * SSoT로 삼아 backend가 그 shape을 실제로 wire에 싣는지 검증한다. 짝(device 소비)은
 * `src/features/alarm/__tests__/replay_20260928_leg2_traincode_wire.test.ts`.
 *
 * 두 파일이 같은 fixture 상수를 import하므로, 한쪽이 필드명/구조를 바꾸면(wire drift) 이 fixture를
 * 바꿔야 하고, fixture를 바꾸면 반대쪽 테스트도 함께 깨진다 — 경계를 넘는 단일 계약.
 */
let privateKeyPem = '';

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

describe('#2655 — boarding-prompt trainCode wire 계약 (backend 측)', () => {
  it('BOARDING_PROMPT_WIRE_FIXTURE 발사 시 APNs payload.body가 BOARDING_PROMPT_WIRE_DATA와 정확히 일치한다', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: BOARDING_PROMPT_WIRE_FIXTURE.pushId,
      title: BOARDING_PROMPT_WIRE_FIXTURE.title,
      body: BOARDING_PROMPT_WIRE_FIXTURE.body,
      originStation: BOARDING_PROMPT_WIRE_FIXTURE.originStation,
      line: BOARDING_PROMPT_WIRE_FIXTURE.line,
      tripToken: BOARDING_PROMPT_WIRE_FIXTURE.tripToken,
      sentAt: BOARDING_PROMPT_WIRE_FIXTURE.sentAt,
      trainCode: BOARDING_PROMPT_WIRE_FIXTURE.trainCode,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(call[1].body as string);
    expect(parsed.body).toEqual(BOARDING_PROMPT_WIRE_DATA);
    expect(parsed.body.trainCode).toBe(BOARDING_PROMPT_WIRE_FIXTURE.trainCode);
  });

  it('BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE 발사 시 payload.body에 trainCode 키가 없다', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendBoardingPromptPush({
      deviceToken: 'device-hex',
      pushId: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.pushId,
      title: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.title,
      body: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.body,
      originStation: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.originStation,
      line: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.line,
      tripToken: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.tripToken,
      sentAt: BOARDING_PROMPT_WIRE_FIXTURE_NO_TRAINCODE.sentAt,
      config: makeConfig(),
      host: TEST_HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = JSON.parse(call[1].body as string);
    expect(parsed.body).toEqual(BOARDING_PROMPT_WIRE_DATA_NO_TRAINCODE);
    expect('trainCode' in parsed.body).toBe(false);
  });
});
