/**
 * #3006 D — KV 쓰기 실패가 트립을 죽이지 않게 한다 (관측 + degrade).
 *
 * 2026-10-15 실측: KV 무료 write 쿼터가 바닥나자(`wrangler kv key put` 프로브로 코드 10048 확인)
 * `POST /position` **500 × 63**, `POST /trips` **500 × 9**가 났고 **2시간 넘게 회복이 없었다.**
 * 그 사이 `backend_errors` 테이블은 **0행**이었다 — `captureBackendException`(sentry.ts)이
 * 존재하고 9곳에서 쓰이는데 이 두 핫패스에는 붙어 있지 않고, `app.onError`도 없었다.
 *
 * 500이 특히 치명적인 이유: `/position` 응답의 `lockSuggestion`/`originStationId`는 #1534가
 * **primary transport**로 지정한 경로다(silent push가 OS suspend/kill로 못 와도 이걸로 lock을
 * 인계받는다). 500이면 그 대안 경로까지 함께 죽는다.
 *
 * **에러 문자열 sniffing 금지** — 쿼터 에러의 Worker 런타임 메시지 형태를 확정할 수 없으므로
 * "쿼터인지"를 판별하지 않고 **쓰기 실패 자체**를 실패로 다룬다.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { putTrip } from '../trips';
import { seedSsot } from '../tripPositionSsot';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const TOKEN = 'kvfail-tok';

/** `put`이 항상 throw하는 KV — 쿼터 소진/쓰기 장애 재현. 읽기는 정상. */
class WriteFailingKV extends InMemoryKV {
  override async put(): Promise<void> {
    throw new Error('KV PUT failed: 429 Too Many Requests');
  }
}

/** backend_errors INSERT만 캡처하는 D1 stub. */
function captureErrors(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('backend_errors')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function makeEnv(kv: InMemoryKV, db: Env['DB']): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
  } as unknown as Env;
}

function tripBody(): Record<string, unknown> {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW + 60_000,
    apnsEnv: 'sandbox',
  };
}

/** `/position` payload는 flat 구조다(`index.ts:2107-2123` validator). */
function positionBody(): Record<string, unknown> {
  return {
    token: TOKEN,
    lat: 37.5,
    lng: 127.0,
    accuracy: 10,
    ts: NOW,
    motion: 'unknown',
    appState: 'fg',
  };
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('#3006 D — KV 쓰기 실패 시 graceful degrade + 관측', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(NOW);
  });

  describe('POST /position', () => {
    /** 읽기는 되는 상태(trip+ssot seed 완료)에서 쓰기만 실패시킨다. */
    async function setupReadableWriteFailing(): Promise<{
      env: Env;
      inserts: unknown[][];
    }> {
      const seedKv = new InMemoryKV();
      const trip = tripBody() as unknown as Trip;
      await putTrip(seedKv as unknown as KVNamespace, trip);
      await seedSsot(seedKv as unknown as KVNamespace, TOKEN, '0724', {
        expiresAt: trip.expiresAt,
      });
      // seed된 store를 그대로 물려받되 put만 실패하는 KV로 교체.
      const failing = new WriteFailingKV();
      failing.store = seedKv.store;
      const { db, inserts } = captureErrors();
      return { env: makeEnv(failing, db), inserts };
    }

    it('[red] 쓰기 실패해도 200 + degraded:true (500 금지)', async () => {
      const { env } = await setupReadableWriteFailing();

      const res = await post('/position', positionBody(), env);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, degraded: true });
    });

    it('[red] 쓰기 실패해도 originStationId를 계속 회신한다 (#1534 primary transport 생존)', async () => {
      const { env } = await setupReadableWriteFailing();

      const res = await post('/position', positionBody(), env);

      expect(await res.json()).toMatchObject({ originStationId: '0724' });
    });

    it('[red] 쓰기 실패를 backend_errors에 적재한다 (10/15엔 0행이었다)', async () => {
      const { env, inserts } = await setupReadableWriteFailing();

      await post('/position', positionBody(), env);

      expect(inserts.length).toBeGreaterThanOrEqual(1);
    });

    it('[거부] KV 정상이면 degraded 필드가 없다 (응답 계약 불변)', async () => {
      const kv = new InMemoryKV();
      const trip = tripBody() as unknown as Trip;
      await putTrip(kv as unknown as KVNamespace, trip);
      await seedSsot(kv as unknown as KVNamespace, TOKEN, '0724', {
        expiresAt: trip.expiresAt,
      });
      const { db } = captureErrors();

      const res = await post('/position', positionBody(), makeEnv(kv, db));

      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('degraded');
    });
  });

  describe('POST /trips', () => {
    it('[red] putTrip 실패 시 503 + Retry-After (500 아님 — 재시도 가능한 실패다)', async () => {
      const { db } = captureErrors();
      const env = makeEnv(new WriteFailingKV(), db);

      const res = await post('/trips', tripBody(), env);

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });

    it('[red] putTrip 실패를 backend_errors에 적재한다', async () => {
      const { db, inserts } = captureErrors();
      const env = makeEnv(new WriteFailingKV(), db);

      await post('/trips', tripBody(), env);

      expect(inserts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('app.onError (모든 라우트 공통 관측 backstop)', () => {
    it('[red] uncaught 에러를 backend_errors에 적재하고 500은 그대로 유지한다', async () => {
      const { db, inserts } = captureErrors();
      // `/boarding-lock/sync`는 KV 읽기/쓰기를 모두 쓰는 라우트 — get 자체를 터뜨려
      // 핸들러가 잡지 않는 uncaught 경로를 만든다.
      const kv = new InMemoryKV();
      vi.spyOn(kv, 'get').mockRejectedValue(new Error('boom-uncaught'));
      const env = makeEnv(kv, db);

      const res = await post(
        '/boarding-lock/sync',
        { token: TOKEN, observedStationName: '용마산', observedAtMs: NOW, accuracy: 5 },
        env,
      );

      // 동작 불변 — 분류 불가한 에러는 계속 500이다(이 PR은 관측만 추가한다).
      expect(res.status).toBe(500);
      expect(inserts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
