/**
 * S12 (#2907) — "트립이 사라진 뒤 device 재등록이 조용히 죽지 않아야 한다" 판정 테스트.
 *
 * 10/7 아침 사고 후반부:
 *   06:48:31  backend가 trip을 destination-arrived로 종료
 *   06:50:10  boarding-confirm 404 (x2, 06:53:01도)
 *   06:50:13 / 06:50:29 / 06:51:01 / 06:52:03  POST /trips 400 (x4) — 거부 사유 미확정
 *   06:52:55  lifecycle-backstop trip-dead-pull-detected → "안내 종료" 알림
 *
 * 이슈 가설: `empty-waypoints`(로컬 route 소진으로 waypoints가 빈 배열) 때문에
 * validateTrip이 거부했을 것이다.
 *
 * 본 파일의 판정: 그 가설은 **거짓**이다. 디바이스가 POST /trips에 도달하는 유일한
 * 경로(`useApnsTripRegistration.ts`의 `registerFromLatestInputs` → `callRegister` →
 * `registerActiveTrip`)는 `!route || !destination`이면 네트워크 호출 자체를 내지 않고
 * 로컬 teardown만 수행한다(POST 자체가 안 나감). 그리고 `route`가 non-null인 한
 * `routeToWaypoints`(모든 route type)는 항상 최소 1개(destination) waypoint를 반환하므로
 * `waypoints: []`는 이 경로에서 구조적으로 생성될 수 없다 — `empty-waypoints` reject는
 * validateTrip에 여전히 존재하지만(테스트 존재), 디바이스의 실제 재등록 경로에서는
 * **도달 불가능한 데드 코드**다.
 *
 * 실제 메커니즘은 validateTrip이 아니라 그 *뒤*에 있는 `#1425 trip-recently-ended` 쿨다운
 * (`index.ts:953~`, 이미 `index.test.ts:6044` describe 블록으로 포괄 검증됨)이다 — 같은
 * token이 `TRIP_STATUS_RETENTION_MS`(1시간, `tripStatus.ts:45`) 내에 (seoul-outage 제외)
 * 어떤 이유로든 종료됐으면, **payload가 완전히 유효해도(waypoints 비지 않음)** 재등록이
 * 400으로 거부된다. 10/7 트립은 06:48:31 destination-arrived로 종료됐고, 재시도는
 * +1:42/+1:58/+2:30/+3:32 뒤 — 전부 1시간 retention 안이다.
 */
import { describe, expect, it } from 'vitest';
import { app, validateTrip } from '../index';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...overrides,
  };
}

function makeKvEnv(): Env {
  return makeEnv({ TRIPS: new InMemoryKV() as unknown as Env['TRIPS'] });
}

async function post(path: string, body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

function seedTripEnded(
  env: Env,
  token: string,
  endedAt: number,
  endReason: 'expired' | 'eta-missing' | 'seoul-outage' | 'destination' | 'push-unrecoverable',
): void {
  const kv = env.TRIPS as unknown as InMemoryKV;
  kv.store.set(`tripStatus:${token}`, {
    value: JSON.stringify({ endedAt, endReason }),
  });
}

const FUTURE = Date.now() + 60 * 60 * 1000;

/**
 * 10/7 실측과 같은 shape — 환승 1회, 중간 정거장 여러 개를 포함하는 "정상적으로 진행
 * 중인" 트립 payload. `empty-waypoints`를 falsify하려면 waypoints가 비어있지 않은
 * 완전히 유효한 payload로도 재현 가능해야 한다.
 */
function fullyValidInFlightPayload(tokenSuffix: string): Record<string, unknown> {
  return {
    token: `tok-${tokenSuffix}`,
    route: { type: 'transfer', fromLine: '2', toLine: '6', transferName: '신당' },
    destination: 'dst',
    waypoints: [
      { stationName: '동대문역사문화공원', line: '2', kind: 'intermediate' },
      { stationName: '신당', line: '2', kind: 'transfer' },
      { stationName: '청구', line: '6', kind: 'intermediate' },
      { stationName: '약수', line: '6', kind: 'destination' },
    ],
    expiresAt: FUTURE,
    alarmAtEpochMs: FUTURE - 30 * 60 * 1000,
  };
}

// 주의(범위): `src/features/route/utils/routeWaypoints.ts`(device, React Native 앱)의
// `routeToWaypoints`는 route type(direct/transfer/multiTransfer) 전부에서 항상 최소 1개
// (destination) waypoint를 push하도록 구현돼 있다 — 이 사실은 코드 읽기로 확인했지만
// backend/alarm-worker 패키지는 별도 vitest/rollup 설정이라 frontend 모듈을 직접
// import해 실행할 수 없다(JSX/Flow 문법 비호환, cross-package 경계). 따라서 이 판정은
// 본 파일에서 실행 가능한 테스트로 승격하지 않고 PR 본문에 file:line 인용으로 기록한다
// (routeWaypoints.ts:47-111 각 build* 함수가 조건 없이 destination waypoint를 push).
describe('S12 (#2907) — validateTrip의 empty-waypoints 게이트 자체는 여전히 존재하지만(회귀 아님), 디바이스 재등록 경로와 무관', () => {
  it('waypoints:[]를 명시적으로 보내면 여전히 거부된다 (프로덕션 미수정, 기존 게이트 보존 확인)', () => {
    const rejected = validateTrip({
      token: 'tok',
      route: { type: 'direct', line: '2', stops: 3 },
      destination: 'dst',
      waypoints: [],
      expiresAt: FUTURE,
      alarmAtEpochMs: FUTURE - 1000,
    });
    expect(rejected).toBeNull();
  });

  it('하지만 route가 완전히 유효한 in-flight payload(10/7 케이스 shape)는 waypoints가 절대 비지 않으므로 validateTrip을 통과한다', () => {
    const accepted = validateTrip(fullyValidInFlightPayload('red1'));
    expect(accepted).not.toBeNull();
    expect(accepted?.waypoints.length).toBeGreaterThan(0);
  });
});

describe('S12 (#2907) — 10/7 아침 재구성: 실제 거부 메커니즘은 validateTrip이 아니라 #1425 trip-recently-ended 쿨다운', () => {
  // 10/7 실측 간격 — backend trip 종료(06:48:31) 뒤 재시도까지 경과한 시간
  // (06:50:13/06:50:29/06:51:01/06:52:03 각각 +102s/+118s/+150s/+212s). validateTrip의
  // expiresAt 검사는 실 Date.now() 기준이라, "트립이 N초 전에 끝났다"는 사실만 과거
  // anchor(`Date.now() - offsetMs`)로 재현하고 payload의 expiresAt/alarmAtEpochMs는 항상
  // 실 Date.now() 기준 미래로 둔다 — 이렇게 해야 10/7 간격 재현과 "payload 자체는 완전히
  // 유효함"이라는 전제가 동시에 성립한다.
  const retryOffsetsMs = [102_000, 118_000, 150_000, 212_000];

  it.each(retryOffsetsMs)(
    '+%dms 재시도 — waypoints가 가득 찬 완전히 유효한 payload도 destination-arrived 쿨다운(1h) 안이면 400으로 거부된다',
    async (offsetMs) => {
      const env = makeKvEnv();
      // backend는 destination-arrived를 외부 contract 'destination'으로 저장한다 (tripStatus.ts:toTripStatusEndReason).
      seedTripEnded(env, 'tok-s12', Date.now() - offsetMs, 'destination');

      const res = await post('/trips', fullyValidInFlightPayload('s12'), env);

      expect(res.status).toBe(400);
      // #1425 경로는 validateTrip과 달리 reason을 응답 body에 실제로 노출한다 — invalid_trip과
      // 대비되는 지점 (스펙 2 부분 충족, 아래 describe에서 invalid_trip과 직접 대조).
      expect(await res.json()).toEqual({
        error: 'trip-recently-ended',
        reason: 'destination',
      });
      // 거부된 재시도는 트립을 되살리지 않는다 — auto-revive 차단 확인 (기존 index.test.ts와 동일 불변식).
      expect(await env.TRIPS.get('trip:tok-s12')).toBeNull();
    },
  );

  it('동일 payload라도 쿨다운 마커가 없으면(즉, cooldown이 유일한 변수) 200으로 성공한다 — empty-waypoints가 거부 원인이 아님을 대조 확인', async () => {
    const env = makeKvEnv();
    // seedTripEnded 호출 없음 — tripStatus 마커 부재.
    const res = await post('/trips', fullyValidInFlightPayload('s12-control'), env);
    expect(res.status).toBe(200);
    expect(await env.TRIPS.get('trip:tok-s12-control')).not.toBeNull();
  });

  it('1시간 retention이 지나면 같은 payload가 성공한다 (쿨다운 경계 재확인)', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'tok-s12-late', Date.now() - (60 * 60 * 1000 + 1_000), 'destination');

    const res = await post('/trips', fullyValidInFlightPayload('s12-late'), env);
    expect(res.status).toBe(200);
  });
});

describe('S12 (#2907) — boarding-confirm 404도 재시도 가능성을 device에 알려주지 않는다 (trip_not_found, 추가 정보 없음)', () => {
  it('종료된 trip에 boarding-confirm하면 404 + {error: trip_not_found}만 반환 — endReason/재시도 가이드 없음', async () => {
    const env = makeKvEnv();
    // trip:tok 자체가 없음 (이미 cleanup되어 KV에서 제거됨) — 10/7 상황과 동일.
    const res = await app.fetch(
      new Request('http://example.com/trips/tok-s12-confirm/boarding-confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'boarded', station: '약수', line: '6' }),
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'trip_not_found' });
  });
});

describe('S12 (#2907) — 거부 사유 전달 범위: #1425 쿨다운은 reason을 주지만, validateTrip 구조 거부는 안 준다', () => {
  it('validateTrip 구조 거부(예: empty-waypoints)는 reason 필드가 응답에 없다 — device가 재시도/포기/재생성을 분기할 수 없다', async () => {
    const env = makeKvEnv();
    const res = await post(
      '/trips',
      {
        token: 'tok-structural',
        route: { type: 'direct', line: '2', stops: 3 },
        destination: 'dst',
        waypoints: [],
        expiresAt: FUTURE,
        alarmAtEpochMs: FUTURE - 1000,
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'invalid_trip' });
    expect(body.reason).toBeUndefined();
  });

  it('반면 #1425 쿨다운 거부는 reason(endReason)을 포함한다 — 단, device가 이 reason으로 무엇을 해야 하는지(재시도 금지/새 trip 생성)는 어디에도 명시돼 있지 않다 (관측 갭)', async () => {
    const env = makeKvEnv();
    seedTripEnded(env, 'tok-cooldown', Date.now() - 5_000, 'destination');
    const res = await post('/trips', { ...fullyValidInFlightPayload('cooldown'), token: 'tok-cooldown' }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('trip-recently-ended');
    expect(body.reason).toBe('destination');
  });
});
