/* eslint-disable import/no-restricted-paths --
 * #3132 — fetch(arrival) → journeyAdapter(route) → 홈 행(arrival) 전 구간 replay. test-only.
 */
/**
 * #3132 잔여 PR-2 — 시간이 있는(known) 행이 0초까지 내려가면 "00:00" 대신 "곧 도착"(time.arrivingSoon).
 * fixture `korail_20261021/왕십리.json` 은 서울 열린데이터 원본 응답이며 **불변**.
 */
import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { act } from '@testing-library/react-native';
import { fetchArrivalInfo, parseRecptnDt } from '../api/arrivalApi';
import { arrivalInfoToArrivalTrain } from '../../route/utils/journeyAdapter';
import { EditorialArrivalRow } from '../components/EditorialArrivalRow';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import type { ArrivalInfo } from '../../../shared/types/arrival';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

const FIXTURE = path.join(__dirname, '..', '..', '..', 'testUtils', 'fixtures', 'korail_20261021', '왕십리.json');

/** 왕십리 fixture 를 `nowKst` 시각에 받은 것으로 파싱. */
async function parseAt(nowKst: string, trainCode: string): Promise<ArrivalInfo> {
  const body = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  jest.useFakeTimers().setSystemTime(parseRecptnDt(nowKst));
  process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body });
  const result = await fetchArrivalInfo('왕십리', { maxPerDirection: 99 });
  const hit = [...result.up, ...result.down].find((r) => r.trainCode === trainCode);
  if (!hit) throw new Error(`fixture row not found: ${trainCode}`);
  return hit;
}

function renderRow(info: ArrivalInfo) {
  const [train] = arrivalInfoToArrivalTrain([info], '방면', info.line);
  return renderWithTheme(<EditorialArrivalRow train={train} />);
}

describe('replay 20261021 known 행이 0 에 닿으면 곧 도착 (#3132)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    await i18next.changeLanguage('ko');
  });

  it('drift clamp: 왕십리 3244(2호선 cd5,b60, recptnDt 14:53:03) 를 14:54:10 에 받으면 "곧 도착"', async () => {
    const info = await parseAt('2026-10-21 14:54:10', '3244');
    // 원인: drift 67s > barvlDt 60 → 0 으로 접힘. cd5 이므로 상태 라벨 대상 아님.
    expect(info.arrivalSeconds).toBe(0);
    expect(info.arrivalCode).toBe(5);
    const { getByText, queryByText, getByTestId } = renderRow(info);
    expect(getByText(i18next.t('time.arrivingSoon'))).toBeTruthy();
    expect(queryByText('00:00')).toBeNull();
    expect(getByTestId('editorial-arrival-row').props.accessibilityLabel).toContain('곧 도착');
  });

  it('tick: 5126(b300) 은 299초 시점엔 "00:01", 300초 시점에 "곧 도착"', async () => {
    const info = await parseAt('2026-10-21 14:52:55', '5126');
    expect(info.arrivalSeconds).toBe(300);
    const { getByText, queryByText } = renderRow(info);
    act(() => {
      jest.advanceTimersByTime(299_000);
    });
    expect(getByText('00:01')).toBeTruthy();
    expect(queryByText('곧 도착')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(getByText('곧 도착')).toBeTruthy();
    expect(queryByText('00:00')).toBeNull();
  });

  it('en: 0 도달 시 "Arriving soon"', async () => {
    await i18next.changeLanguage('en');
    const info = await parseAt('2026-10-21 14:54:10', '3244');
    const { getByText } = renderRow(info);
    expect(getByText('Arriving soon')).toBeTruthy();
  });

  it('거부: positionLabel 행(상태 라벨 도착)은 "곧 도착" 이 아니라 상태 라벨 그대로', async () => {
    const info = await parseAt('2026-10-21 14:42:40', '6110');
    const { getByText, queryByText } = renderRow(info);
    expect(getByText('도착')).toBeTruthy();
    expect(queryByText('곧 도착')).toBeNull();
  });

  it('거부: 아직 남은 행(3248 b590)은 mm:ss 유지', async () => {
    const info = await parseAt('2026-10-21 14:53:03', '3248');
    const { getByText, queryByText } = renderRow(info);
    expect(getByText('09:50')).toBeTruthy();
    expect(queryByText('곧 도착')).toBeNull();
  });
});
