// #3177 PR-7a — 하차문 좌/우를 event.stationId(id 기반)로만 판정한다. 실데이터(mock 금지) 표 테스트.
// 표 출처: 이슈 #3177 §1.2 (공식 CSV 두 개로 확정한 정답). 데이터는 실측이며 통과시키려고 조정하지 않는다.
import i18next from 'i18next';
import { buildAlarmContent } from '../stationNotification';
import { resolveExitSideForStation } from '../../../../shared/utils/resolveExitSideForStation';
import stationsData from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';
import type { AlarmEvent } from '../stationAlarm';

jest.mock('expo-notifications');
jest.mock('live-activity', () => ({}));
jest.mock('../alarmSound', () => ({ vibrateAlarm: jest.fn(), stopVibration: jest.fn() }));
jest.mock('../tts', () => ({ speakAlarm: jest.fn() }));

const mockLogExitSideUnknownStationId = jest.fn();
jest.mock('../alarmLog', () => ({
  logExitSideUnknownStationId: (...args: unknown[]) => mockLogExitSideUnknownStationId(...args),
}));

type Side = 'left' | 'right';
const stations = stationsData as Station[];
const nameOf = (id: string): string => {
  const found = stations.find((s) => s.id === id);
  if (!found) throw new Error(`stations.json에 없는 id: ${id}`);
  return found.name;
};

// §1.2 WRONG 15건 — 정답(현재는 반대 문을 안내)
const WRONG: ReadonlyArray<[string, Side]> = [
  ['3-022', 'left'], ['3-032', 'left'], ['4-014', 'left'], ['4-015', 'right'], ['4-025', 'left'],
  ['5-026', 'left'], ['5-027', 'left'], ['7-005', 'left'], ['7-017', 'right'], ['6-005', 'right'],
  ['6-017', 'right'], ['6-019', 'left'], ['6-024', 'right'], ['6-025', 'right'], ['6-026', 'left'],
];
// §1.2 MISSING 14건 — 값이 있는데 안내가 생략되던 역
const MISSING: ReadonlyArray<[string, Side]> = [
  ['2-001', 'left'], ['2-205', 'right'], ['3-021', 'left'], ['4-004', 'right'], ['4-013', 'left'],
  ['4-018', 'left'], ['5-009', 'right'], ['5-016', 'right'], ['5-025', 'left'], ['7-002', 'right'],
  ['7-038', 'right'], ['6-027', 'left'], ['6-035', 'right'], ['8-006', 'right'],
];
// §1.2 SPURIOUS 30건 — 데이터가 없는데 다른 노선 값이 표시되던 역(정답 = 안내 생략)
const SPURIOUS: readonly string[] = [
  '9-002', '9-013', '9-015', '9-020', '9-023', '9-030', '9-036',
  'airport-002', 'airport-003', 'airport-004', 'airport-006',
  'gyeongui-020', 'gyeongui-022', 'gyeongui-024', 'gyeongui-025', 'gyeongui-026', 'gyeongui-029',
  'gyeongui-032', 'gyeongui-034', 'gyeongui-039', 'gyeongui-054',
  'bundang-039', 'bundang-046', 'bundang-048', 'bundang-050', 'bundang-041a',
  'sinbundang-012', 'sinbundang-013', 'sinbundang-015', 'sinbundang-016',
];
// §1.2 이름 표기가 다른 역(왕십리)
const WANGSIMNI: ReadonlyArray<[string, Side | null]> = [
  ['2-008', 'right'], ['5-031', 'right'], ['bundang-053', null],
];

const DIRECTIONS = [undefined, 'up', 'down'] as const;
const TERMINI = ['unknown', 'here', 'elsewhere'] as const;

describe('resolveExitSideForStation — #3177 §1.2 실데이터 표', () => {
  it('표 개수가 스펙과 일치한다 (WRONG 15 / MISSING 14 / SPURIOUS 30 / 왕십리 3)', () => {
    expect([WRONG.length, MISSING.length, SPURIOUS.length, WANGSIMNI.length]).toEqual([15, 14, 30, 3]);
  });

  it.each([...WRONG, ...MISSING])('%s → %s (platform, 방향·종착 조합 무관)', (stationId, side) => {
    for (const direction of DIRECTIONS) {
      for (const terminus of TERMINI) {
        expect(resolveExitSideForStation({ stationId, direction, terminus })).toEqual({
          side,
          reason: 'platform',
        });
      }
    }
  });

  it.each(SPURIOUS)('%s → 데이터 없음(null, no-data) — 다른 노선 값을 빌려오지 않는다', (stationId) => {
    for (const direction of DIRECTIONS) {
      expect(resolveExitSideForStation({ stationId, direction, terminus: 'unknown' })).toEqual({
        side: null,
        reason: 'no-data',
      });
    }
  });

  it.each(WANGSIMNI)('%s (이름 표기 차이 역)', (stationId, side) => {
    expect(resolveExitSideForStation({ stationId, terminus: 'unknown' })).toEqual(
      side ? { side, reason: 'platform' } : { side: null, reason: 'no-data' },
    );
  });

  it('stations.json에 없는 id는 unknown-station-id', () => {
    expect(resolveExitSideForStation({ stationId: 'nope-999', terminus: 'unknown' })).toEqual({
      side: null,
      reason: 'unknown-station-id',
    });
  });

  it('방향별 위키 확정값: 성수(2-011) 외선 당역 종착은 left(directional), 통과는 right', () => {
    expect(resolveExitSideForStation({ stationId: '2-011', direction: 'down', terminus: 'here' })).toEqual({
      side: 'left',
      reason: 'directional',
    });
    expect(resolveExitSideForStation({ stationId: '2-011', direction: 'down', terminus: 'elsewhere' })).toEqual({
      side: 'right',
      reason: 'directional',
    });
  });

  it('방향별 항목은 있으나 단정 근거가 없으면 directional-undetermined (구조값으로 대체하지 않는다)', () => {
    expect(resolveExitSideForStation({ stationId: '2-011', direction: 'down', terminus: 'unknown' })).toEqual({
      side: null,
      reason: 'directional-undetermined',
    });
  });
});

describe('buildAlarmContent 본문 줄 — event.stationId 기반', () => {
  const LEFT = i18next.t('alarms.exitSideLeft');
  const RIGHT = i18next.t('alarms.exitSideRight');
  const exitSideLines = (event: AlarmEvent): string[] =>
    buildAlarmContent(event).body.split('\n').filter((line) => line === LEFT || line === RIGHT);
  const eventOf = (stationId: string): AlarmEvent => ({
    phaseId: 'early',
    type: 'destination',
    stationName: nameOf(stationId),
    stationId,
  });

  beforeEach(() => mockLogExitSideUnknownStationId.mockClear());

  it('문구 키가 실제로 서로 다른 한글 문장으로 해석된다 (빈 문자열 비교 방지)', () => {
    expect(LEFT).not.toBe(RIGHT);
    expect(LEFT).not.toBe('alarms.exitSideLeft');
  });

  it.each([...WRONG, ...MISSING])('%s → %s 줄이 정확히 1개', (stationId, side) => {
    expect(exitSideLines(eventOf(stationId))).toEqual([side === 'left' ? LEFT : RIGHT]);
  });

  it.each([...SPURIOUS, 'bundang-053'])('%s → 좌/우 줄 0개', (stationId) => {
    expect(exitSideLines(eventOf(stationId))).toEqual([]);
  });

  it.each(WANGSIMNI.filter(([, side]) => side))('%s (왕십리) → 1개', (stationId, side) => {
    expect(exitSideLines(eventOf(stationId))).toEqual([side === 'left' ? LEFT : RIGHT]);
  });

  it('같은 이름 역이라도 stationId의 노선 문 방향을 따른다 (사당 4호선 4-025 left)', () => {
    expect(exitSideLines({ ...eventOf('4-025'), stationName: '사당' })).toEqual([LEFT]);
  });

  it('stationId가 없는 이벤트는 이름이 같아도 좌/우 줄 0개 + unknown 로그', () => {
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '사당', direction: 'up' };
    expect(exitSideLines(event)).toEqual([]);
    expect(mockLogExitSideUnknownStationId).toHaveBeenCalledWith('사당');
  });

  it('stationId가 stations.json에 없어도 줄 0개 + 같은 로그', () => {
    expect(exitSideLines({ ...eventOf('4-025'), stationId: 'nope-999' })).toEqual([]);
    expect(mockLogExitSideUnknownStationId).toHaveBeenCalledWith('사당');
  });

  it('정상 stationId 이벤트는 unknown 로그를 남기지 않는다', () => {
    exitSideLines(eventOf('4-025'));
    expect(mockLogExitSideUnknownStationId).not.toHaveBeenCalled();
  });

  it('데이터 없음(no-data)은 id가 유효하므로 unknown 로그를 남기지 않는다', () => {
    exitSideLines(eventOf('9-002'));
    expect(mockLogExitSideUnknownStationId).not.toHaveBeenCalled();
  });
});
