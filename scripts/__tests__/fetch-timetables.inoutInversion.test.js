/**
 * #1480: INOUT_TAG 극성 반전 노선 (lineTopology.timetableInoutInvertedLines).
 * 9호선은 Seoul INOUT_TAG=1이 앱 규약상 down(개화 출발, idx 증가)이다.
 */

'use strict';

const fs = require('node:fs');

const { fetchStation, processLine, loadInvertedInoutLines } = require('../fetch-timetables');

function mockOk(json) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
}
function noopSleep() {
  return Promise.resolve();
}
function inoutEchoFetch() {
  return jest.fn((url) => {
    const inout = url.split('/').at(-1);
    return mockOk({
      SearchSTNTimeTableByFRCodeService: { row: [{ STATION_NM: '개화', ARRIVETIME: `05:0${inout}:00` }] },
    });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('loadInvertedInoutLines', () => {
  it('lineTopology 키를 Set으로 돌려준다 (9호선 포함, 3호선 제외)', () => {
    const set = loadInvertedInoutLines();
    expect(set.has('9')).toBe(true);
    expect(set.has('3')).toBe(false);
  });
});

describe('fetchStation invertInout', () => {
  it('true면 INOUT_TAG=1 → down, 2 → up으로 저장한다', async () => {
    const { timetable } = await fetchStation('KEY', '901', {
      fetchImpl: inoutEchoFetch(),
      sleepImpl: noopSleep,
      invertInout: true,
    });
    expect(timetable.weekday.down).toEqual(['0501']);
    expect(timetable.weekday.up).toEqual(['0502']);
    expect(timetable.sunday.down).toEqual(['0501']);
    expect(timetable.sunday.up).toEqual(['0502']);
  });
});

describe('processLine 반전 적용 범위', () => {
  it('반전 노선(9)에만 적용하고 다른 노선(3)은 그대로 저장한다', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const writes = [];
    jest.spyOn(fs, 'writeFileSync').mockImplementation((p, body) => writes.push(JSON.parse(body)));
    const deps = { fetchImpl: inoutEchoFetch(), sleepImpl: noopSleep, log: () => {} };
    await processLine('KEY', '9', new Set(['901']), deps);
    await processLine('KEY', '3', new Set(['301']), deps);
    expect(writes[0].stations['개화'].weekday.down).toEqual(['0501']);
    expect(writes[1].stations['개화'].weekday.up).toEqual(['0501']);
  });
});
