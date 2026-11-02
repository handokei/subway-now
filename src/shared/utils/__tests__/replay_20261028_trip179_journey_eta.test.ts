/**
 * #1480 PR-C acceptance — 10/28 실측 replay (새 라이드 불요).
 *
 * fixture는 backend replayLibrary(R2 seoul-capture 원문)와 capture_20261028_trip179 arrival 원문이며
 * **불변**이다 — 통과시키려고 조정하지 않는다. nowMs는 실측 시각을 KST로 고정 주입해 결정적이다.
 *
 * - trip 179(아침 7→2): 7035가 건대입구에 도착한 06:34:21 + 도보 278 + buffer 30 → 시간표 2호선 down 0641.
 *   실제 환승 열차 3013은 건대입구 도착 06:40:44 (±1분), 뚝섬 도착 06:45:13 (±2분).
 * - trip 180(저녁 2→7): 시간표 단독은 1722 선택, 실제 7252는 17:24:10 도착 — known gap (D4, +2.2분).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { computeJourneyEta } from '../journeyTimeline';
import { findStationByNameAndLine } from '../stationRoute';
import type { Route } from '../stationRoute';

const BACKEND_FIXTURES = join(__dirname, '../../../../backend/alarm-worker/src/__tests__/fixtures');
const KST_OFFSET_MS = 9 * 3_600_000;

function kstEpoch(recptnDt: string): number {
  const [d, t] = recptnDt.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, s) - KST_OFFSET_MS;
}

interface PositionRow {
  statnNm: string;
  trainNo: string;
  recptnDt: string;
  trainSttus: string;
}

/** capture entries(realtimePosition 원문)에서 (열차, 역, 상태) 첫 관측 시각. */
function findPositionEpoch(
  entries: Array<{ kind: string; body: string }>,
  trainNo: string,
  stationName: string,
  trainSttus: string,
): number | null {
  for (const entry of entries) {
    if (entry.kind !== 'position') continue;
    let body: { realtimePositionList?: PositionRow[] };
    try {
      body = JSON.parse(entry.body);
    } catch {
      continue;
    }
    const hit = (body.realtimePositionList ?? []).find(
      (r) => r.trainNo === trainNo && r.statnNm === stationName && r.trainSttus === trainSttus,
    );
    if (hit) return kstEpoch(hit.recptnDt);
  }
  return null;
}

/** replayLibrary fixture 파일 단일. */
function positionEpoch(fixtureFile: string, trainNo: string, stationName: string, trainSttus: string): number {
  const fixture = JSON.parse(readFileSync(join(BACKEND_FIXTURES, 'replayLibrary', fixtureFile), 'utf8')) as {
    entries: Array<{ kind: string; body: string }>;
  };
  const epoch = findPositionEpoch(fixture.entries, trainNo, stationName, trainSttus);
  if (epoch === null) throw new Error(`fixture: ${trainNo}/${stationName}/${trainSttus} 관측 없음`);
  return epoch;
}

/** replay_20261028_trip180/caps/*.json (cycle별 원문) 전체에서 첫 관측 시각. */
function capsPositionEpoch(dir: string, trainNo: string, stationName: string, trainSttus: string): number {
  const capsDir = join(BACKEND_FIXTURES, dir, 'caps');
  for (const file of readdirSync(capsDir).sort()) {
    const cap = JSON.parse(readFileSync(join(capsDir, file), 'utf8')) as {
      entries: Array<{ kind: string; body: string }>;
    };
    const epoch = findPositionEpoch(cap.entries, trainNo, stationName, trainSttus);
    if (epoch !== null) return epoch;
  }
  throw new Error(`caps: ${trainNo}/${stationName}/${trainSttus} 관측 없음`);
}

describe('replay 10/28 trip 179 — 아침 7→2 (건대입구 환승)', () => {
  const contract = JSON.parse(
    readFileSync(join(BACKEND_FIXTURES, 'capture_20261028_trip179', 'device_waypoints.contract.json'), 'utf8'),
  ) as { route: NonNullable<Route> };
  const route = contract.route as Extract<NonNullable<Route>, { type: 'transfer' }>;

  const arrive7035 = positionEpoch('capture_20261028_trip179_morning_7035.fixture.json', '7035', '건대입구', '1');
  const board3013 = positionEpoch('capture_20261028_trip179_morning_7035.fixture.json', '3013', '건대입구', '1');
  const destRow = (
    JSON.parse(
      readFileSync(join(BACKEND_FIXTURES, 'capture_20261028_trip179', '뚝섬.arrival.json'), 'utf8'),
    ) as { realtimeArrivalList: Array<{ btrainNo: string; recptnDt: string; barvlDt: string }> }
  ).realtimeArrivalList.find((r) => r.btrainNo === '3013')!;
  const actualDestinationArrival = kstEpoch(destRow.recptnDt) + Number(destRow.barvlDt) * 1000;
  const nowMs = arrive7035 - route.secondsToTransfer * 1000;

  it('fixture sanity: 7035 건대입구 도착 06:34:21 / 3013 건대입구 06:40:44', () => {
    expect(arrive7035).toBe(Date.UTC(2026, 9, 28, 6, 34, 21) - KST_OFFSET_MS);
    expect(board3013).toBe(Date.UTC(2026, 9, 28, 6, 40, 44) - KST_OFFSET_MS);
  });

  it('환승 열차 선택: 시간표 0641 == 실제 3013 건대입구 도착 06:40:44 ±1분', () => {
    const eta = computeJourneyEta({ route, nowMs, excludeOriginWait: true });
    const [wait] = eta.waits;
    expect(wait.source).toBe('timetable');
    const platformMs = arrive7035 + (278 + 30) * 1000; // 도보 278 + buffer 30
    const selectedDepartureMs = platformMs + wait.seconds * 1000;
    expect(Math.abs(selectedDepartureMs - board3013)).toBeLessThanOrEqual(60_000);
  });

  it('뚝섬 ETA == 실측 3013 뚝섬 도착 06:45:13 ±2분 (3분 고정 폐기 전엔 약 6분 이른 값)', () => {
    const eta = computeJourneyEta({ route, nowMs, excludeOriginWait: true });
    const actualMinutes = (actualDestinationArrival - nowMs) / 60_000;
    expect(Math.abs(eta.minutes - actualMinutes)).toBeLessThanOrEqual(2);
  });
});

describe('replay 10/28 trip 180 — 저녁 2→7 (known gap, D4)', () => {
  const kun = findStationByNameAndLine('건대입구', '7');
  const junggok = findStationByNameAndLine('중곡', '7');
  if (!kun || !junggok) throw new Error('fixture station missing');
  const route: NonNullable<Route> = {
    type: 'transfer',
    transferName: '건대입구',
    fromLine: '2',
    toLine: '7',
    stopsToTransfer: 0,
    stopsFromTransfer: 1,
    secondsToTransfer: 0,
    secondsFromTransfer: 150,
    destinationStationId: junggok.id,
    transferStationId: '2-012',
  };
  const arrive3324 = capsPositionEpoch('replay_20261028_trip180', '3324', '건대입구', '1');
  const board7252 = positionEpoch('capture_20261028_trip180_evening_7252.fixture.json', '7252', '건대입구', '1');

  it('시간표 단독: 17:21:12 기준 1722 선택 — 실제 7252(17:24:10)와 +2~4분 known gap (정확도 주장 아님)', () => {
    const eta = computeJourneyEta({ route, nowMs: arrive3324, excludeOriginWait: true });
    const [wait] = eta.waits;
    expect(wait.source).toBe('timetable');
    const selectedMs = arrive3324 + (278 + 30 + wait.seconds) * 1000;
    expect(selectedMs).toBe(Date.UTC(2026, 9, 28, 17, 22, 0) - KST_OFFSET_MS);
    const gapMin = (board7252 - selectedMs) / 60_000;
    expect(gapMin).toBeGreaterThan(2);
    expect(gapMin).toBeLessThan(4);
  });
});
