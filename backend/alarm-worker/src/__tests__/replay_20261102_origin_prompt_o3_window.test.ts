/**
 * #3036 (Part of #2997) — O3 창: 11/02 아침 실측 replay로 거리 x acceptance 표를 실제 APNs 요청으로 assert.
 *
 * 사용자 결정(원문): "이거는 설계로 수정하자" / "03으로 진행해".
 * 창 시작 = 등록 시각 + 걷는 시간(max(0, 거리-정확도) / 1.2 m/s, 15분 상한; fix가 live이고 <=5분일 때만, 아니면 0) - 60s.
 * 창 종료 = 발사 2회(K=2) 또는 시작+15분(보수적 기본값, 계획 U7 미결) 또는 신선 원거리 위치(떠남, 영속).
 *
 * 입력은 불변 실측(fixture) + 합성 device 입력(거리/fix/series/alarmAt). 기대값은 **스펙에서 독립 산출한 oracle**
 * (아래 `specWindowStartAt`/`specExpectedPrompts`)이며 구현 함수를 import하지 않는다 — 구현을 거울처럼 베끼지 않는다.
 * 도착 확정 tick(실측): 7035 @T1, 7039 @T2, 7043 @T3 (PR-2 대조군과 동일).
 */
import { describe, expect, it } from 'vitest';
import type { PositionPoint } from '../types';
import { findStationCoordsByNameAndLine } from '../stationsLookup';
import {
  boardingPromptsOf,
  kstOf,
  loadRide20261102Fixture,
  replayRide20261102,
  ride20261102RegisteredAt,
} from './helpers/originPromptReplay';
import { runCaptureReplay } from './helpers/replayHarness';
import {
  makeRide20261102GeoContext,
  makeRide20261102MorningTrip,
  RIDE_20261102_ALARM_OFFSET_MS,
  type Ride20261102AlarmVariant,
} from './helpers/ride20261102MorningTrips';

const WALK_SPEED = 1.2; // m/s (device eta.ts:3과 동일, 스펙 고정값)
const LEAD_MS = 60_000;
const WALK_CAP_MS = 15 * 60_000;
const FIX_MAX_AGE_MS = 5 * 60_000;
const POLLING_WINDOW_MS = 5 * 60_000;

type Geo = { originDistanceM: number; originAccuracyM: number; originFixAgeMs?: number; originFixSource?: 'gps-live' | 'gps-last-known' };

/** 스펙 oracle — 창 시작 시각. */
function specWindowStartAt(registeredAt: number, geo?: Geo): number {
  const delays =
    geo !== undefined &&
    geo.originFixSource === 'gps-live' &&
    geo.originFixAgeMs !== undefined &&
    geo.originFixAgeMs <= FIX_MAX_AGE_MS;
  const dEff = geo === undefined ? 0 : Math.max(0, geo.originDistanceM - geo.originAccuracyM);
  const walkMs = delays ? Math.min((dEff / WALK_SPEED) * 1000, WALK_CAP_MS) : 0;
  return registeredAt + walkMs - LEAD_MS;
}

/** 실측 도착 확정 tick(replay 시계) — 각 열차가 처음 발사 가능해지는 시각. */
async function arrivalTicks(): Promise<Array<{ train: string; tick: number }>> {
  const control = await replayRide20261102((at) =>
    makeRide20261102MorningTrip('replay-20261102-ticks', at, { intent: 'promptOptIn', alarm: 'alarm0' }),
  );
  return control.pushes
    .filter((p) => (p.body.body as Record<string, unknown> | undefined)?.kind === 'boarding-prompt')
    .map((p) => ({ train: String((p.body.body as Record<string, unknown>).trainCode), tick: p.simNowMs }));
}

/** 스펙 oracle — 기대 질문 집합: 창이 열려 있고(폴링 게이트 통과) 아직 K=2 미만인 도착 확정 tick마다 1건. */
function specExpectedPrompts(
  ticks: Array<{ train: string; tick: number }>,
  registeredAt: number,
  startAt: number,
  alarm: Ride20261102AlarmVariant,
): Array<[string, string]> {
  const alarmAt = registeredAt + RIDE_20261102_ALARM_OFFSET_MS[alarm];
  const out: Array<[string, string]> = [];
  for (const { train, tick } of ticks) {
    if (out.length >= 2) break;
    if (tick < startAt) continue;
    if (alarmAt - tick > POLLING_WINDOW_MS) continue;
    out.push([kstOf(tick), train]);
  }
  return out;
}

const DISTANCE_GRID_DEFF_M = [0, 100, 140, 150, 300, 570, 580, 1000];
const ACCURACY_M = 20;
const ALARMS: Ride20261102AlarmVariant[] = ['alarm0', 'alarm1', 'alarm7'];
const LIVE_GEO_BASE = { originAccuracyM: ACCURACY_M, originFixAgeMs: 30_000, originFixSource: 'gps-live' as const };

describe('#3036 O3 — 거리 x acceptance 표 (실제 APNs 요청, 11/02 아침 실측)', () => {
  for (const dEff of DISTANCE_GRID_DEFF_M) {
    it.each(ALARMS)(`dEff=${dEff}m (live fix 30s) / %s: oracle 표와 (tick, 열차) 집합이 정확히 일치`, async (alarm) => {
      const ticks = await arrivalTicks();
      const geoFields: Geo = { ...LIVE_GEO_BASE, originDistanceM: dEff + ACCURACY_M };
      const result = await replayRide20261102((at) =>
        makeRide20261102MorningTrip('replay-20261102-o3', at, {
          intent: 'tracking',
          alarm,
          geo: makeRide20261102GeoContext(geoFields),
          windowStartAt: specWindowStartAt(at, geoFields),
        }),
      );
      const registeredAt = ride20261102RegisteredAt(loadRide20261102Fixture());
      const expected = specExpectedPrompts(ticks, registeredAt, specWindowStartAt(registeredAt, geoFields), alarm);
      expect(boardingPromptsOf(result)).toEqual(expected);
    });
  }

  it('핵심 문장: alarm0에서 7039는 모든 거리(<=576m 보행 가정 포함)에서 질문을 받는다 — 7043은 K=2 또는 창 시작 이후에만', async () => {
    const seen: Record<number, string[]> = {};
    for (const dEff of [0, 100, 300, 570]) {
      const geoFields: Geo = { ...LIVE_GEO_BASE, originDistanceM: dEff + ACCURACY_M };
      const result = await replayRide20261102((at) =>
        makeRide20261102MorningTrip('replay-20261102-key', at, {
          intent: 'tracking',
          geo: makeRide20261102GeoContext(geoFields),
          windowStartAt: specWindowStartAt(at, geoFields),
        }),
      );
      seen[dEff] = boardingPromptsOf(result).map(([, train]) => train);
    }
    expect(seen).toEqual({ 0: ['7035', '7039'], 100: ['7035', '7039'], 300: ['7039', '7043'], 570: ['7039', '7043'] });
  });
});

describe('#3036 O3 — fix 신뢰도: 오래됐거나 live가 아니면 지연 없음(창 즉시)', () => {
  const CASES: Array<{ label: string; geo: Geo | undefined }> = [
    { label: 'fix 나이 12분 + 2000m', geo: { originDistanceM: 2000, originAccuracyM: 20, originFixAgeMs: 12 * 60_000, originFixSource: 'gps-live' } },
    { label: 'gps-last-known + 2000m', geo: { originDistanceM: 2000, originAccuracyM: 20, originFixAgeMs: 10_000, originFixSource: 'gps-last-known' } },
    { label: '필드 부재(구 클라) + 2000m', geo: { originDistanceM: 2000, originAccuracyM: 20 } },
    { label: 'fix 자체 없음(지하)', geo: undefined },
  ];
  it.each(CASES)('$label -> 7035, 7039 (지연 0)', async ({ geo }) => {
    const result = await replayRide20261102((at) =>
      makeRide20261102MorningTrip('replay-20261102-fix', at, {
        intent: 'tracking',
        geo: geo === undefined ? undefined : makeRide20261102GeoContext(geo),
        windowStartAt: specWindowStartAt(at, geo),
      }),
    );
    expect(boardingPromptsOf(result).map(([, train]) => train)).toEqual(['7035', '7039']);
  });
});

describe('#3036 O3 — 거부 케이스 (고친 뒤에도 막혀야 하는 것)', () => {
  it('의향 없음(trackingOptIn/promptOptIn/infoMode 전부 false)이면 창이 있어도 0건', async () => {
    const result = await replayRide20261102((at) => {
      const trip = makeRide20261102MorningTrip('replay-20261102-nointent', at, { intent: 'tracking', windowStartAt: at - LEAD_MS });
      return { ...trip, trackingOptIn: false };
    });
    expect(boardingPromptsOf(result)).toEqual([]);
  });

  it('lock이 이미 있으면 origin 질문 0건', async () => {
    const result = await replayRide20261102((at) => {
      const trip = makeRide20261102MorningTrip('replay-20261102-lock', at, { intent: 'tracking', windowStartAt: at - LEAD_MS });
      return {
        ...trip,
        boardingLock: {
          trainCode: '7035',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: at,
          segmentStations: ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'],
          expiresAt: at + 60 * 60_000,
        },
      };
    });
    // lock 이후 환승 하차/leg-2 질문은 정상 발사 — 출발역(용마산) origin 질문만 0건이어야 한다.
    expect(boardingPromptsOf(result, '용마산')).toEqual([]);
  });

  it('창 필드가 없는 trackingOptIn trip(구 backend 등록)은 현행대로 fail-closed 0건', async () => {
    const result = await replayRide20261102((at) => makeRide20261102MorningTrip('replay-20261102-nowindow', at, { intent: 'tracking' }));
    expect(boardingPromptsOf(result)).toEqual([]);
  });

  it('역을 떠남: 창 열린 뒤 신선 원거리 위치(800m, acc 10) -> 이후 질문 0건, 이미 닫힌 창은 series가 낡아도 재개 안 됨', async () => {
    const fixture = loadRide20261102Fixture();
    const registeredAt = ride20261102RegisteredAt(fixture);
    const origin = findStationCoordsByNameAndLine('용마산', '7');
    if (origin === null) throw new Error('fixture 전제 실패 — 용마산 좌표');
    // 06:30:50 KST 원거리 신선 point. T1(06:28:46)에는 아직 없고, T2(06:34:46)에는 신선(<=5분)이지만 T3(06:40:46)에는 낡음.
    const farTs = Date.UTC(2026, 10, 1, 21, 30, 50);
    const far: PositionPoint = { lat: origin.lat + 0.0072, lng: origin.lng, accuracy: 10, ts: farTs, motion: 'walking' };
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeRide20261102MorningTrip('replay-20261102-left', registeredAt, { intent: 'tracking', windowStartAt: registeredAt - LEAD_MS })],
      seedPositionSeries: { 'replay-20261102-left': [far] },
      apns: 'capture',
    });
    expect(boardingPromptsOf(result)).toEqual([['06:28:46', '7035']]);
  });

  it('대조군 promptOptIn은 창 필드가 있어도 불변(도착 확정마다 3건)', async () => {
    const result = await replayRide20261102((at) => ({
      ...makeRide20261102MorningTrip('replay-20261102-control', at, { intent: 'promptOptIn', windowStartAt: at + 10 * 60_000 }),
    }));
    expect(boardingPromptsOf(result).map(([, train]) => train)).toEqual(['7035', '7039', '7043']);
  });
});
