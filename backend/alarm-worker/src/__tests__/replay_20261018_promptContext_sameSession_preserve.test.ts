/**
 * #3042 — 2026-10-18 same-session 2연발 등록 race 재생.
 *
 * fixture: `capture_20261018T0935Z_b00dd879`(`.fixture-staging/`, 레지스트리 미등록 — fs로 직접
 * 로드한다. `replay_library.full.test.ts`에도 등록하지 않는다. #3038의 자매 fixture와 동일 파일 —
 * 10/18 18:37 군자(능동)→용마산 실라이드의 실측 역/노선 데이터를 그대로 쓴다).
 *
 * root: index.ts same-session merge 분기(:1324 부근)가 backend-authoritative 필드는 전부
 * `existing.*`으로 보존하면서 `promptGeoContext`/`promptDisplay`만 보존 목록에서 빠져
 * `...incoming`으로 흘러간다. device register effect의 cancelled 가드 부재로 같은 세션이 1초 내
 * 2연발 등록될 수 있고(10/18 18:37:30/31 실측), "context 있는 발 → context 없는 발" 순서면
 * 100% 소실한다.
 *
 * 이 재생은 실제 app.fetch(POST /trips)를 2연발(1차 context-ful → 2차 context-null, 같은 token)
 * 호출해 저장본(getTrip)에서 context 생존을 assert한다. fix 전: ②에서 소실(undefined) — red.
 * fix 후: 보존 — green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { app } from '../index';
import { getTrip } from '../trips';
import { findStationCoordsByNameAndLine } from '../stationsLookup';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.fixture-staging',
  'capture_20261018T0935Z_b00dd879.fixture.json',
);

// 레지스트리(parseReplayFixture)를 거치지 않는다 — #3042는 cron tick 재생이 아니라 POST /trips
// 2연발 wiring만 검증하므로, fixture는 "실측 역/노선 데이터가 존재한다"는 전제 확인 + 좌표 소스로만
// 쓴다(fs 직접 로드, 이슈 본문 명시).
function loadFixtureRaw(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
}

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

async function post(path_: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path_}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('#3042 replay — same-session 2연발 등록 (capture_20261018T0935Z_b00dd879)', () => {
  it('1차(context-ful) → 2차(context-null, 같은 token/세션) 등록 후 저장본에 context가 생존한다', async () => {
    // fixture 존재·실측 데이터 전제 확인 — 10/18 실캡처가 실제로 중곡/군자(능동)/7호선을 담고
    // 있어야 이 재생이 "합성이 아니라 실측 기반"이라는 전제가 성립한다.
    const fixture = loadFixtureRaw() as { entries: Array<{ target: string }> };
    expect(fixture.entries.some((e) => e.target === '중곡')).toBe(true);
    expect(fixture.entries.some((e) => e.target === '군자(능동)' || e.target === '용마산')).toBe(
      true,
    );

    const originCoords = findStationCoordsByNameAndLine('군자(능동)', '7');
    const nextCoords = findStationCoordsByNameAndLine('중곡', '7');
    if (originCoords === null || nextCoords === null) {
      throw new Error('fixture 전제 실패 — 군자(능동)/중곡 7호선 좌표 lookup 불가');
    }

    const env = makeEnv(new InMemoryKV());
    const CREATED = 1_792_316_265_471; // fixture.cycleStartsMs[0] — 10/18 18:37 실측 시각대.
    const token = 'tok-3042-replay';
    const tripBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      token,
      route: { type: 'direct', line: '7', stops: 2 },
      destination: '용마산',
      waypoints: [
        { stationName: '중곡', line: '7', kind: 'intermediate' },
        { stationName: '용마산', line: '7', kind: 'destination' },
      ],
      // validateTrip은 expiresAt > Date.now()(실 벽시계)를 요구한다 — fixture 시각(과거)이 아니라
      // 테스트 실행 시점 기준 미래값을 쓴다. createdAt/alarmAtEpochMs는 10/18 실측 시각대 그대로.
      expiresAt: Date.now() + 60 * 60_000,
      alarmAtEpochMs: CREATED,
      createdAt: CREATED,
      ...overrides,
    });
    const promptGeoContext = {
      origin: originCoords,
      nextStation: nextCoords,
      direction: 'up' as const,
    };
    const promptDisplay = { originStation: '군자(능동)', line: '7' };

    // 1차 — 18:37:30 실측 (context-ful)
    const res1 = await post(
      '/trips',
      tripBody({ promptGeoContext, promptDisplay }),
      env,
    );
    expect(res1.status).toBe(200);

    // 2차 — 18:37:31 실측, 같은 token/createdAt(same-session), effect 재실행 선행 run 완주분
    // (context-null)
    const res2 = await post('/trips', tripBody(), env);
    expect(res2.status).toBe(200);

    const stored = await getTrip(env.TRIPS, token);
    expect(stored).not.toBeNull();
    // 실패 사유까지 — 소실되면 undefined로 떨어진다(merge가 `...incoming`만 받았다는 증거).
    expect(stored?.promptGeoContext).toEqual(promptGeoContext);
    expect(stored?.promptDisplay).toEqual(promptDisplay);
  });
});
