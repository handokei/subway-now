// #3177 PR-7b — 빠른하차 힌트를 event.stationId(역 id)로 조회한다. 실데이터(mock 금지) 표 테스트.
// 이름 첫 매칭 때문에 533개 역 중 73건이 어긋났다(72건은 힌트가 없어야 하는데 표시, 1건은 있어야 하는데 누락).
// 표는 stations.json + src/data/quickExit.json 실측이며 통과시키려고 조정하지 않는다.
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

const stations = stationsData as Station[];

// 힌트가 없어야 하는데 다른 노선 데이터로 표시되던 72건 (stationId)
const SPURIOUS_HINT: readonly string[] = [
  '2-001', '2-034', '2-205', '3-021', '3-022', '3-032', '4-004', '4-013', '4-014', '4-015', '4-018', '4-025',
  '5-014', '5-016', '5-022', '5-025', '5-026', '5-027', '5-031', '5-043', '7-002', '7-005', '7-017', '7-019',
  '7-026', '7-036', '9-002', '9-013', '9-015', '9-020', '9-023', '9-030', '9-036', '6-003', '6-005', '6-013',
  '6-017', '6-019', '6-024', '6-025', '6-026', '6-027', '6-035', '6-036', '8-002', '8-005', '8-008',
  'airport-001', 'airport-002', 'airport-003', 'airport-004', 'airport-006',
  'gyeongui-020', 'gyeongui-022', 'gyeongui-024', 'gyeongui-025', 'gyeongui-026', 'gyeongui-027',
  'gyeongui-029', 'gyeongui-032', 'gyeongui-034', 'gyeongui-035', 'gyeongui-039', 'gyeongui-054',
  'bundang-042', 'bundang-046', 'bundang-048', 'bundang-050',
  'sinbundang-012', 'sinbundang-013', 'sinbundang-015', 'sinbundang-016',
];
// 힌트가 있어야 하는데 누락되던 1건
const MISSING_HINT: readonly string[] = ['5-009'];

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

  it('표 개수와 실데이터가 일치한다 (72 + 1 = 73)', () => {
    expect([SPURIOUS_HINT.length, MISSING_HINT.length]).toEqual([72, 1]);
    for (const id of SPURIOUS_HINT) expect(hasQuickExitData(id)).toBe(false);
    for (const id of MISSING_HINT) expect(hasQuickExitData(id)).toBe(true);
  });

  it('힌트 문구가 서로 다른 실제 문장으로 해석된다', () => {
    expect(HINTS.arrival).not.toBe(HINTS.transfer);
    expect(HINTS.arrival).not.toBe('alarms.quickHintArrival');
  });

  it.each(SPURIOUS_HINT)('%s → 데이터가 없으므로 힌트 0줄 (다른 노선 값 차용 금지)', (stationId) => {
    expect(hintLines(eventOf(stationId))).toEqual([]);
    expect(hintLines(eventOf(stationId, 'transfer'))).toEqual([]);
  });

  it.each(MISSING_HINT)('%s → 데이터가 있으므로 도착/환승 카피 각 1줄', (stationId) => {
    expect(hintLines(eventOf(stationId))).toEqual([HINTS.arrival]);
    expect(hintLines(eventOf(stationId, 'transfer'))).toEqual([HINTS.transfer]);
  });

  it('전 역 전수: 힌트 유무 == hasQuickExitData(stationId)', () => {
    const mismatches = stations
      .filter((s) => hintLines(eventOf(s.id)).length !== (hasQuickExitData(s.id) ? 1 : 0))
      .map((s) => s.id);
    expect(mismatches).toEqual([]);
  });

  it('stationId가 없으면 이름이 같아도 힌트를 생략한다 (이름 대체 조회 금지)', () => {
    const { stationId: _omit, ...withoutId } = eventOf('5-009');
    expect(hintLines(withoutId)).toEqual([]);
  });

  it('stations.json에 없는 stationId도 힌트를 생략한다', () => {
    expect(hintLines({ ...eventOf('5-009'), stationId: 'nope-999' })).toEqual([]);
  });
});
