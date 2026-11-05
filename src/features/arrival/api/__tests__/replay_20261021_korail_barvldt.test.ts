/**
 * #3132 — 코레일 운영 노선 `barvlDt=0` = "시간 모름"을 0초로 해석해 00:00이 뜬 회귀의 실측 replay.
 *
 * fixture(`src/testUtils/fixtures/korail_20261021/*.json`)는 2026-10-21 14:50 KST에 서울 열린데이터
 * `realtimeStationArrival` 원본 응답을 그대로 캡처한 것이다 (API 키 없음). **불변** — 통과시키려고 조정 금지.
 * 기대값은 fixture 행(`barvlDt`/`arvlCd`/`arvlMsg2`)에서 곧바로 읽은 것이지 구현을 보고 맞춘 것이 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchArrivalInfo, parseRecptnDt } from '../arrivalApi';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', '..', 'testUtils', 'fixtures', 'korail_20261021');

interface RawRow {
  recptnDt: string;
  btrainNo: string;
  barvlDt: string;
  arvlCd: string;
  arvlMsg2: string;
  arvlMsg3: string;
  subwayId: string;
}

function loadFixture(station: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${station}.json`), 'utf8'));
}

async function parseFixture(station: string): Promise<{ result: StationArrival; raw: RawRow[] }> {
  const body = loadFixture(station);
  const raw = body.realtimeArrivalList as RawRow[];
  // recptnDt 시차 보정(drift)을 0으로 고정 — known 행의 초 값이 fixture 원값 그대로 남는다.
  jest.useFakeTimers().setSystemTime(parseRecptnDt(raw[0].recptnDt));
  process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
  const result = await fetchArrivalInfo(station, { maxPerDirection: 99 });
  return { result, raw };
}

function findRow(result: StationArrival, trainCode: string, arrivalCode?: number): ArrivalInfo {
  const all = [...result.up, ...result.down];
  const hit = all.find(
    (r) => r.trainCode === trainCode && (arrivalCode === undefined || r.arrivalCode === arrivalCode),
  );
  if (!hit) throw new Error(`fixture row not found: ${trainCode}/${arrivalCode}`);
  return hit;
}

describe('replay 20261021 코레일 barvlDt=0', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('서울숲 1075 3행: 도착(1)=0 유지, [3]번째 전역=null/3, 전역 도착(5)=null/1', async () => {
    const { result } = await parseFixture('서울숲');

    const arrived = findRow(result, '6546');
    expect(arrived.arrivalCode).toBe(1);
    expect(arrived.arrivalSeconds).toBe(0);
    expect(arrived.stopsAway).toBeNull();

    const far = findRow(result, '6112');
    expect(far.arrivalSeconds).toBeNull();
    expect(far.stopsAway).toBe(3);
    expect(far.statusMessage).toBe('[3]번째 전역 (선정릉)');
    expect(far.locationStation).toBe('선정릉');

    const prev = findRow(result, '6139');
    expect(prev.arrivalCode).toBe(5);
    expect(prev.arrivalSeconds).toBeNull();
    expect(prev.stopsAway).toBe(1);
    expect(prev.locationStation).toBe('왕십리');
  });

  it('청량리 1001 11행: 실값 2(120·cd5, 240·cd99) / 진입·도착 0행 2 / unknown 7', async () => {
    const { result, raw } = await parseFixture('청량리');
    const line1 = raw.filter((r) => r.subwayId === '1001');
    expect(line1).toHaveLength(11);
    const rows1001 = [...result.up, ...result.down].filter((r) => r.line === '1');
    expect(rows1001).toHaveLength(11);

    const seconds = rows1001.map((r) => r.arrivalSeconds);
    expect(seconds.filter((s) => s === null)).toHaveLength(7);
    expect(seconds.filter((s) => s === 0)).toHaveLength(2); // 청량리 진입(cd0) + 청량리 도착(cd1)
    expect(seconds.filter((s): s is number => s !== null && s > 0).sort((a, b) => a - b)).toEqual([120, 240]);

    // 진입(0)·도착(1)은 unknown이 아니라 진짜 0.
    for (const r of rows1001.filter((x) => x.arrivalCode === 0 || x.arrivalCode === 1)) {
      expect(r.arrivalSeconds).toBe(0);
    }
    // unknown 7행의 stopsAway: 상행 [2,23,41] 하행 [1(전역 도착),6,14,23]
    const unknownStops = rows1001
      .filter((r) => r.arrivalSeconds === null)
      .map((r) => r.stopsAway)
      .sort((a, b) => (a as number) - (b as number));
    expect(unknownStops).toEqual([1, 2, 6, 14, 23, 23, 41]);
  });

  it('거부: 선릉 2호선 행(4분 후=240 등)은 값·stopsAway 불변', async () => {
    const { result } = await parseFixture('선릉');
    const line2 = [...result.up, ...result.down].filter((r) => r.line === '2');
    expect(line2.map((r) => r.arrivalSeconds).sort((a, b) => (a as number) - (b as number))).toEqual([
      180, 240, 410, 560,
    ]);
    for (const r of line2) expect(r.stopsAway).toBeNull();
  });

  it('거부: 왕십리·공덕의 서울교통공사(2·5·6호선) 행은 전부 known, 그 위의 arvlCd 0/1/2 + barvlDt 0은 0', async () => {
    for (const station of ['왕십리', '공덕']) {
      const { result, raw } = await parseFixture(station);
      const all = [...result.up, ...result.down];
      const metroSubwayIds = new Set(['1002', '1005', '1006']);
      const metroCount = raw.filter((r) => metroSubwayIds.has(r.subwayId)).length;
      const metroRows = all.filter((r) => ['2', '5', '6'].includes(r.line));
      expect(metroRows).toHaveLength(metroCount);
      for (const r of metroRows) expect(r.arrivalSeconds).not.toBeNull();

      // 원본 barvlDt=0 이면서 arvlCd 0/1/2(진입·도착·출발)인 행은 unknown이 아니라 진짜 0.
      const rawZeroKnown = raw.filter((r) => r.barvlDt === '0' && ['0', '1', '2'].includes(r.arvlCd));
      expect(rawZeroKnown.length).toBeGreaterThan(0);
      for (const r of rawZeroKnown) {
        expect(findRow(result, r.btrainNo, Number(r.arvlCd)).arrivalSeconds).toBe(0);
      }
    }
  });

  it('공덕 1065: 전역 출발(cd3)+0 → null/1, 출발(cd2)+0 → 0', async () => {
    const { result } = await parseFixture('공덕');
    const prevDeparted = findRow(result, 'A1027');
    expect(prevDeparted.arrivalCode).toBe(3);
    expect(prevDeparted.arrivalSeconds).toBeNull();
    expect(prevDeparted.stopsAway).toBe(1);
    expect(findRow(result, 'A2131', 2).arrivalSeconds).toBe(0);
  });

  it('경계 입력: barvlDt 누락/-1 + arvlCd 누락 → null, arvlCd 누락이어도 barvlDt>0 이면 실값', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-21T05:50:30Z'));
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    const base = { subwayId: '1075', updnLine: '상행', trainLineNm: '왕십리행', recptnDt: '2026-10-21 14:50:30' };
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { ...base, btrainNo: 'A', arvlMsg2: 'x' },
          { ...base, btrainNo: 'B', barvlDt: '-1', arvlMsg2: 'x' },
          { ...base, btrainNo: 'C', barvlDt: '90', arvlMsg2: 'x' },
          { ...base, btrainNo: 'D', barvlDt: '0', arvlCd: '0', arvlMsg2: 'x 진입' },
        ],
      }),
    });
    const result = await fetchArrivalInfo('서울숲', { maxPerDirection: 99 });
    expect(findRow(result, 'A').arrivalSeconds).toBeNull();
    expect(findRow(result, 'B').arrivalSeconds).toBeNull();
    expect(findRow(result, 'C').arrivalSeconds).toBe(90);
    expect(findRow(result, 'D').arrivalSeconds).toBe(0);
  });
});
