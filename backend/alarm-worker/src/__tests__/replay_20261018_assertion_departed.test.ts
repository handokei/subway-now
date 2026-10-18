/**
 * #3056 재생 — 2026-10-18 밤 라이드, 용마산 7호선 하행 7325(trainSttus=2 DEPARTED, recptn 29s)
 * 탑승 표명(boarding-confirm) lock 실패 재현 + 거부 테스트 ⓐ~ⓙ.
 *
 * 스펙 SSoT: 이슈 #3056 plan v2 코멘트(2026-10-19). 이 파일은 **구현을 보지 않고 스펙만으로**
 * 작성했다(TDD red 먼저).
 *
 * 범위: "탑승 표명(회고 시제)" 경로 = `attemptBoardingAnchorResolution`의 `options.tapAnchor`
 * (index.ts boarding-confirm 유일 전달자)에서만 앵커 정위치 fresh DEPARTED를 수용한다.
 * 기본/cron/register-time/전이확증(`evaluateLegBoardingTransition`) 경로는 불변.
 *
 * ## 불변식 승격 (docs/agents/invariants.md — boardingAnchorResolver.ts "틀린 열차 lock 절대 금지")
 * ⓓⓔⓕⓘ는 그 불변식(강제: 부분, 승격 큐 7번)의 리졸버 레벨 직접 테스트다.
 *
 * fixture(불변, 실측): `fixtures/capture_20261018_2325_yongmasan_departed_7325.json` — 7호선
 * 용마산 7325 trainSttus=2 하행(updnLine=1), recptnDt 23:25:07 KST. 탭 시각 = recptn + 29s.
 */
import { describe, expect, it, vi } from 'vitest';
import app, { buildBoardingConfirmEventMeta } from '../index';
import {
  attemptBoardingAnchorResolution,
  evaluateLegBoardingTransition,
  POSITION_FRESHNESS_MS,
  resolveTrainCodeFromPositions,
  type BoardingAnchor,
  type LegBoardingConfirmation,
} from '../boardingAnchorResolver';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';
import { TRAIN_STATUS } from '../alarm';
import { inferLegDirection } from '../legDirection';
import { parseReplayFixture } from '../replayFixture';
import { getTrip } from '../trips';
import { runCaptureReplay, makeCaptureFetch } from './helpers/replayHarness';
import type { Env, Trip, Waypoint } from '../types';
import captureJson from './fixtures/capture_20261018_2325_yongmasan_departed_7325.json';

const DEPARTED_TRAIN = '7325';
const SEGMENT = ['용마산', '중곡', '군자(능동)'] as const;
const ANCHOR: BoardingAnchor = { line: '7', boardingStation: '용마산', direction: 'down' };

interface RawEntry {
  tMs: number;
  kind: string;
  target: string;
  body: string;
}
const lineEntry = (captureJson.entries as RawEntry[]).find((e) => e.kind === 'position' && e.target === '7호선')!;

function makeSeoul(now: number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'KEY',
    host: 'seoul.api',
    now: () => now,
    fetchImpl: (async () => new Response(lineEntry.body, { status: 200 })) as unknown as typeof fetch,
  });
}

async function loadFixture(): Promise<{ positions: PositionEntry[]; tapMs: number; departed: PositionEntry }> {
  const positions = await makeSeoul(lineEntry.tMs).fetchPositions('7');
  const departed = positions.find((p) => p.trainCode === DEPARTED_TRAIN)!;
  return { positions, departed, tapMs: departed.recptnMs + 29_000 };
}

function pos(overrides: Partial<PositionEntry> & { trainCode: string }): PositionEntry {
  return { stationName: '용마산', trainSttus: TRAIN_STATUS.DEPARTED, isUp: false, recptnMs: 1_000_000, ...overrides };
}
const SYN_NOW = 1_000_000 + 29_000;

const WAYPOINTS: Waypoint[] = [
  { stationName: '중곡', line: '7', kind: 'intermediate' },
  { stationName: '군자(능동)', line: '7', kind: 'destination' },
];

function makeTrip(token: string, now: number): Trip {
  return {
    token,
    route: { type: 'direct', stops: 2, line: '7' },
    destination: '군자(능동)',
    waypoints: WAYPOINTS,
    expiresAt: now + 60 * 60_000,
    createdAt: now - 5 * 60_000,
    alarmAtEpochMs: now,
    promptDisplay: { originStation: '용마산', line: '7' },
    infoModeEnabled: true,
    boardingLock: undefined,
  };
}

describe('#3056 전제 — fixture 사실 (스펙 입력 고정)', () => {
  it('7325는 용마산 하행 DEPARTED, 탭 시각 기준 신선(29s)이며 방향은 production inferLegDirection과 일치한다', async () => {
    const { departed, tapMs } = await loadFixture();
    expect(departed.stationName).toBe('용마산');
    expect(departed.trainSttus).toBe(TRAIN_STATUS.DEPARTED);
    expect(departed.isUp).toBe(false);
    expect(tapMs - departed.recptnMs).toBe(29_000);
    expect(inferLegDirection('7', '용마산', '중곡')).toBe('down');
  });
});

describe('#3056 resolveTrainCodeFromPositions — assertionMode(탑승 표명 회고 시제)', () => {
  it('RED: assertionMode + 10/18 실측 → 앵커 정위치 fresh DEPARTED 7325가 유일 후보로 resolved', async () => {
    const { positions, tapMs } = await loadFixture();
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, tapMs, SEGMENT, true)).toEqual({
      status: 'resolved',
      trainCode: DEPARTED_TRAIN,
      tier: 'assertion-departed',
    });
  });

  it('ⓐ 기본 모드(옵션 미전달/false) 같은 fixture → none 유지 (기존 동작 불변)', async () => {
    const { positions, tapMs } = await loadFixture();
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, tapMs, SEGMENT)).toEqual({ status: 'none' });
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, tapMs, SEGMENT, false)).toEqual({ status: 'none' });
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, tapMs)).toEqual({ status: 'none' });
  });

  it('ⓓ stale DEPARTED(recptn > 120s)는 assertionMode에도 none — 신규 임계값 없이 기존 창 재사용', async () => {
    const { positions, departed } = await loadFixture();
    const edge = departed.recptnMs + POSITION_FRESHNESS_MS;
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, edge, SEGMENT, true)).toEqual({
      status: 'resolved',
      trainCode: DEPARTED_TRAIN,
      tier: 'assertion-departed',
    });
    expect(resolveTrainCodeFromPositions(ANCHOR, positions, edge + 1, SEGMENT, true)).toEqual({ status: 'none' });
  });

  it('ⓓ recptnMs=0(누락)은 신뢰 불가 — assertionMode에도 none', () => {
    const r = resolveTrainCodeFromPositions(ANCHOR, [pos({ trainCode: 'X1', recptnMs: 0 })], SYN_NOW, SEGMENT, true);
    expect(r).toEqual({ status: 'none' });
  });

  // forwardSegment 미전달: 'up' 앵커에 하행 segment를 주면 기존 #2892 passed 확장이 7316(중곡 상행)을
  // 잡는 별개 경로가 섞인다 — 여기서는 새 tier의 방향 필터만 격리해 본다.
  it('ⓔ 반대방향 DEPARTED는 assertionMode에도 none (방향 필터 load-bearing)', async () => {
    const { positions, tapMs } = await loadFixture();
    const upAnchor: BoardingAnchor = { ...ANCHOR, direction: 'up' };
    expect(resolveTrainCodeFromPositions(upAnchor, positions, tapMs, undefined, true)).toEqual({ status: 'none' });
  });

  it('ⓔ direction=null은 assertionMode에도 fail-closed none (#2944)', async () => {
    const { positions, tapMs } = await loadFixture();
    const nullAnchor: BoardingAnchor = { ...ANCHOR, direction: null };
    expect(resolveTrainCodeFromPositions(nullAnchor, positions, tapMs, SEGMENT, true)).toEqual({ status: 'none' });
  });

  it('ⓕ ARRIVED 후보가 공존하면 assertionMode에도 ARRIVED 우선 (기존 매칭 100% 무변경)', () => {
    const r = resolveTrainCodeFromPositions(
      ANCHOR,
      [pos({ trainCode: 'DEP1' }), pos({ trainCode: 'ARR1', trainSttus: TRAIN_STATUS.ARRIVED })],
      SYN_NOW,
      SEGMENT,
      true,
    );
    expect(r).toEqual({ status: 'resolved', trainCode: 'ARR1' });
  });

  it('ⓕ APPROACHING 후보가 공존해도 APPROACHING 우선', () => {
    const r = resolveTrainCodeFromPositions(
      ANCHOR,
      [pos({ trainCode: 'DEP1' }), pos({ trainCode: 'APP1', trainSttus: TRAIN_STATUS.APPROACHING })],
      SYN_NOW,
      SEGMENT,
      true,
    );
    expect(r).toEqual({ status: 'resolved', trainCode: 'APP1' });
  });

  it('ⓗ tier 순서: 앵커 정위치 fresh DEPARTED A + 1-hop 전방 passed 후보 B 공존 → B 유지 (기존 #2892 결과 무변경)', () => {
    const r = resolveTrainCodeFromPositions(
      ANCHOR,
      [
        pos({ trainCode: 'A_AT_ANCHOR' }),
        pos({ trainCode: 'B_PASSED', stationName: '중곡', trainSttus: TRAIN_STATUS.ARRIVED }),
      ],
      SYN_NOW,
      SEGMENT,
      true,
    );
    // 기존 passed 경로 결과는 tier 라벨 없이 그대로(라벨은 새 최후 tier 전용).
    expect(r).toEqual({ status: 'resolved', trainCode: 'B_PASSED' });
  });

  it('ⓘ 앵커 정위치 같은 방향 fresh DEPARTED 2개 → ambiguous (none 아님, 틀린 열차 lock 금지)', () => {
    const r = resolveTrainCodeFromPositions(
      ANCHOR,
      [pos({ trainCode: 'D1' }), pos({ trainCode: 'D2' })],
      SYN_NOW,
      SEGMENT,
      true,
    );
    expect(r).toEqual({ status: 'ambiguous' });
  });

  it('ⓘ 2개 중 하나가 stale/반대방향이면 남은 1개만 단일 확정', () => {
    const stale = pos({ trainCode: 'D_STALE', recptnMs: SYN_NOW - POSITION_FRESHNESS_MS - 1 });
    const opposite = pos({ trainCode: 'D_OPP', isUp: true });
    expect(
      resolveTrainCodeFromPositions(ANCHOR, [pos({ trainCode: 'D1' }), stale, opposite], SYN_NOW, SEGMENT, true),
    ).toEqual({ status: 'resolved', trainCode: 'D1', tier: 'assertion-departed' });
  });

  it('앵커 정위치가 아닌 DEPARTED(2 hop 이상 전방 / 다른 역)는 새 tier가 수용하지 않는다', () => {
    const r = resolveTrainCodeFromPositions(
      ANCHOR,
      [pos({ trainCode: 'FAR', stationName: '군자(능동)' }), pos({ trainCode: 'ELSE', stationName: '사가정' })],
      SYN_NOW,
      SEGMENT,
      true,
    );
    expect(r).toEqual({ status: 'none' });
  });
});

describe('#3056 전이 확증(evaluateLegBoardingTransition) — DEPARTED 2회 관측 승격 금지 (#2754/#2780)', () => {
  it('ⓑ pending 없이 앵커 정위치 DEPARTED 단독 → none (pending/confirmed로 승격되지 않는다)', async () => {
    const { positions, tapMs } = await loadFixture();
    const c: LegBoardingConfirmation = evaluateLegBoardingTransition(ANCHOR, positions, tapMs, undefined, true, SEGMENT);
    expect(c.status).toBe('none');
  });

  it('ⓑ attemptBoardingAnchorResolution + legTransition(+tapAnchor 동시 전달) → 전이 판정 none, lock null', async () => {
    const { tapMs } = await loadFixture();
    const seen: LegBoardingConfirmation[] = [];
    let outcome: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('t3056-b', tapMs),
      makeSeoul(tapMs),
      tapMs,
      {
        allowLegTransfer: true,
        tapAnchor: { boardingStation: '용마산', line: '7' },
        legTransition: { pending: undefined, hasUserBoardingResponse: true },
      },
      (o) => {
        outcome = o;
      },
      undefined,
      (c) => seen.push(c),
    );
    expect(lock).toBeNull();
    expect(outcome).toBe('none');
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('none');
  });
});

describe('#3056 attemptBoardingAnchorResolution — 경로별 게이트', () => {
  it('ⓒ register-time(tapAnchor 없음, allowLegTransfer만) → lock 없음, noneReason=position-resolve-none', async () => {
    const { tapMs } = await loadFixture();
    let outcome: string | undefined;
    let reason: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('t3056-c', tapMs),
      makeSeoul(tapMs),
      tapMs,
      { allowLegTransfer: true },
      (o, d) => {
        outcome = o;
        reason = d?.noneReason;
      },
    );
    expect(lock).toBeNull();
    expect(outcome).toBe('none');
    expect(reason).toBe('position-resolve-none');
  });

  it('ⓒ cron 모양(options 없음) → 불변', async () => {
    const { tapMs } = await loadFixture();
    let outcome: string | undefined;
    const lock = await attemptBoardingAnchorResolution(makeTrip('t3056-c2', tapMs), makeSeoul(tapMs), tapMs, undefined, (o) => {
      outcome = o;
    });
    expect(lock).toBeNull();
    expect(outcome).toBe('none');
  });

  it('ⓙ 탑승 표명(tapAnchor) → 용마산 7325 lock 합성 (outcome=resolved)', async () => {
    const { tapMs } = await loadFixture();
    let outcome: string | undefined;
    let tier: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('t3056-j', tapMs),
      makeSeoul(tapMs),
      tapMs,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '용마산', line: '7' } },
      (o, d) => {
        outcome = o;
        tier = d?.resolveTier;
      },
    );
    expect(outcome).toBe('resolved');
    // D1 구분자: 최후 tier 수용 건만 라벨이 붙는다(배포 후 오수용률 backfill 측정 전제).
    expect(tier).toBe('assertion-departed');
    expect(lock?.trainCode).toBe(DEPARTED_TRAIN);
    expect(lock?.line).toBe('7');
  });

  it('ⓘ tapAnchor + 앵커 정위치 DEPARTED 2대 → outcome=ambiguous, lock 없음', async () => {
    const { tapMs, departed } = await loadFixture();
    const twin = { ...departed, trainCode: '7399' };
    const seoul = { fetchPositions: async () => [departed, twin] } as unknown as SeoulArrivalClient;
    let outcome: string | undefined;
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('t3056-i', tapMs),
      seoul,
      tapMs,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '용마산', line: '7' } },
      (o) => {
        outcome = o;
      },
    );
    expect(lock).toBeNull();
    expect(outcome).toBe('ambiguous');
  });
});

describe('#3056 D1 tier 라벨 — 기존 경로는 미설정, 최후 tier만 resolveTier', () => {
  it('기존 ARRIVED 경로로 resolved되면 resolveTier 미설정(detail 없음)', async () => {
    const { tapMs, departed } = await loadFixture();
    const arrived = { ...departed, trainCode: '7300', trainSttus: TRAIN_STATUS.ARRIVED };
    const seoul = { fetchPositions: async () => [arrived] } as unknown as SeoulArrivalClient;
    const calls: Array<[string, unknown]> = [];
    const lock = await attemptBoardingAnchorResolution(
      makeTrip('t3056-tier', tapMs),
      seoul,
      tapMs,
      { allowLegTransfer: true, tapAnchor: { boardingStation: '용마산', line: '7' } },
      (o, d) => calls.push([o, d]),
    );
    expect(lock?.trainCode).toBe('7300');
    expect(calls).toEqual([['resolved', undefined]]);
  });

  it('buildBoardingConfirmEventMeta: resolved일 때만 resolveTier를 싣는다', () => {
    expect(buildBoardingConfirmEventMeta('leg1', 'resolved', 'tap', undefined, undefined, 'assertion-departed')).toEqual({
      lockState: 'leg1',
      outcome: 'resolved',
      anchorSource: 'tap',
      resolveTier: 'assertion-departed',
    });
    expect(buildBoardingConfirmEventMeta('leg1', 'resolved', 'tap')).not.toHaveProperty('resolveTier');
    expect(
      buildBoardingConfirmEventMeta('none', 'none', 'tap', 'position-resolve-none', undefined, 'assertion-departed'),
    ).not.toHaveProperty('resolveTier');
  });
});

describe('#3056 ⓙ 등뼈(#3041 S-C 세그먼트) — HTTP boarding-confirm "방금 떠난 그 열차" lock', () => {
  // 원본 캡처(source/window 없는 단일 cycle 형식)는 수정하지 않고, 하네스 계약
  // (schemaVersion/source/window/tMs 오름차순)만 읽기 전용으로 감싼다 — entries 값은 원본 그대로.
  const sortedEntries = [...(captureJson.entries as RawEntry[])].sort((a, b) => a.tMs - b.tMs);
  const fixture = parseReplayFixture({
    schemaVersion: 1,
    source: 'backend-seoul',
    window: { fromMs: sortedEntries[0].tMs, toMs: sortedEntries[sortedEntries.length - 1].tMs },
    cycleStartsMs: [captureJson.cycleStartMs],
    entries: sortedEntries,
  });

  /** 마지막 boarding-confirm 응답 body(#3055 — device가 소비하는 왕복 계약의 실측 입력). */
  let lastResponseBody: unknown;

  async function confirmAndGetLock(token: string, body: Record<string, unknown>): Promise<string | undefined> {
    const { tapMs } = await loadFixture();
    let capturedEnv: Env | undefined;
    await runCaptureReplay({
      fixture,
      seedTrips: [makeTrip(token, tapMs)],
      apns: 'capture',
      beforeTick: async ({ env, tickIndex }) => {
        capturedEnv = env;
        if (tickIndex !== 0) return;
        const spy = vi.spyOn(Date, 'now').mockReturnValue(tapMs);
        vi.stubGlobal('fetch', makeCaptureFetch(fixture, () => tapMs, { freshMs: 120_000, ceilingMs: lineEntry.tMs + 60_000 }));
        try {
          const res = await app.fetch(
            new Request(`http://example.com/trips/${token}/boarding-confirm`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'boarded', station: '용마산', line: '7', ...body }),
            }),
            env,
          );
          lastResponseBody = await res.json();
        } finally {
          spy.mockRestore();
          vi.unstubAllGlobals();
        }
      },
    });
    const trip = await getTrip(capturedEnv!.TRIPS, token);
    return trip?.boardingLock?.trainCode;
  }

  it('LA 버튼 모양(trainCode 미동봉) 응답 → live 재조회가 탭 시각에 방금 떠난 7325를 lock', async () => {
    expect(await confirmAndGetLock('s-c-3056-la', {})).toBe(DEPARTED_TRAIN);
    // #3055 — 같은 실측 탭의 응답 body가 device 승격의 입력이다(resolvedTrainCode/resolvedLine/resolveTier).
    expect(lastResponseBody).toEqual({
      ok: true,
      lockState: 'leg1',
      resolvedTrainCode: DEPARTED_TRAIN,
      resolvedLine: '7',
      resolveTier: 'assertion-departed',
    });
  }, 60_000);
});
