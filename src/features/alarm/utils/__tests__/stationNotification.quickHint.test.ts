// #3177 PR-7b — 빠른하차 힌트를 event.stationId(역 id)로 조회한다.
// 시점 데이터에 묶이지 않도록 quickExit.json은 mock fixture로 고정하고(사당 4-025 / 까치산 5-009만 데이터 있음),
// 같은 이름 다른 노선 역에서 힌트가 그 id의 데이터만 따르는지 불변식으로 검증한다.
// stations.json은 실데이터를 쓴다.
import i18next from 'i18next';
import { buildAlarmContent } from '../stationNotification';
import { hasQuickExitData } from '../../../route/utils/quickExit';
import stationsData from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';
import type { AlarmEvent } from '../stationAlarm';

jest.mock('expo-notifications');
jest.mock('live-activity', () => ({}));
jest.mock('../alarmSound', () => ({ vibrateAlarm: jest.fn(), stopVibration: jest.fn() }));
jest.mock('../tts', () => ({ speakAlarm: jest.fn() }));
jest.mock('../alarmLog', () => ({ logExitSideUnknownStationId: jest.fn() }));
jest.mock('../../../../data/quickExit.json', () => ({
  '4-025': { stairs: [{ direction: 'up' }] },
  '5-009': { elevator: [{ direction: 'down' }] },
}));

const stations = stationsData as Station[];
const FIXTURE_IDS = ['4-025', '5-009'];

describe('buildAlarmContent 빠른하차 힌트 — event.stationId 기반 (#3177 PR-7b)', () => {
  const HINTS = {
    arrival: i18next.t('alarms.quickHintArrival'),
    transfer: i18next.t('alarms.quickHintTransfer'),
  };
  const hintLines = (event: AlarmEvent): string[] =>
    buildAlarmContent(event).body.split('\n').filter((l) => l === HINTS.arrival || l === HINTS.transfer);
  const eventOf = (stationId: string, type: AlarmEvent['type'] = 'destination'): AlarmEvent => {
    const found = stations.find((s) => s.id === stationId);
    if (!found) throw new Error(`stations.json에 없는 id: ${stationId}`);
    return { phaseId: 'early', type, stationName: found.name, stationId };
  };

  it('fixture가 의도대로 고정돼 있다', () => {
    expect(stations.filter((s) => hasQuickExitData(s.id)).map((s) => s.id).sort()).toEqual(FIXTURE_IDS);
  });

  it('힌트 문구가 서로 다른 실제 문장으로 해석된다', () => {
    expect(HINTS.arrival).not.toBe(HINTS.transfer);
    expect(HINTS.arrival).not.toBe('alarms.quickHintArrival');
  });

  it('전 역 전수: 힌트 유무 == hasQuickExitData(stationId)', () => {
    const mismatches = stations
      .filter((s) => hintLines(eventOf(s.id)).length !== (hasQuickExitData(s.id) ? 1 : 0))
      .map((s) => s.id);
    expect(mismatches).toEqual([]);
  });

  it.each(FIXTURE_IDS)('%s → 도착/환승 카피 각 1줄', (stationId) => {
    expect(hintLines(eventOf(stationId))).toEqual([HINTS.arrival]);
    expect(hintLines(eventOf(stationId, 'transfer'))).toEqual([HINTS.transfer]);
  });

  it.each(FIXTURE_IDS)('%s와 이름이 같은 다른 노선 역은 이름 첫 매칭으로 데이터를 빌리지 않는다', (stationId) => {
    const { stationName } = eventOf(stationId);
    const siblings = stations.filter((s) => s.name === stationName && s.id !== stationId);
    expect(siblings.length).toBeGreaterThan(0);
    for (const sibling of siblings) {
      expect(hintLines(eventOf(sibling.id))).toEqual([]);
    }
  });

  it('stationId가 없으면 이름이 같아도 힌트를 생략한다 (이름 대체 조회 금지)', () => {
    const { stationId: _omit, ...withoutId } = eventOf('4-025');
    expect(hintLines(withoutId as unknown as AlarmEvent)).toEqual([]);
  });

  it('stations.json에 없는 stationId도 힌트를 생략한다', () => {
    expect(hintLines({ ...eventOf('4-025'), stationId: 'nope-999' })).toEqual([]);
  });
});
