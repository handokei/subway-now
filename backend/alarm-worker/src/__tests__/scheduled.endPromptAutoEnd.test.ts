/**
 * #3007 PR-1 — cron 연결: 질문 전달 성공 시에만 `endPromptShownAt` 기록, 질문 +5분 정지면 D1
 * `end-prompt-auto-end-due` 1행(같은 질문 재평가 시 중복 없음), 움직이면 기록 제거. **종료는 PR-3 블록에서(아래 describe).
 *
 * fixture는 합성 — 덤프에 end-prompt 실측이 없다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  createEmptyScheduledStats,
  maybeFireLiveActivityUpdate,
  runScheduled,
  type ScheduledDeps,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { getTrip, putTrip } from '../trips';
import { seedSsot, writeSsot, type MotionEvidence } from '../tripPositionSsot';
import { END_PROMPT_AUTO_END_GRACE_MS, END_PROMPT_STATIONARY_MS } from '../motionState';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const M_PER_DEG_LAT = 111_320;

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    bundleId: 'com.example.app',
    privateKeyPem: await exportPKCS8(privateKey),
  };
  resetApnsJwtCache();
});

function captureEvents(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('trip_events')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function makeEnv(kv: InMemoryKV, db: Env['DB']): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'autoend-tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 60 * 60_000,
    alarmAtEpochMs: NOW - 60_000,
    laClient: { split: true, boardingStart: 'push-to-start', endPromptAutoEnd: true },
    boardingPushToStartToken: 'p2s-token',
    ...overrides,
  } as Trip;
}

/** `to`에서 끝나는 `spanMs` 구간의 같은 좌표 샘플. `lastNorthM`이 있으면 마지막에 그만큼 북쪽 샘플 1개 추가. */
function stationary(to: number, spanMs: number, lastNorthM = 0): MotionEvidence[] {
  const out: MotionEvidence[] = [];
  for (let ts = to - spanMs; ts <= to; ts += 25_000) {
    out.push({ source: 'device-position', ts, signal: { lat: 37.5, lng: 127.0, motion: 'unknown' } });
  }
  if (lastNorthM > 0) {
    out.push({
      source: 'device-position',
      ts: to,
      signal: { lat: 37.5 + lastNorthM / M_PER_DEG_LAT, lng: 127.0, motion: 'unknown' },
    });
  }
  return out;
}

function makeSeoul(now: () => number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
  });
}

async function runAt(kv: InMemoryKV, db: Env['DB'], now: number, apnsStatus = 200): Promise<ReturnType<typeof vi.fn>> {
  const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response('', { status: apnsStatus }));
  await runScheduled(makeEnv(kv, db), {
    seoul: makeSeoul(() => now),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
    generatePushId: () => 'autoend-push',
  } satisfies ScheduledDeps);
  return fetchImpl;
}

async function setup(
  evidence: MotionEvidence[],
  tripOverrides: Partial<Trip> = {},
  lastDeviceSyncAt = NOW,
): Promise<{ kv: InMemoryKV; db: Env['DB']; inserts: unknown[][]; token: string }> {
  const kv = new InMemoryKV();
  const trip = makeTrip(tripOverrides);
  await putTrip(kv as unknown as KVNamespace, trip);
  const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '중곡', { expiresAt: trip.expiresAt });
  ssot.motionEvidence = evidence;
  ssot.lastDeviceSyncAt = lastDeviceSyncAt;
  await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });
  const { db, inserts } = captureEvents();
  return { kv, db, inserts, token: trip.token };
}

const kind = (inserts: unknown[][], k: string) => inserts.filter((a) => a[2] === k);
const readTrip = (kv: InMemoryKV, token: string) => getTrip(kv as unknown as KVNamespace, token);

describe('#3007 PR-1 — endPromptShownAt 기록 (전달 성공 시에만)', () => {
  it('질문 LA start 전달 성공 -> endPromptShownAt = now', async () => {
    const { kv, db, token } = await setup(stationary(NOW, END_PROMPT_STATIONARY_MS));
    await runAt(kv, db, NOW);
    expect((await readTrip(kv, token))?.endPromptShownAt).toBe(NOW);
  });

  it('APNs 실패(sent=false) -> 기록 없음', async () => {
    const { kv, db, inserts, token } = await setup(stationary(NOW, END_PROMPT_STATIONARY_MS));
    await runAt(kv, db, NOW, 500);
    expect(kind(inserts, 'end-prompt-due')).toHaveLength(1); // 판정은 됐지만
    expect((await readTrip(kv, token))?.endPromptShownAt).toBeUndefined(); // 전달 실패 -> 기록 X
  });
});

describe('#3007 PR-1 — 질문 +5분 평가 (계측만)', () => {
  const SHOWN_AT = NOW - END_PROMPT_AUTO_END_GRACE_MS;
  const evidence = () => stationary(NOW, END_PROMPT_STATIONARY_MS + END_PROMPT_AUTO_END_GRACE_MS);

  it('질문 +5분 정지 -> end-prompt-auto-end-due 1행, 종료하지 않는다', async () => {
    const { kv, db, inserts, token } = await setup(evidence(), { endPromptShownAt: SHOWN_AT });
    await runAt(kv, db, NOW);
    const rows = kind(inserts, 'end-prompt-auto-end-due');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0][5] as string)).toMatchObject({
      shownAt: SHOWN_AT,
      graceMs: END_PROMPT_AUTO_END_GRACE_MS,
    });
  });

  it('같은 질문을 다음 tick에 재평가해도 중복 행 없음', async () => {
    const { kv, db, inserts } = await setup(evidence(), { endPromptShownAt: SHOWN_AT });
    await runAt(kv, db, NOW);
    await runAt(kv, db, NOW + 60_000);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(1);
  });

  it('질문 +5분 미만이면 0행', async () => {
    const { kv, db, inserts } = await setup(evidence(), {
      endPromptShownAt: NOW - END_PROMPT_AUTO_END_GRACE_MS + 60_000,
    });
    await runAt(kv, db, NOW);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(0);
  });

  it('질문 후 50m+ 이동 -> 0행 + endPromptShownAt 제거', async () => {
    const { kv, db, inserts, token } = await setup(
      stationary(NOW, END_PROMPT_STATIONARY_MS + END_PROMPT_AUTO_END_GRACE_MS, 120),
      { endPromptShownAt: SHOWN_AT },
    );
    await runAt(kv, db, NOW);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(0);
    expect((await readTrip(kv, token))?.endPromptShownAt).toBeUndefined();
  });

  it('새 질문(shownAt 갱신)은 새 행을 허용한다', async () => {
    const { kv, db, inserts, token } = await setup(evidence(), { endPromptShownAt: SHOWN_AT });
    await runAt(kv, db, NOW);
    const trip = (await readTrip(kv, token))!;
    trip.endPromptShownAt = SHOWN_AT + 1_000;
    await putTrip(kv as unknown as KVNamespace, trip);
    await runAt(kv, db, NOW + 1_000);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(2);
  });

  it('endPromptAutoEnd capability 없는 구버전 앱 trip은 평가하지 않는다 ([계속] 채널 없음)', async () => {
    const { kv, db, inserts } = await setup(evidence(), {
      endPromptShownAt: SHOWN_AT,
      laClient: { split: true, boardingStart: 'push-to-start' },
    });
    await runAt(kv, db, NOW);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(0);
  });

  it('[계속] 응답(endPromptContinuedAt >= shownAt) 후에는 평가하지 않는다', async () => {
    const { kv, db, inserts } = await setup(evidence(), {
      endPromptShownAt: SHOWN_AT,
      endPromptContinuedAt: SHOWN_AT + 30_000,
    });
    await runAt(kv, db, NOW);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(0);
  });

  it('활성 lock trip은 평가하지 않는다', async () => {
    const { kv, db, inserts } = await setup(evidence(), {
      endPromptShownAt: SHOWN_AT,
      boardingLock: {
        trainCode: '7246',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW - 60_000,
        segmentStations: ['중곡', '용마산'],
        expiresAt: NOW + 60 * 60_000,
      } as Trip['boardingLock'],
    });
    await runAt(kv, db, NOW);
    expect(kind(inserts, 'end-prompt-auto-end-due')).toHaveLength(0);
  });
});

describe('#3007 PR-1 — heartbeat(legacy LA update) 경로 기록', () => {
  async function heartbeat(apnsStatus: number): Promise<Trip> {
    const trip = makeTrip({ activityPushToken: 'la-token', activityState: 'live', apnsEnv: 'sandbox' });
    const fetchImpl = vi.fn(async () => new Response('', { status: apnsStatus }));
    const deps = {
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      seoul: makeSeoul(() => NOW),
    } as ScheduledDeps;
    const ssot = await seedSsot(new InMemoryKV() as unknown as KVNamespace, trip.token, '중곡', {
      expiresAt: trip.expiresAt,
    });
    ssot.motionEvidence = stationary(NOW, END_PROMPT_STATIONARY_MS);
    ssot.lastDeviceSyncAt = NOW;
    await maybeFireLiveActivityUpdate(
      trip,
      trip.waypoints[0],
      NOW + 120_000,
      deps,
      createEmptyScheduledStats(NOW),
      NOW,
      () => {},
      ssot,
    );
    return trip;
  }

  it('endPromptDue + LA update 성공 -> endPromptShownAt = now', async () => {
    expect((await heartbeat(200)).endPromptShownAt).toBe(NOW);
  });

  it('LA update 실패 -> 기록 없음', async () => {
    expect((await heartbeat(500)).endPromptShownAt).toBeUndefined();
  });
});

describe('#3007 PR-3 — 질문 +5분 정지 -> 실제 종료', () => {
  const SHOWN_AT = NOW - END_PROMPT_AUTO_END_GRACE_MS;
  const evidence = () => stationary(NOW, END_PROMPT_STATIONARY_MS + END_PROMPT_AUTO_END_GRACE_MS);
  const alertBodies = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? '')).filter((b) => b.includes('trip-ended'));

  it('질문 +5분 정지 -> trip 삭제 + trip-end(end-prompt-timeout/end-prompt-auto-end) 1행 + 종료 alert 1회(무움직임 문구)', async () => {
    const { kv, db, inserts, token } = await setup(evidence(), { endPromptShownAt: SHOWN_AT });
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).toBeNull();
    const ends = kind(inserts, 'trip-end');
    expect(ends).toHaveLength(1);
    const meta = JSON.parse(ends[0][5] as string);
    expect(meta).toMatchObject({ reason: 'end-prompt-timeout', endPath: 'end-prompt-auto-end' });
    const alerts = alertBodies(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('움직임이 없어 안내를 종료했어요');
    // 외부 계약: 클라가 아는 'expired'로 매핑
    expect(alerts[0]).toContain('"reason":"expired"');
    expect(alerts[0]).not.toContain('end-prompt-timeout');
  });

  it('평가~종료 사이 사용자가 DELETE(trip 없음) -> 종료 안내 0, cleanup 0', async () => {
    const { kv, db, inserts, token } = await setup(evidence(), { endPromptShownAt: SHOWN_AT });
    // 평가 시점 getTrip 이후 재조회에서 null이 되도록: 첫 읽기 이후 삭제를 흉내낸다.
    const realGet = kv.get.bind(kv);
    let tripReads = 0;
    vi.spyOn(kv, 'get').mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (key === `trip:${token}`) {
        tripReads += 1;
        if (tripReads >= 2) return null;
      }
      return (realGet as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);
    const f = await runAt(kv, db, NOW);
    expect(kind(inserts, 'trip-end')).toHaveLength(0);
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('[계속] 응답 후에는 종료 0', async () => {
    const { kv, db, inserts, token } = await setup(evidence(), {
      endPromptShownAt: SHOWN_AT,
      endPromptContinuedAt: SHOWN_AT + 30_000,
    });
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
    expect(kind(inserts, 'trip-end')).toHaveLength(0);
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('질문 후 50m+ 이동 -> 종료 0', async () => {
    const { kv, db, inserts, token } = await setup(
      stationary(NOW, END_PROMPT_STATIONARY_MS + END_PROMPT_AUTO_END_GRACE_MS, 120),
      { endPromptShownAt: SHOWN_AT },
    );
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
    expect(alertBodies(f)).toHaveLength(0);
    expect(kind(inserts, 'trip-end')).toHaveLength(0);
  });

  it('capability 없는 구버전 앱 -> 종료 0', async () => {
    const { kv, db, token } = await setup(evidence(), {
      endPromptShownAt: SHOWN_AT,
      laClient: { split: true, boardingStart: 'push-to-start' },
    });
    const f = await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
    expect(alertBodies(f)).toHaveLength(0);
  });

  it('질문 +5분 미만 -> 종료 0', async () => {
    const { kv, db, token } = await setup(evidence(), {
      endPromptShownAt: NOW - END_PROMPT_AUTO_END_GRACE_MS + 60_000,
    });
    await runAt(kv, db, NOW);
    expect(await readTrip(kv, token)).not.toBeNull();
  });
});
