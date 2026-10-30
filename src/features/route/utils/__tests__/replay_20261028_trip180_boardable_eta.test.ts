/**
 * #1480 PR-D acceptance — 10/28 trip 180(저녁 2→7, 건대입구 환승) 실시간 boardable replay (새 라이드 불요).
 *
 * 입력 fixture는 `replay_20261028_trip180/caps`(R2 seoul-capture 건대입구 realtimeStationArrival 원문, cycle별)와
 * `capture_20261028_trip180_evening_7252.fixture.json`(7252 건대입구 실측 position)이며 **불변**이다.
 *
 * 3324 건대입구 도착 17:16:04 + 도보 278 + buffer 30 = platform 17:21:12.
 * 실시간 7호선 상행(=중곡 방향) 후보: 7250(platform 이전) / 7252 / 7254 → 7252 선택, 실제 7252 건대입구 17:24:10 ±1분.
 * 시간표 단독(PR-C)은 1722 선택(+2~4분 known gap) — 주입을 빼면 이 테스트가 red가 된다.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { calculateEtaDetail, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import type { Route } from '../../../../shared/utils/stationRoute';
import { buildBoardableArrivalsAtTransfers } from '../boardableArrivalsAtTransfers';

const BACKEND_FIXTURES = join(__dirname, '../../../../backend/alarm-worker/src/__tests__/fixtures');
const KST_OFFSET_MS = 9 * 3_600_000;
const kst = (h: number, mi: number, s: number): number => Date.UTC(2026, 9, 28, h, mi, s) - KST_OFFSET_MS;

interface CapEntry {
  tMs: number;
  kind: string;
  target: string;
  body: string;
}
interface ArrivalRow {
  subwayId: string;
  updnLine: string;
  btrainNo: string;
  barvlDt: string;
}

/** caps cycle별 건대입구 7호선 arrival 원문 → (수신시각, 방향 bucket별 행). 비-JSON(522 등) 응답은 건너뛴다. */
function loadKunSnapshots(): Array<{ receivedAtMs: number; rows: ArrivalRow[] }> {
  const capsDir = join(BACKEND_FIXTURES, 'replay_20261028_trip180', 'caps');
  const snapshots: Array<{ receivedAtMs: number; rows: ArrivalRow[] }> = [];
  for (const file of readdirSync(capsDir).sort()) {
    const cap = JSON.parse(readFileSync(join(capsDir, file), 'utf8')) as { entries: CapEntry[] };
    for (const entry of cap.entries) {
      if (entry.kind !== 'arrival' || entry.target !== '건대입구') continue;
      let body: { realtimeArrivalList?: ArrivalRow[] };
      try {
        body = JSON.parse(entry.body);
      } catch {
        continue;
      }
      const rows = (body.realtimeArrivalList ?? []).filter((r) => r.subwayId === '1007');
      snapshots.push({ receivedAtMs: entry.tMs, rows });
    }
  }
  return snapshots;
}

describe('replay 10/28 trip 180 — 건대입구 7호선 실시간 boardable 주입 (#1480 PR-D)', () => {
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
  };
  const arrive3324 = kst(17, 16, 4);
  const platformMs = arrive3324 + (278 + 30) * 1000;
  const actual7252 = (() => {
    const fixture = JSON.parse(
      readFileSync(join(BACKEND_FIXTURES, 'capture_20261028_trip180_evening_7252.fixture.json'), 'utf8'),
    ) as { entries: Array<{ kind: string; body: string }> };
    for (const entry of fixture.entries) {
      if (entry.kind !== 'position') continue;
      let body: { realtimePositionList?: Array<{ trainNo: string; statnNm: string; trainSttus: string; recptnDt: string }> };
      try {
        body = JSON.parse(entry.body);
      } catch {
        continue;
      }
      const hit = (body.realtimePositionList ?? []).find(
        (r) => r.trainNo === '7252' && r.statnNm === '건대입구' && r.trainSttus === '1',
      );
      if (hit) {
        const [, t] = hit.recptnDt.split(' ');
        const [h, mi, s] = t.split(':').map(Number);
        return kst(h, mi, s);
      }
    }
    throw new Error('fixture: 7252 건대입구 관측 없음');
  })();

  // 3324 도착(17:16:04) 직전 cycle 스냅샷(17:15:25 수신, 39초 전 = fresh). 중곡 방향 = 7호선 상행 bucket.
  const snapshots = loadKunSnapshots();
  const at = snapshots.find((s) => s.receivedAtMs <= arrive3324 && arrive3324 - s.receivedAtMs <= 60_000);
  if (!at) throw new Error('fixture: 17:16:04 직전 건대입구 arrival 스냅샷 없음');
  const upTrains = at.rows
    .filter((r) => r.updnLine === '상행')
    .map((r) => ({ arrivalSeconds: Number(r.barvlDt), receivedAtMs: at.receivedAtMs, trainNo: r.btrainNo }));

  const etaWith = (list: typeof upTrains | null) =>
    calculateEtaDetail(0, route, {
      nowMs: arrive3324,
      excludeOriginWait: true,
      boardableArrivalsAtTransfers: list ? buildBoardableArrivalsAtTransfers(0, list) : undefined,
    });

  // 방향 필터(반대 방향 제외)는 useTransferTrainList.filterByDirection 소관 — 그 입력은 이미 진행 방향
  // bucket(상행)만이며 hook 테스트 'direction 확정 시 반대 방향 bucket은 섞이지 않는다'(#3029)가 잠근다.
  it('fixture sanity: 상행(중곡 방향) 후보는 7250(platform 이전 도착)·7252', () => {
    expect(upTrains.map((t) => t.trainNo)).toEqual(['7250', '7252']);
    const arrivalMs = (t: (typeof upTrains)[number]) => t.receivedAtMs + t.arrivalSeconds * 1000;
    expect(arrivalMs(upTrains[0])).toBeLessThan(platformMs); // 7250 17:18:25 — platform(17:21:12) 이전
    expect(arrivalMs(upTrains[1])).toBeGreaterThan(platformMs);
  });

  it('7250(platform 이전) 제외 → 7252 선택: 선택 시각이 실제 7252 건대입구 17:24:10 ±1분', () => {
    const eta = etaWith(upTrains);
    const [wait] = eta!.waits;
    expect(wait.source).toBe('realtime');
    const selectedMs = platformMs + wait.seconds * 1000;
    expect(Math.abs(selectedMs - actual7252)).toBeLessThanOrEqual(60_000);
  });

  it('주입이 없으면(시간표 단독, PR-C) 1722 선택 — 실제와 2분 초과 어긋난 known gap (revert-red 기준선)', () => {
    const eta = etaWith(null);
    const [wait] = eta!.waits;
    expect(wait.source).toBe('timetable');
    expect(platformMs + wait.seconds * 1000).toBe(kst(17, 22, 0));
    expect(actual7252 - (platformMs + wait.seconds * 1000)).toBeGreaterThan(120_000);
  });

  it('stale 스냅샷(수신 후 60초 초과)은 쓰지 않고 시간표로 폴백', () => {
    const eta = calculateEtaDetail(0, route, {
      nowMs: arrive3324 + 30_000, // 수신 후 69초
      excludeOriginWait: true,
      boardableArrivalsAtTransfers: buildBoardableArrivalsAtTransfers(0, upTrains),
    });
    expect(eta!.waits[0].source).toBe('timetable');
  });
});
