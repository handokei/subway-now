/**
 * #2308 PR-2 — POST /trips는 진행 위치(progress)의 작성자가 아니다.
 *
 * 같은 세션 재등록은 progress를 읽지도, trip.waypoints에 적용하지도, 지우지도 않는다(lock·lockless 모두).
 * 세션 경계(다른 trainCode / route reset)에서만 지운다. 새 세션 register가 세션 노선 원본(routeWaypoints)을 1회 채우고
 * 같은 세션 merge는 보존한다.
 *
 * 실패 사유까지 단언한다: KV spy로 "progress 키를 읽었는가/지웠는가"를 직접 본다.
 */
import { describe, expect, it, vi } from 'vitest';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import { app } from '../index';
import { progressKey, type TripProgress } from '../progress';
import { waypointSignatureKey } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

const TOKEN = 'tok-2308';
const SESSION_CREATED = 1_700_000_000_000;
const HOUR_MS = 60 * 60_000;

const lock = (trainCode: string) => ({
  trainCode,
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: SESSION_CREATED,
  segmentStations: ['강남구청', '학동', '논현'],
  expiresAt: Date.now() + HOUR_MS,
});

const ROUTE_NAMES = ['청담', '강남구청', '학동', '논현'];
const fullRoute = (): Waypoint[] =>
  ROUTE_NAMES.map((stationName, i) => ({
    stationName,
    line: '7',
    kind: i === ROUTE_NAMES.length - 1 ? 'destination' : 'intermediate',
  }));

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: 4 },
    destination: '논현',
    waypoints: fullRoute(),
    expiresAt: Date.now() + 3 * HOUR_MS,
    alarmAtEpochMs: Date.now(),
    createdAt: SESSION_CREATED,
    boardingLock: lock('T1'),
    ...overrides,
  };
}

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: 'api.push.apple.com',
    APNS_HOST_SANDBOX: 'api.sandbox.push.apple.com',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

async function post(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const res = await app.fetch(
    new Request('http://example.com/trips', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env,
  );
  // register는 b1 resolver를 waitUntil(미await)로 띄운다 — 다음 요청 전에 정착시킨다.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

const readTrip = async (kv: InMemoryKV): Promise<Trip> => JSON.parse((await kv.get(`trip:${TOKEN}`)) as string) as Trip;
const names = (waypoints: Waypoint[]) => waypoints.map((w) => w.stationName);

/** backend가 앞으로 진행한 상태: 청담·강남구청 소비 후 head=학동. progress도 같은 head. */
async function seedAdvanced(kv: InMemoryKV, progressPatch: Partial<TripProgress> = {}): Promise<void> {
  const env = makeEnv(kv);
  await post(env, body());
  const stored = await readTrip(kv);
  await kv.put(`trip:${TOKEN}`, JSON.stringify({ ...stored, waypoints: stored.waypoints.slice(2) }));
  const progress: TripProgress = {
    trainCode: 'T1',
    shiftedCount: 2,
    headKey: waypointSignatureKey(stored.waypoints[2]),
    lastTrackedArrivalEpoch: 12345,
    lastLaPushEpoch: 67890,
    consecutiveEtaMissing: 2,
    ...progressPatch,
  };
  await kv.put(progressKey(TOKEN), JSON.stringify(progress));
}

/** progress 키에 대한 KV 접근을 가로챈다. */
function spyProgressAccess(kv: InMemoryKV) {
  const progressKeyName = progressKey(TOKEN);
  const getSpy = vi.spyOn(kv, 'get');
  const deleteSpy = vi.spyOn(kv, 'delete');
  const putSpy = vi.spyOn(kv, 'put');
  return {
    reads: () => getSpy.mock.calls.filter(([key]) => key === progressKeyName).length,
    deletes: () => deleteSpy.mock.calls.filter(([key]) => key === progressKeyName).length,
    writes: () => putSpy.mock.calls.filter(([key]) => key === progressKeyName).length,
  };
}

describe('POST /trips — 같은 세션 재등록은 progress를 읽지도·적용하지도·지우지도 않는다 (#2308)', () => {
  it('lock 실은 재등록: waypoints는 existing 그대로(학동부터), progress 키 읽기 0 / 삭제 0 / 쓰기 0, progress 값 보존', async () => {
    const kv = new InMemoryKV();
    await seedAdvanced(kv);
    const before = await kv.get(progressKey(TOKEN));
    const access = spyProgressAccess(kv);
    const res = await post(makeEnv(kv), body());
    expect(res.status).toBe(200);
    expect(names((await readTrip(kv)).waypoints)).toEqual(['학동', '논현']);
    expect({ reads: access.reads(), deletes: access.deletes(), writes: access.writes() }).toEqual({ reads: 0, deletes: 0, writes: 0 });
    expect(await kv.get(progressKey(TOKEN))).toBe(before);
  });

  it('lock 없는 재등록(existing lock 이어받음): 예전에는 progress가 지워졌다 — 이제 보존', async () => {
    const kv = new InMemoryKV();
    await seedAdvanced(kv);
    const access = spyProgressAccess(kv);
    await post(makeEnv(kv), body({ boardingLock: undefined }));
    const trip = await readTrip(kv);
    expect(trip.boardingLock?.trainCode).toBe('T1');
    expect(access.deletes()).toBe(0);
    expect(await kv.get(progressKey(TOKEN))).not.toBeNull();
  });

  it('11/02 앞쪽 점프: incoming을 배열 위치로 다시 매기면 progress hopIndex가 우연히 다른 역에 맞아도 waypoints는 움직이지 않는다', async () => {
    const kv = new InMemoryKV();
    await seedAdvanced(kv, { headHopIndex: 2 }); // 옛 형식 값 — 예전 코드는 incoming[2](=학동)이 아니라 hop 일치로 slice
    await post(makeEnv(kv), body({ waypoints: fullRoute().slice(1) })); // [강남구청, 학동, 논현] — hop 0,1,2로 재매김
    expect(names((await readTrip(kv)).waypoints)).toEqual(['학동', '논현']);
  });

  it('lockless 재등록(infoModeEnabled): lockless progress가 있어도 적용·삭제하지 않는다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    await post(env, body({ boardingLock: undefined, infoModeEnabled: true }));
    const stored = await readTrip(kv);
    await kv.put(`trip:${TOKEN}`, JSON.stringify({ ...stored, waypoints: stored.waypoints.slice(2) }));
    await kv.put(progressKey(TOKEN), JSON.stringify({ lockless: true, shiftedCount: 2, headHopIndex: 2 }));
    const access = spyProgressAccess(kv);
    await post(env, body({ boardingLock: undefined, infoModeEnabled: true, waypoints: fullRoute().slice(1) }));
    expect(names((await readTrip(kv)).waypoints)).toEqual(['학동', '논현']);
    expect({ reads: access.reads(), deletes: access.deletes() }).toEqual({ reads: 0, deletes: 0 });
  });
});

describe('POST /trips — 세션 경계에서만 progress를 지운다 (#2308)', () => {
  it('다른 trainCode(새 세션) 재등록: progress 삭제', async () => {
    const kv = new InMemoryKV();
    await seedAdvanced(kv);
    await post(makeEnv(kv), body({ boardingLock: lock('OTHER') }));
    expect(await kv.get(progressKey(TOKEN))).toBeNull();
    expect(names((await readTrip(kv)).waypoints)).toEqual(ROUTE_NAMES);
  });

  it('archFlag on에서 진짜 다른 route(route reset): progress 삭제 — 옛 headKey가 새 route의 같은 키를 잘못 자르지 않게', async () => {
    const kv = new InMemoryKV();
    await kv.put(ARCH_FLAG_KV_KEY, 'on');
    await seedAdvanced(kv);
    const otherRoute = [
      { stationName: '학동', line: '7', kind: 'intermediate' },
      { stationName: '건대입구', line: '7', kind: 'destination' },
    ];
    await post(makeEnv(kv), body({ destination: '건대입구', waypoints: otherRoute }));
    expect(await kv.get(progressKey(TOKEN))).toBeNull();
  });
});

describe('POST /trips — routeWaypoints(세션 노선 원본) (#2308)', () => {
  it('새 세션 register가 검증된 incoming waypoints를 routeWaypoints로 1회 채운다', async () => {
    const kv = new InMemoryKV();
    await post(makeEnv(kv), body());
    const trip = await readTrip(kv);
    expect(names(trip.routeWaypoints ?? [])).toEqual(ROUTE_NAMES);
  });

  it('같은 세션 재등록은 existing.routeWaypoints를 보존한다 (incoming이 잘라 보내도 원본 유지)', async () => {
    const kv = new InMemoryKV();
    await post(makeEnv(kv), body());
    await post(makeEnv(kv), body({ waypoints: fullRoute().slice(2) }));
    expect(names((await readTrip(kv)).routeWaypoints ?? [])).toEqual(ROUTE_NAMES);
  });

  it('routeWaypoints 없는 구 trip(배포 전 등록)은 existing.waypoints로 채운다', async () => {
    const kv = new InMemoryKV();
    await post(makeEnv(kv), body());
    const stored = await readTrip(kv);
    const { routeWaypoints: _legacy, ...legacy } = stored;
    await kv.put(`trip:${TOKEN}`, JSON.stringify({ ...legacy, waypoints: stored.waypoints.slice(1) }));
    await post(makeEnv(kv), body());
    expect(names((await readTrip(kv)).routeWaypoints ?? [])).toEqual(['강남구청', '학동', '논현']);
  });

  it('다른 세션으로 교체되면 routeWaypoints도 새 incoming으로 교체된다', async () => {
    const kv = new InMemoryKV();
    await post(makeEnv(kv), body());
    await post(makeEnv(kv), body({ boardingLock: lock('OTHER'), waypoints: fullRoute().slice(2) }));
    expect(names((await readTrip(kv)).routeWaypoints ?? [])).toEqual(['학동', '논현']);
  });
});
