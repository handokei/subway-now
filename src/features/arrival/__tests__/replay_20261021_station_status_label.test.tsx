/* eslint-disable import/no-restricted-paths --
 * #3132 — fetch(arrival) → journeyAdapter(route) → 홈 행(arrival) 전 구간 replay. test-only.
 */
/**
 * #3132 잔여 — arvlCd 0/1/2 행이 홈 카드에서 "00:00"/고정 01:00 카운트다운이던 회귀의 실측 replay.
 * fixture(`korail_20261021`, `korail_20261022`)는 서울 열린데이터 원본 응답이며 **불변**.
 * 기대값은 fixture 행(arvlCd/barvlDt)에서 읽은 값이다 — 구현을 보고 맞춘 것이 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { fetchArrivalInfo, parseRecptnDt } from '../api/arrivalApi';
import { arrivalInfoToArrivalTrain } from '../../route/utils/journeyAdapter';
import { EditorialArrivalRow } from '../components/EditorialArrivalRow';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

const FIXTURES_ROOT = path.join(__dirname, '..', '..', '..', 'testUtils', 'fixtures');
const STATUS_LABELS = ['진입', '도착', '출발'];

interface RawRow {
  recptnDt: string;
}

async function parseFixture(dir: string, station: string): Promise<StationArrival> {
  const body = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, dir, `${station}.json`), 'utf8'));
  const raw = body.realtimeArrivalList as RawRow[];
  jest.useFakeTimers().setSystemTime(parseRecptnDt(raw[0].recptnDt));
  process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
  return fetchArrivalInfo(station, { maxPerDirection: 99 });
}

function findRow(result: StationArrival, trainCode: string): ArrivalInfo {
  const hit = [...result.up, ...result.down].find((r) => r.trainCode === trainCode);
  if (!hit) throw new Error(`fixture row not found: ${trainCode}`);
  return hit;
}

function renderRow(info: ArrivalInfo) {
  const [train] = arrivalInfoToArrivalTrain([info], '방면', info.line);
  return { train, ...renderWithTheme(<EditorialArrivalRow train={train} />) };
}

function syntheticRow(overrides: Partial<ArrivalInfo>): ArrivalInfo {
  return {
    destination: '',
    arrivalSeconds: 0,
    stopsAway: null,
    statusMessage: '',
    trainCode: 'S',
    line: '2',
    receivedAtMs: 1_000,
    arrivalCode: 99,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

describe('replay 20261021 arvlCd 0/1/2 상태 라벨 (#3132)', () => {
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

  it('서울숲 6546(cd1,b0): 원인=known 0 → 우측에 "도착", 00:00 없음, arrivalAtMs 불변', async () => {
    const result = await parseFixture('korail_20261021', '서울숲');
    const info = findRow(result, '6546');
    expect(info.arrivalCode).toBe(1);
    expect(info.arrivalSeconds).toBe(0);
    const { train, getByTestId, queryByText } = renderRow(info);
    expect(train.arrivalAtMs).toBe(Date.now());
    expect(train.positionLabel).toEqual({ primary: '도착' });
    expect(getByTestId('editorial-arrival-position')).toBeTruthy();
    expect(queryByText('00:00')).toBeNull();
  });

  it('공덕 A2131(cd2,b0): "출발", 00:00 없음', async () => {
    const result = await parseFixture('korail_20261021', '공덕');
    const info = findRow(result, 'A2131');
    expect(info.arrivalCode).toBe(2);
    const { train, queryByText } = renderRow(info);
    expect(train.positionLabel).toEqual({ primary: '출발' });
    expect(queryByText('00:00')).toBeNull();
  });

  it('공덕 5122(5호선 cd1,b60 서울교통공사): 고정 60초 카운트다운이 아니라 "도착"', async () => {
    const result = await parseFixture('korail_20261021', '공덕');
    const info = findRow(result, '5122');
    expect(info.arrivalSeconds).toBe(60);
    const { train, queryByText } = renderRow(info);
    expect(train.positionLabel).toEqual({ primary: '도착' });
    expect(train.subtext).toBeUndefined();
    expect(queryByText('01:00')).toBeNull();
  });

  it('진입(cd0)은 "진입" — 직전역 locationStation 을 secondary 로 쓰지 않는다', () => {
    const info = syntheticRow({
      arrivalCode: 0,
      statusMessage: '청량리 진입',
      trainCode: '0098',
      line: '1',
      locationStation: '제기동',
    });
    const { train, getByText, queryByText } = renderRow(info);
    expect(train.positionLabel).toEqual({ primary: '진입' });
    expect(getByText('진입')).toBeTruthy();
    expect(queryByText('제기동')).toBeNull();
  });

  it('왕십리 6110(cd1,b0, recptnDt 625초 오래됨=stale): 그래도 "도착"', async () => {
    const result = await parseFixture('korail_20261021', '왕십리');
    jest.setSystemTime(parseRecptnDt('2026-10-21 14:53:05'));
    const { train } = renderRow(findRow(result, '6110'));
    expect(train.positionLabel).toEqual({ primary: '도착' });
  });

  it('거부: 6112([3]번째 전역) 는 기존 위치 문구 그대로', async () => {
    const result = await parseFixture('korail_20261021', '서울숲');
    const { train } = renderRow(findRow(result, '6112'));
    expect(train.positionLabel).toEqual({ primary: '3번째 전역', secondary: '선정릉' });
  });

  it('거부: 공덕 A1027(cd3,b0) 은 상태 라벨이 아니라 unknown 위치 문구', async () => {
    const result = await parseFixture('korail_20261021', '공덕');
    const info = findRow(result, 'A1027');
    expect(info.arrivalSeconds).toBeNull();
    const { train } = renderRow(info);
    expect(train.positionLabel).toEqual({ primary: '전역 출발', secondary: '서울' });
  });

  it('거부: 10/22 서울숲 6309(cd4,b0) 도 unknown 위치 문구, 상태 라벨 아님', async () => {
    const result = await parseFixture('korail_20261022', '서울숲');
    const info = findRow(result, '6309');
    expect(info.arrivalCode).toBe(4);
    const { train } = renderRow(info);
    expect(train.positionLabel).toEqual({ primary: '전역 진입', secondary: '왕십리' });
  });

  it('거부: cd 99 + barvlDt 90 은 "01:30" 유지', () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    const { train, getByText } = renderRow(syntheticRow({ arrivalSeconds: 90, receivedAtMs: 1_000_000 }));
    expect(train.positionLabel).toBeUndefined();
    expect(getByText('01:30')).toBeTruthy();
  });

  it('배지 없음: 도착 행에 arrival-status-badge-도착/진입 testID 가 없다', async () => {
    const result = await parseFixture('korail_20261021', '서울숲');
    const { queryByTestId } = renderRow(findRow(result, '6546'));
    expect(queryByTestId('arrival-status-badge-도착')).toBeNull();
    expect(queryByTestId('arrival-status-badge-진입')).toBeNull();
  });

  it('전수: korail_20261021 모든 파일 — 0/1/2 행 ⇔ 상태 라벨', async () => {
    const stations = fs.readdirSync(path.join(FIXTURES_ROOT, 'korail_20261021')).map((f) => f.replace('.json', ''));
    let checked = 0;
    for (const station of stations) {
      const result = await parseFixture('korail_20261021', station);
      for (const info of [...result.up, ...result.down]) {
        const [train] = arrivalInfoToArrivalTrain([info], '방면', info.line);
        const label = train.positionLabel?.primary ?? '';
        if ([0, 1, 2].includes(info.arrivalCode)) expect(STATUS_LABELS).toContain(label);
        else expect(STATUS_LABELS).not.toContain(label);
        checked += 1;
      }
      jest.useRealTimers();
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('arrival 상태 라벨 i18n 4개 언어', () => {
  const KEYS = ['arrival.statusEntering', 'arrival.statusArrived', 'arrival.statusDeparted'] as const;
  const LANGS = ['ko', 'en', 'ja', 'zh'];
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  it.each(LANGS.flatMap((l) => KEYS.map((k) => [l, k])))('%s %s 가 비어있지 않다', async (lang, key) => {
    await i18next.changeLanguage(lang);
    const v = i18next.t(key as (typeof KEYS)[number]);
    expect(v).not.toBe(key);
    expect(v.length).toBeGreaterThan(0);
  });

  it('en: 도착 행이 "Arrived"', async () => {
    await i18next.changeLanguage('en');
    const { getByText } = renderRow(syntheticRow({ arrivalCode: 1, statusMessage: 'x 도착' }));
    expect(getByText('Arrived')).toBeTruthy();
  });
});
