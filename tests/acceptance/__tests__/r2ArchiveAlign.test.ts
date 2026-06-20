/**
 * r2ArchiveAlign 단위 테스트 (P0-4 / #1580).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ALARM_FIRED_KIND,
  extractAlarmEvents,
  listFixtureFiles,
  loadR2Trip,
  oneStopBefore,
  sliceTripWindow,
} from '../r2ArchiveAlign';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'r2archive-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('loadR2Trip', () => {
  it('valid ndjson을 파싱하고 빈 줄/주석을 무시', async () => {
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'a.ndjson');
      await fs.writeFile(
        p,
        [
          '{"ts":"2026-06-21T08:15:00+09:00","kind":"trip.started"}',
          '',
          '# 주석',
          '{"ts":"2026-06-21T08:20:00+09:00","kind":"alarm.fired","alarmType":"transfer-1-stop"}',
        ].join('\n'),
      );
      const events = await loadR2Trip(p);
      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe('trip.started');
    });
  });

  it('JSON parse 실패 시 라인 번호 포함 throw', async () => {
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'bad.ndjson');
      await fs.writeFile(p, '{"valid":true,"ts":"2026-06-21T08:00:00+09:00","kind":"x"}\nnot-json\n');
      await expect(loadR2Trip(p)).rejects.toThrow(/line 2 parse 실패/);
    });
  });

  it('필수 필드 누락 시 라인 번호 포함 throw', async () => {
    await withTmpDir(async (dir) => {
      const p = path.join(dir, 'bad.ndjson');
      await fs.writeFile(p, '{"kind":"x"}\n');
      await expect(loadR2Trip(p)).rejects.toThrow(/line 1.*ts.*kind/);
    });
  });
});

describe('sliceTripWindow', () => {
  const events = [
    { ts: '2026-06-21T08:00:00+09:00', kind: 'before' },
    { ts: '2026-06-21T08:15:00+09:00', kind: 'inclusive-start' },
    { ts: '2026-06-21T08:30:00+09:00', kind: 'middle' },
    { ts: '2026-06-21T08:50:00+09:00', kind: 'inclusive-end' },
    { ts: '2026-06-21T09:00:00+09:00', kind: 'after' },
  ];

  it('범위 내 event만 필터', () => {
    const result = sliceTripWindow(
      events,
      '2026-06-21T08:15:00+09:00',
      '2026-06-21T08:50:00+09:00',
    );
    expect(result.map((e) => e.kind)).toEqual(['inclusive-start', 'middle', 'inclusive-end']);
  });
});

describe('extractAlarmEvents', () => {
  const events = [
    { ts: '2026-06-21T08:20:00+09:00', kind: ALARM_FIRED_KIND, alarmType: 'transfer-1-stop' },
    { ts: '2026-06-21T08:30:00+09:00', kind: ALARM_FIRED_KIND, alarmType: 'destination-1-stop' },
    { ts: '2026-06-21T08:40:00+09:00', kind: 'trip.ended' },
    { ts: '2026-06-21T08:45:00+09:00', kind: ALARM_FIRED_KIND }, // alarmType 누락 → 제외
  ];

  it('alarmType 지정 시 해당 type만 반환', () => {
    expect(extractAlarmEvents(events, 'transfer-1-stop')).toHaveLength(1);
  });

  it('alarmType 미지정 시 모든 fired event (alarmType 있는 것만)', () => {
    expect(extractAlarmEvents(events)).toHaveLength(2);
  });
});

describe('oneStopBefore', () => {
  it('default 30s 차감', () => {
    const t = oneStopBefore('2026-06-21T08:30:00+09:00');
    expect(t).toBe(Date.parse('2026-06-21T08:29:30+09:00'));
  });

  it('hop millis 지정 가능', () => {
    const t = oneStopBefore('2026-06-21T08:30:00+09:00', 60_000);
    expect(t).toBe(Date.parse('2026-06-21T08:29:00+09:00'));
  });
});

describe('listFixtureFiles', () => {
  it('trip-ground-truth-*.json 만 수집, template은 제외', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'trip-ground-truth-2026-06-21-1.json'), '{}');
      await fs.writeFile(path.join(dir, 'trip-ground-truth-2026-06-21-2.json'), '{}');
      await fs.writeFile(path.join(dir, 'trip-ground-truth.template.json'), '{}');
      await fs.writeFile(path.join(dir, 'other.json'), '{}');
      const files = await listFixtureFiles(dir);
      expect(files).toHaveLength(2);
      expect(files.every((f) => f.endsWith('.json'))).toBe(true);
    });
  });

  it('디렉토리 없으면 빈 배열', async () => {
    const files = await listFixtureFiles('/tmp/definitely-not-exists-xyz-1580');
    expect(files).toEqual([]);
  });

  it('readdir이 ENOENT 외 에러를 던지면 propagate', async () => {
    const spy = jest.spyOn(fs, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { code: 'EACCES' }),
    );
    await expect(listFixtureFiles('/whatever')).rejects.toThrow('boom');
    spy.mockRestore();
  });
});
