/**
 * #3221 PR-3 — 탑승 LA push-to-start 발사 + 매역 DI 축소 표시. 10/28 아침 trip 179 실측 replay.
 *
 * 입력은 불변 실측 — `fixtures/replayLibrary/capture_20261028_trip179_morning_7035.fixture.json`
 * (R2 `seoul-capture` 원문). 통과시키려 조정 금지. seed는 lock이 아니라 **탑승 전(pre-boarding)** 이고(질문 사슬을 타야
 * 하므로), 사용자 응답은 D1 `boarding-confirm-result`/`lock-attached` 실측 시각에 `beforeTick`으로 주입한다:
 *   06:27:55 [탑승] 7035 / 06:36:51 [안 탔어요] / 06:42:21 3013 lock(D1은 sync 승격, 여기선 boarded 탭으로 주입).
 *
 * 질문 발사 tick(replay): 06:27:46 탑승 / 06:35:46 환승 하차(hop-end) / 06:36:46 leg-2 탑승 / 06:41:49 재질문
 * (D1 실발사 06:27:45 / 06:35:45.7 / 06:36:45 / 06:41:48.5 — replay tick은 캡처 exec lag만큼 늦다).
 *
 * 계약(plan §8 PR-3 / §13):
 *  - split(`laClient.split` + `boardingPushToStartToken`) trip: 질문마다 탑승 LA push-to-start 1건, 여정 LA push에 질문 필드 0,
 *    start가 나가면 일반 알림 무음(#3146 기준 "start 2xx").
 *  - split trip의 intermediate 매역은 일반 alert 0 + 여정 LA 무음 update(arrivedStationName). transfer/destination은 일반 alert 유지.
 *  - 비split trip은 현행 byte 동일 — 변경 전 코드로 계산한 push 전수 해시로 고정한다.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { stationNotifCollapseId } from '../collapseId';
import { parseReplayFixture } from '../replayFixture';
import type { Trip } from '../types';
import { runCaptureReplay, type CapturedPush, type ReplayRunResult } from './helpers/replayHarness';
import {
  makeRide20261028MorningPreBoardingTrip,
  RIDE_20261028_BOARDING_START_TOKEN,
} from './helpers/ride20261028Trips';

const KST_OFFSET_MS = 9 * 3600_000;
const FIXTURE = 'capture_20261028_trip179_morning_7035.fixture.json';
const TRIP_TOKEN = 'replay-20261028-start';

/** 06:27:55 / 06:36:51 / 06:42:21 응답 — 각 응답 직후 첫 tick 직전에 주입한다. */
const RESPONSES = [
  { at: '06:27:56', body: { action: 'boarded', station: '용마산', line: '7', trainCode: '7035' } },
  { at: '06:36:52', body: { action: 'not-boarded', station: '건대입구', line: '2' } },
  { at: '06:42:22', body: { action: 'boarded', station: '건대입구', line: '2', trainCode: '3013' } },
] as const;

function kstOf(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);
}

async function replay(split: boolean, mutateTrip?: (trip: Trip) => void): Promise<ReplayRunResult> {
  const fixture = parseReplayFixture(
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'replayLibrary', FIXTURE), 'utf8')),
  );
  const done = new Set<string>();
  const seed = makeRide20261028MorningPreBoardingTrip(TRIP_TOKEN, fixture.window.fromMs, { split });
  mutateTrip?.(seed);
  return runCaptureReplay({
    fixture,
    seedTrips: [seed],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env }) => {
      for (const { at, body } of RESPONSES) {
        if (kstOf(tick) < at || done.has(at)) continue;
        done.add(at);
        const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
        try {
          const res = await app.fetch(
            new Request(`http://example.com/trips/${TRIP_TOKEN}/boarding-confirm`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
            env,
          );
          expect(res.status).toBe(200);
        } finally {
          spy.mockRestore();
        }
      }
    },
  });
}

interface Aps {
  event?: string;
  sound?: string;
  alert?: { title?: string; body?: string; sound?: string };
  attributes?: { promptId?: string; tripToken?: string };
  'attributes-type'?: string;
  'content-state'?: Record<string, unknown>;
}
const apsOf = (push: CapturedPush): Aps => (push.body.aps ?? {}) as Aps;

const starts = (r: ReplayRunResult) => r.pushes.filter((p) => apsOf(p).event === 'start');
const journeyUpdates = (r: ReplayRunResult) => r.pushes.filter((p) => p.url.endsWith('/la-token'));
/** 일반 alert(apns-push-type alert) 중 collapse-id가 prefix로 시작하는 것. */
const alertsWith = (r: ReplayRunResult, prefix: string) =>
  r.pushes.filter((p) => p.headers.pushType === 'alert' && (p.headers.collapseId ?? '').startsWith(prefix));

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INTERMEDIATE_STATIONS = ['중곡', '군자(능동)', '어린이대공원(세종대)'];

describe('#3221 PR-3 — split trip: 탑승 LA push-to-start (trip 179 실측 replay)', () => {
  it('질문 4건(탑승 06:27:46 / 환승 하차 06:35:46 / leg-2 탑승 06:36:46 / 재질문 06:41:49)마다 start가 각 1건, 대상은 push-to-start token', async () => {
    const result = await replay(true);
    const sent = starts(result);
    expect(sent.map((p) => [kstOf(p.simNowMs), apsOf(p)['content-state']?.phase])).toEqual([
      ['06:27:46', 'pre-boarding'],
      ['06:35:46', 'hop-end'],
      ['06:36:46', 'pre-boarding'],
      ['06:41:49', 'pre-boarding'],
    ]);
    for (const push of sent) {
      expect(push.url.endsWith(`/${RIDE_20261028_BOARDING_START_TOKEN}`)).toBe(true);
      expect(push.headers.pushType).toBe('liveactivity');
      const aps = apsOf(push);
      expect(aps['attributes-type']).toBe('BoardingActivityAttributes');
      expect(aps.attributes?.tripToken).toBe(TRIP_TOKEN);
      expect(aps.alert?.title).toBeTruthy();
      expect(aps.alert?.sound).toBeDefined();
    }
    // 재질문은 새 promptId — 같은 id면 기기가 중복 시작을 no-op 처리해 재질문이 사라진다.
    const promptIds = sent.map((p) => apsOf(p).attributes?.promptId);
    expect(new Set(promptIds).size).toBe(promptIds.length);
  });

  it('탑승 start content-state: phase별 질문 문구와 노선/역이 실린다 (leg-1 용마산 7호선, 하차 건대입구 -> 2호선, leg-2 건대입구 2호선)', async () => {
    const result = await replay(true);
    const states = starts(result).map((p) => apsOf(p)['content-state'] ?? {});
    expect(states.map((s) => [s.phase, s.originStation, s.lineName])).toEqual([
      ['pre-boarding', '용마산', '7호선'],
      ['hop-end', '건대입구', '7호선'],
      ['pre-boarding', '건대입구', '2호선'],
      ['pre-boarding', '건대입구', '2호선'],
    ]);
    expect(states[0].title).toBe('탑승하셨나요?');
    expect(states[1].nextLine).toBe('2호선');
    for (const s of states) {
      expect(s.lineColorHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(typeof s.title).toBe('string');
    }
  });

  it('여정 LA push(update)에는 질문 필드(boarding*)와 alert가 한 건도 없다', async () => {
    const result = await replay(true);
    const updates = journeyUpdates(result);
    expect(updates.length).toBeGreaterThan(0);
    for (const push of updates) {
      const keys = Object.keys(apsOf(push)['content-state'] ?? {}).filter((k) => k.startsWith('boarding'));
      expect(keys).toEqual([]);
      expect(apsOf(push).alert).toBeUndefined();
    }
  });

  it('start가 나간 질문의 일반 알림은 무음(aps.sound 없음) — 이중 울림 0 (#3146 기준 "start 2xx")', async () => {
    const result = await replay(true);
    const promptAlerts = [
      ...alertsWith(result, 'boarding-prompt-'),
      // hop-end 질문 알림은 collapse-id가 없어 payload(`body` 키 — expo-notifications 규약)의 hopEndKind로 식별한다.
      ...result.pushes.filter(
        (p) => p.headers.pushType === 'alert' && ((p.body.body ?? {}) as Record<string, unknown>).hopEndKind === 'disembark',
      ),
    ];
    expect(promptAlerts.map((p) => kstOf(p.simNowMs)).sort()).toEqual(['06:27:46', '06:35:46', '06:36:46', '06:41:49']);
    for (const push of promptAlerts) expect(apsOf(push).sound).toBeUndefined();
  });
});

describe('#3221 PR-3 — split trip: 매역(intermediate)은 일반 alert 대신 여정 LA 무음 update', () => {
  it('intermediate 3역(중곡/군자/어대): 일반 station alert 0건 + 그 역 arrivedStationName을 실은 여정 update 각 1건', async () => {
    const result = await replay(true);
    for (const station of INTERMEDIATE_STATIONS) {
      expect(alertsWith(result, stationNotifCollapseId(TRIP_TOKEN, station))).toEqual([]);
      const arrived = journeyUpdates(result).filter(
        (p) => apsOf(p)['content-state']?.arrivedStationName === station,
      );
      expect(arrived).toHaveLength(1);
      const state = apsOf(arrived[0])['content-state'] ?? {};
      expect(state.stationName).toBe(station);
      expect(typeof state.arrivedUntilEpochSec).toBe('number');
      expect(state.arrivedUntilEpochSec as number).toBeGreaterThan(Math.floor(arrived[0].simNowMs / 1000));
      expect(apsOf(arrived[0]).alert).toBeUndefined();
    }
  });

  it('transfer(건대입구)는 일반 notification 그대로, 그 역은 arrivedStationName을 싣지 않는다', async () => {
    const result = await replay(true);
    expect(alertsWith(result, stationNotifCollapseId(TRIP_TOKEN, '건대입구'))).toHaveLength(1);
    const arrived = journeyUpdates(result).filter((p) => apsOf(p)['content-state']?.arrivedStationName === '건대입구');
    expect(arrived).toEqual([]);
  });

  it('[#2510 반전] 비취침 1정거장 전 준비 알람(prepare-*)은 철거돼 0건이다', async () => {
    const result = await replay(true);
    expect(alertsWith(result, 'prepare-')).toEqual([]);
  });
});

describe('#3221 PR-3 — 여정 LA가 없으면 매역 알림을 잃지 않는다', () => {
  it('split trip이어도 여정 LA token이 없으면(대체할 update 대상 없음) intermediate는 일반 alert 그대로, 탑승 start는 여정 LA와 무관하게 나간다', async () => {
    const result = await replay(true, (trip) => {
      trip.activityPushToken = undefined;
      trip.activityState = undefined;
    });
    for (const station of INTERMEDIATE_STATIONS) {
      expect(alertsWith(result, stationNotifCollapseId(TRIP_TOKEN, station))).toHaveLength(1);
    }
    expect(starts(result)).toHaveLength(4);
  });
});

describe('#3221 PR-3 — 비split trip은 현행 byte 동일', () => {
  /**
   * 변경 전(dev 4f82953b) 코드로 계산한 push 전수(simNowMs/url/body/headers, UUID 정규화) sha256. 통과시키려 조정 금지.
   *
   * 2026-11-02 #2510 반전으로 이 해시를 갱신했다(이전 값 361ff7cf…). 이전/이후 push 전수를 덤프해 diff한 결과 차이는
   * 정확히 아래 3가지뿐이다 — (1) 비취침 "1정거장 전" prepare alert(`prepare-…-건대입구`, alarm.wav) 1건 삭제,
   * (2) 건대입구 환승 도착 alert의 `sound: alarm.wav` + `time-sensitive` -> sound 키 부재 + `active`(비취침 무음 배너),
   * (3) (1)로 줄어든 push 수만큼 이후 pushId 일련번호가 1씩 당겨짐. simNowMs·url·그 외 body/header는 전부 동일.
   *
   * 2026-11-03 #3221 PR-3a로 이 해시를 다시 갱신했다(이전 값 e3d34f43…). 질문 LA update 3건의 content-state에 발사 시각
   * `trainCodeIssuedAtMs`(=알림 sentAt)가 추가됐을 뿐이다 — 갱신 후 push 전수 JSON에서 이 키 3건(`,"trainCodeIssuedAtMs":N`)만
   * 제거해 다시 해시하면 이전 값 e3d34f43…과 정확히 일치함을 확인했다(다른 body/header/simNowMs 변경 0).
   *
   * 2026-11-04 #3319 PR-c로 이 해시를 다시 갱신했다(이전 값 b8999e3f…). mid-cycle 매역 push 4건(중곡 2·어린이대공원 등, 30건 중)의
   * `data`에 `ssot` 객체(현재 역/노선/passedStations/alarmEvents)가 추가됐을 뿐이다 — 변경 전/후 push 전수 JSON을 덤프해 diff한 결과
   * 차이는 이 4건의 `data.ssot` 추가뿐이고 simNowMs·url·headers·그 외 body 키 변경은 0이다.
   */
  const BASELINE_PUSHES_SHA256 = 'c74d6345a24bc689e22d0598d256d36598aba94d6369ff4225a5f0a8c74e4820';

  it('start 0건, 질문 LA alert는 여정 update에 실리고, push 전수 해시가 변경 전과 같다', async () => {
    const result = await replay(false);
    expect(starts(result)).toEqual([]);
    const questionUpdates = journeyUpdates(result).filter((p) => apsOf(p).alert?.title === '탑승하셨나요?');
    expect(questionUpdates).toHaveLength(3);
    const digest = createHash('sha256')
      .update(
        JSON.stringify(result.pushes.map(({ simNowMs, url, body, headers }) => ({ simNowMs, url, body, headers })))
          // hop-end 호출부의 pushId는 `crypto.randomUUID()`(비결정) — 값만 정규화한다.
          .replace(UUID_RE, '<uuid>'),
      )
      .digest('hex');
    expect(digest).toBe(BASELINE_PUSHES_SHA256);
  });
});
