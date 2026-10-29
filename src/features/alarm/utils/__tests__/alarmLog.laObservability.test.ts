import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn().mockReturnValue({ remove: jest.fn() }) },
}));
jest.mock('../boardingPromptDailyCounters', () => ({
  recordBoardingPromptDailyCount: jest.fn().mockResolvedValue(undefined),
}));

import {
  clearAlarmLogWindows,
  flushAlarmLog,
  logLaRefreshDecision,
  logLaWrite,
  resetAlarmLogForTest,
  type AlarmLogEntry,
} from '../alarmLog';

async function savedEntries(): Promise<AlarmLogEntry[]> {
  await flushAlarmLog();
  const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
  if (calls.length === 0) return [];
  return JSON.parse(calls[calls.length - 1][1]) as AlarmLogEntry[];
}

const data = { stationName: '중곡', etaMinutes: 7, stopsRemaining: 3 };

describe('#2735 PR-1 la-write / la-refresh-decision 관측', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.setItem as jest.Mock).mockReset().mockResolvedValue(undefined);
    resetAlarmLogForTest();
    await clearAlarmLogWindows();
  });

  describe('logLaWrite', () => {
    it('writer·source·역·eta·stops·권위를 한 행에 싣는다', async () => {
      logLaWrite({ writer: 'D3', source: 'gps-bg', data, authority: 'not-active' });
      const [entry] = await savedEntries();
      expect(entry).toMatchObject({
        source: 'la-write',
        outcome: 'received',
        reason: 'la-write-D3',
        stationName: 'src=gps-bg;st=중곡;eta=7;stops=3;auth=not-active',
      });
    });

    it('etaMinutes/stopsRemaining가 없으면 "-"로 싣는다', async () => {
      logLaWrite({ writer: 'D5', source: 'pre-boarding', data: { stationName: '뚝섬' }, authority: 'n/a' });
      const [entry] = await savedEntries();
      expect(entry.stationName).toBe('src=pre-boarding;st=뚝섬;eta=-;stops=-;auth=n/a');
    });

    it('연속 동일값은 한 번만 적재한다', async () => {
      logLaWrite({ writer: 'D6', source: 'auto-locked', data, authority: 'n/a' });
      logLaWrite({ writer: 'D6', source: 'auto-locked', data, authority: 'n/a' });
      const entries = await savedEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].count).toBeUndefined();
    });

    it.each([
      ['writer', { writer: 'D7' as const }],
      ['source', { source: 'ensure-fg' }],
      ['역', { data: { ...data, stationName: '용마산' } }],
      ['eta', { data: { ...data, etaMinutes: 6 } }],
      ['stops', { data: { ...data, stopsRemaining: 2 } }],
      ['권위', { authority: 'backend-active' as const }],
    ])('%s가 바뀌면 다시 적재한다 (거부 케이스: dedup이 값 변화를 삼키지 않는다)', async (_label, patch) => {
      const base = { writer: 'D6' as const, source: 'auto-locked', data, authority: 'n/a' as const };
      logLaWrite(base);
      logLaWrite({ ...base, ...patch });
      expect(await savedEntries()).toHaveLength(2);
    });

    it('A→B→A 교번은 매번 적재한다(연속 동일만 접는다)', async () => {
      const a = { writer: 'D2' as const, source: 'backend-ssot', data, authority: 'unknown' as const };
      const b = { ...a, data: { ...data, stationName: '어린이대공원' } };
      logLaWrite(a);
      logLaWrite(b);
      logLaWrite(a);
      expect(await savedEntries()).toHaveLength(3);
    });

    it('trip 경계(clearAlarmLogWindows) 후에는 같은 값도 다시 적재한다', async () => {
      logLaWrite({ writer: 'D6', source: 'auto-locked', data, authority: 'n/a' });
      await clearAlarmLogWindows();
      logLaWrite({ writer: 'D6', source: 'auto-locked', data, authority: 'n/a' });
      // helper dedup이 풀려 두 번째가 appendAlarmLog에 도달 -> 직전 pending과 합산(count=2).
      // dedup이 살아 있으면 count가 비어 있다(위 '연속 동일값' 케이스).
      const [entry] = await savedEntries();
      expect(entry.count).toBe(2);
    });
  });

  describe('logLaRefreshDecision', () => {
    it('결정 행은 reason=la-decision-<결정>, detail은 stationName 슬롯', async () => {
      logLaRefreshDecision('stale-bg', 'age=61000');
      const [entry] = await savedEntries();
      expect(entry).toMatchObject({
        source: 'la-refresh-decision',
        outcome: 'received',
        reason: 'la-decision-stale-bg',
        stationName: 'age=61000',
      });
    });

    it('detail 생략 시 빈 문자열', async () => {
      logLaRefreshDecision('no-source');
      const [entry] = await savedEntries();
      expect(entry.stationName).toBe('');
    });

    it('wake마다 1행 — 같은 결정이 연속돼도 접지 않는다(mirror-advance-dedup 제외)', async () => {
      logLaRefreshDecision('backend-authority-skip');
      logLaRefreshDecision('gps-bg-write', '중곡');
      logLaRefreshDecision('gps-bg-write', '중곡');
      const entries = await savedEntries();
      expect(entries.map((e) => [e.reason, e.count ?? 1])).toEqual([
        ['la-decision-backend-authority-skip', 1],
        ['la-decision-gps-bg-write', 2],
      ]);
    });

    it('mirror-advance-dedup은 연속이면 1행만(BG tick ~10s 도배 방지), 다른 결정 뒤에는 다시 적재', async () => {
      logLaRefreshDecision('mirror-advance-dedup', '중곡:7');
      logLaRefreshDecision('mirror-advance-dedup', '중곡:7');
      logLaRefreshDecision('mirror-advance-dedup', '중곡:7');
      logLaRefreshDecision('mirror-write', '용마산');
      logLaRefreshDecision('mirror-advance-dedup', '용마산:7');
      const entries = await savedEntries();
      expect(entries.map((e) => e.reason)).toEqual([
        'la-decision-mirror-advance-dedup',
        'la-decision-mirror-write',
        'la-decision-mirror-advance-dedup',
      ]);
    });

    it('trip 경계 후 첫 mirror-advance-dedup은 다시 적재한다', async () => {
      logLaRefreshDecision('mirror-advance-dedup', 'a');
      await clearAlarmLogWindows();
      logLaRefreshDecision('mirror-advance-dedup', 'a');
      const [entry] = await savedEntries();
      expect(entry.count).toBe(2);
    });
  });
});
