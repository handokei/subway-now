/**
 * #3221 PR-3b — boarding-confirm `laCandidate` 판정 (계획 tasks/plan-2026-11-02-la-button-train-refresh.md §3.2 v5/v6).
 *
 * 사용자 결정(2026-11-02): LA 버튼은 "LA에 보이는 열차"(laCandidate)를 우선 확정한다. 검증은 prompt_fires 최신 발사 +
 * 도착확정 + leg anchor + 진행도 가드 + 3분 창. laCandidate 없는 요청은 현행 100%.
 * 11/02 19:54:57 실측(D1 trip_events 1995~1998): 탭 12s 전 발사 열차 7320 -> lock 7320.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import { inferLegDirection } from '../legDirection';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_793_616_897_000; // 2026-11-02 19:54:57 KST
const ANCHOR = '건대입구';
const WINDOW_MS = 3 * 60_000;

function makeEnv(db?: Env['DB']): Env {
  return {
    TRIPS: new InMemoryKV() as unknown as Env['TRIPS'],
    ...(db ? { DB: db } : {}),
    APNS_HOST: 'a',
    APNS_HOST_SANDBOX: 'a',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  } as Env;
}

async function post(body: unknown, env: Env): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request('http://example.com/trips/tok-la/boarding-confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** leg-2 trip (건대입구 환승 직후, lock 없음). 구간: 건대입구 > 어린이대공원 > 군자 > 중곡. */
function leg2Trip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'tok-la',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '중곡',
    waypoints: [
      { stationName: '어린이대공원', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'intermediate' },
      { stationName: '중곡', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    alarmAtEpochMs: NOW + 30 * 60_000,
    createdAt: NOW - 60 * 60_000,
    infoModeEnabled: true,
    promptDisplay: { originStation: '뚝섬유원지', line: '7' },
    currentLegAnchor: { boardingStation: ANCHOR, line: '7' },
    legBoardingEligibleAt: NOW - 30_000,
    ...overrides,
  };
}

interface FireRow {
  train_code: string | null;
  issued_at: number;
  decision: string;
}

function makeDb(fire: FireRow | null | 'throw') {
  const inserts: unknown[][] = [];
  let fireReads = 0;
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('INSERT INTO trip_events')) inserts.push(args);
      return {
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockImplementation(async () => {
          if (!sql.includes('FROM prompt_fires')) return null;
          fireReads += 1;
          if (fire === 'throw') throw new Error('d1 down');
          return fire;
        }),
      };
    },
  }));
  return {
    db: { prepare } as unknown as Env['DB'],
    fireReads: () => fireReads,
    confirmMeta: () => {
      const rows = inserts.filter((a) => a[2] === 'boarding-confirm-result');
      expect(rows).toHaveLength(1);
      return JSON.parse(rows[0][5] as string) as Record<string, unknown>;
    },
  };
}

const isUp = inferLegDirection('7', ANCHOR, '어린이대공원') === 'up';

function recptnDtFor(ms: number): string {
  return new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Seoul realtimePosition live 응답 (탭 시점 live 해소용). */
function livePositions(entries: { trainNo: string; statnNm: string; trainSttus?: number }[]): Response {
  return new Response(
    JSON.stringify({
      realtimePositionList: entries.map((e) => ({
        trainNo: e.trainNo,
        statnNm: e.statnNm,
        trainSttus: e.trainSttus ?? 1,
        updnLine: isUp ? '0' : '1',
        recptnDt: recptnDtFor(NOW),
        lastRecptnDt: recptnDtFor(NOW).slice(0, 10).replace(/-/g, ''),
      })),
    }),
    { status: 200 },
  );
}

/** cron이 이미 폴링한 노선 캐시(realtime-position:7) 스냅샷. */
async function putSnapshot(env: Env, trainCode: string, stationName: string): Promise<void> {
  await env.TRIPS.put(
    'realtime-position:7',
    JSON.stringify({
      fetchedAt: NOW - 10_000,
      positions: [{ trainCode, stationName, trainSttus: 1, isUp, recptnMs: NOW - 10_000 }],
    }),
  );
}

function body(candidate: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) {
  return {
    action: 'boarded',
    station: ANCHOR,
    line: '7호선', // 탑승 LA는 정식 노선명을 보낸다(line 정규화 #3276)
    source: 'la-native',
    ...(candidate ? { laCandidate: candidate } : {}),
    ...over,
  };
}

async function storedLock(env: Env): Promise<{ trainCode: string } | undefined> {
  return (JSON.parse((await env.TRIPS.get('trip:tok-la')) as string) as { boardingLock?: { trainCode: string } })
    .boardingLock;
}

describe('boarding-confirm laCandidate 판정 (#3221 PR-3b)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchSpy = vi.fn().mockResolvedValue(livePositions([]));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(fire: FireRow | null | 'throw', trip = leg2Trip()) {
    const d = makeDb(fire);
    const env = makeEnv(d.db);
    await env.TRIPS.put('trip:tok-la', JSON.stringify(trip));
    return { env, ...d };
  }

  const cand = (issuedAgoMs: number, trainCode = '7320') => ({ trainCode, issuedAtMs: NOW - issuedAgoMs });
  const fire = (issuedAgoMs: number, trainCode: string | null = '7320', decision = 'imminent'): FireRow => ({
    train_code: trainCode,
    issued_at: NOW - issuedAgoMs,
    decision,
  });

  describe('3분 창 내 (accepted-trusted)', () => {
    it('11/02 실측: 발사 12s 후 탭, 최신 발사=후보 7320 -> 7320 lock, live 미실행, resolveTier 없음', async () => {
      const t = await setup(fire(12_000));
      // live가 다른 열차(7321)를 보여도 후보가 우선이어야 한다.
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));

      const { status, json } = await post(body(cand(12_000)), t.env);

      expect(status).toBe(200);
      expect(json).toEqual({ ok: true, lockState: 'leg2', resolvedTrainCode: '7320' });
      expect((await storedLock(t.env))?.trainCode).toBe('7320');
      expect(fetchSpy).not.toHaveBeenCalled();
      const meta = t.confirmMeta();
      expect(meta).toMatchObject({ laCandidateDecision: 'accepted-trusted', source: 'la-native', lockState: 'leg2' });
      expect(meta).not.toHaveProperty('resolveTier');
      expect(meta).not.toHaveProperty('liveOutcome');
      expect(meta).not.toHaveProperty('outcome');
    });

    it('더 새 발사(7321)가 prompt_fires 최신 -> 옛 후보 거부(stale-newer-prompt), 현행 live가 7321 lock', async () => {
      const t = await setup(fire(60_000, '7321'));
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));

      const { json } = await post(body(cand(120_000, '7320')), t.env);

      expect(json).toMatchObject({ lockState: 'leg2', resolvedTrainCode: '7321' });
      expect(fetchSpy).toHaveBeenCalled();
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'stale-newer-prompt', outcome: 'resolved' });
    });

    it('최신 발사가 도착확정 아님(fallback-unobservable) -> not-arrival-confirmed, live none이면 lock 없음', async () => {
      const t = await setup(fire(12_000, '7320', 'fallback-unobservable'));
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(await storedLock(t.env)).toBeUndefined();
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'not-arrival-confirmed' });
    });

    it('position-confirmed 발사도 도착확정으로 수용', async () => {
      const t = await setup(fire(12_000, '7320', 'position-confirmed'));
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
    });

    it('탭 anchor != 현재 leg anchor -> leg-mismatch (후보 미사용)', async () => {
      const t = await setup(fire(12_000));
      const { json } = await post(body(cand(12_000), { station: '어린이대공원' }), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'leg-mismatch' });
    });

    it('prompt_fires 행 없음 -> no-fire-record (fail-closed)', async () => {
      const t = await setup(null);
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'no-fire-record' });
    });

    it('prompt_fires 읽기 실패 -> no-fire-record, 현행 live 경로 (잘못된 lock 금지)', async () => {
      const t = await setup('throw');
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7321' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'no-fire-record' });
    });

    it('최신 행 trainCode/issuedAt가 후보와 다르면(같은 시각 다른 열차) 후보 미사용', async () => {
      const t = await setup({ train_code: '7999', issued_at: NOW - 12_000, decision: 'imminent' });
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
    });
  });

  describe('진행도 가드 (p)', () => {
    it('스냅샷에서 후보 열차가 anchor +2역(군자) -> progressed-past-anchor 거부, live로', async () => {
      const t = await setup(fire(12_000));
      await putSnapshot(t.env, '7320', '군자');
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'progressed-past-anchor' });
    });

    it('anchor +1역(어린이대공원)이면 수용', async () => {
      const t = await setup(fire(12_000));
      await putSnapshot(t.env, '7320', '어린이대공원');
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'accepted-trusted' });
    });

    it('구간 밖(앵커 이전 뚝섬유원지) 위치 + 앵커 출발 기록 없음 -> 아직 안 지나갔으므로 수용', async () => {
      const t = await setup(fire(12_000));
      await putSnapshot(t.env, '7320', '뚝섬유원지');
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
    });

    it('구간 밖 위치 + 앵커 출발 기록 있음 -> 이미 구간 끝을 넘어선 열차, progressed-past-anchor 거부', async () => {
      const t = await setup(fire(12_000));
      await t.env.TRIPS.put(
        'realtime-position:7',
        JSON.stringify({
          fetchedAt: NOW - 10_000,
          positions: [{ trainCode: '7320', stationName: '중곡다음역', trainSttus: 1, isUp, recptnMs: NOW - 10_000 }],
          stationLogs: { [ANCHOR]: { present: [], departed: [{ trainCode: '7320', isUp, departedAt: NOW - 120_000 }] } },
        }),
      );
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'progressed-past-anchor' });
    });

    it('스냅샷 없음은 수용 (11/02 실측 케이스와 동일)', async () => {
      const t = await setup(fire(12_000));
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
    });

    it('창 밖 fallback(4분)에도 +2역이면 거부, live none이면 lock 없음', async () => {
      const t = await setup(fire(4 * 60_000));
      await putSnapshot(t.env, '7320', '군자');
      const { json } = await post(body(cand(4 * 60_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'progressed-past-anchor' });
    });
  });

  describe('3분 초과 (live 우선)', () => {
    it('4분 + live가 정확히 1대(7321) 해소 -> live 7321, window-expired-live, laCandidateAgrees=false', async () => {
      const t = await setup(fire(WINDOW_MS + 60_000));
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));
      const { json } = await post(body(cand(WINDOW_MS + 60_000)), t.env);
      expect(json).toMatchObject({ lockState: 'leg2', resolvedTrainCode: '7321' });
      expect(t.confirmMeta()).toMatchObject({
        laCandidateDecision: 'window-expired-live',
        laCandidateAgrees: false,
        outcome: 'resolved',
      });
    });

    it('4분 + live가 후보와 같은 열차 -> laCandidateAgrees=true', async () => {
      const t = await setup(fire(WINDOW_MS + 60_000));
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7320', statnNm: ANCHOR }]));
      const { json } = await post(body(cand(WINDOW_MS + 60_000)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'window-expired-live', laCandidateAgrees: true });
    });

    it('4분 + live none -> 후보 7320 채택(window-expired-candidate), liveOutcome=none, resolveTier 없음', async () => {
      const t = await setup(fire(WINDOW_MS + 60_000));
      const { json } = await post(body(cand(WINDOW_MS + 60_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'leg2', resolvedTrainCode: '7320' });
      expect((await storedLock(t.env))?.trainCode).toBe('7320');
      expect(fetchSpy).toHaveBeenCalled();
      const meta = t.confirmMeta();
      expect(meta).toMatchObject({ laCandidateDecision: 'window-expired-candidate', liveOutcome: 'none' });
      expect(meta).not.toHaveProperty('outcome');
      expect(meta).not.toHaveProperty('resolveTier');
    });

    it('16분 + live none -> 만료(expired), lock 없음', async () => {
      const t = await setup(fire(16 * 60_000));
      const { json } = await post(body(cand(16 * 60_000)), t.env);
      expect(json).toEqual({ ok: true, lockState: 'none' });
      expect(await storedLock(t.env)).toBeUndefined();
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'expired' });
    });

    it('후보 채택 시 응답 resolveTier는 생략된다', async () => {
      const t = await setup(fire(WINDOW_MS + 1));
      const { json } = await post(body(cand(WINDOW_MS + 1)), t.env);
      expect(json).not.toHaveProperty('resolveTier');
    });

    it('정확히 3분(경계 포함)은 신뢰 창 안', async () => {
      const t = await setup(fire(WINDOW_MS));
      const { json } = await post(body(cand(WINDOW_MS)), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'accepted-trusted' });
    });
  });

  describe('기존 lock / stamp 승격 생략', () => {
    const existingLock = {
      trainCode: '9999',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW - 60_000,
      segmentStations: [ANCHOR, '어린이대공원'],
      expiresAt: NOW + 60 * 60_000,
    };

    it('탭 시점 lock이 이미 있고 유지 판정이면 기존 lock 반환, existing-lock, prompt_fires 미조회', async () => {
      // leg-1(currentLegAnchor 없음) -> decideLegLockReleaseForBoardedTap='no-anchor' -> 유지
      const t = await setup(
        fire(12_000),
        leg2Trip({ currentLegAnchor: undefined, legBoardingEligibleAt: undefined, boardingLock: existingLock }),
      );
      const { json } = await post(body(cand(12_000)), t.env);
      expect(json).toMatchObject({ lockState: 'leg1', resolvedTrainCode: '9999' });
      expect((await storedLock(t.env))?.trainCode).toBe('9999');
      expect(t.fireReads()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'existing-lock' });
    });

    it('stamp-valid release 조건 + laCandidate: promoteStampedTrainCode를 건너뛰고 후보 판정', async () => {
      const trip = leg2Trip({
        boardingLock: { ...existingLock, trainCode: '5559', segmentStations: ['중곡', '군자'] },
      });
      const stampTrip = {
        ...trip,
        legBoardingFireStamp: {
          boardingStation: ANCHOR,
          line: '7',
          trainCode: '9000',
          destination: '중곡',
          waypointKeys: (trip.waypoints as { stationName: string; line: string; kind: string }[]).map(
            (w) => `${w.stationName}|${w.line}|${w.kind}|0`,
          ),
          firedAt: NOW - 1000,
        },
      };
      const t = await setup(fire(12_000), stampTrip);
      const { json } = await post(body(cand(12_000)), t.env);
      // stamp(9000)로 승격되지 않고 보이는 열차 7320으로 lock.
      expect(json).toMatchObject({ resolvedTrainCode: '7320' });
      expect(t.confirmMeta()).toMatchObject({ laCandidateDecision: 'accepted-trusted' });
    });
  });

  describe('laCandidate 없는 요청은 현행 100%', () => {
    it('알림 경로(laCandidate 없음): prompt_fires 미조회, laCandidateDecision 없음, live 결과 그대로', async () => {
      const t = await setup(fire(12_000));
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));
      const { json } = await post(body(undefined, { source: 'notification' }), t.env);
      expect(json).toMatchObject({ resolvedTrainCode: '7321' });
      expect(t.fireReads()).toBe(0);
      expect(t.confirmMeta()).not.toHaveProperty('laCandidateDecision');
    });

    it.each([
      ['x'],
      [5],
      [null],
      [{ trainCode: '', issuedAtMs: 1 }],
      [{ trainCode: '7320' }],
      [{ trainCode: '7320', issuedAtMs: 'a' }],
    ])('형식 불량 laCandidate(%j)는 무시 -> 현행 경로, 400 아님', async (bad) => {
      const t = await setup(fire(12_000));
      fetchSpy.mockResolvedValue(livePositions([{ trainNo: '7321', statnNm: ANCHOR }]));
      const { status, json } = await post(body(undefined, { laCandidate: bad }), t.env);
      expect(status).toBe(200);
      expect(json).toMatchObject({ resolvedTrainCode: '7321' });
      expect(t.fireReads()).toBe(0);
      expect(t.confirmMeta()).not.toHaveProperty('laCandidateDecision');
    });

    it('not-boarded 는 laCandidate가 있어도 판정하지 않는다', async () => {
      const t = await setup(fire(12_000));
      await post({ action: 'not-boarded', station: ANCHOR, line: '7', laCandidate: cand(12_000) }, t.env);
      expect(t.fireReads()).toBe(0);
    });
  });
});
