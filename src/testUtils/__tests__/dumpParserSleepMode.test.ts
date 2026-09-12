/**
 * #2068 — dumpParser: `## Sleep` 섹션 sleepMode=on|off 파싱 검증.
 *
 * DebugModal `buildSleepSection`(components/DebugModal.tsx:826) 출력 포맷:
 *   ## Sleep
 *   sleepMode=on|off
 *   firstHopApproaching=true|false
 *
 * sleep prop 미전달 시 `sleepMode=—`(UNKNOWN_LABEL) — on/off 매칭 실패 → undefined.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';

const FIXTURES_DIR = join(__dirname, '../fixtures/day2');

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
}

describe('parseDumpFixture — sleepMode 파싱', () => {
  it('sleepMode=off 파싱 (morning-trip.txt)', () => {
    const fixture = parseDumpFixture(loadFixture('morning-trip.txt'));
    expect(fixture.sleepMode).toBe('off');
  });

  it('sleepMode=off 파싱 (regression-general-mode-alarm-sound.txt)', () => {
    const fixture = parseDumpFixture(loadFixture('regression-general-mode-alarm-sound.txt'));
    expect(fixture.sleepMode).toBe('off');
  });

  it('sleepMode=on 파싱', () => {
    const text = `[Subway debug] 2026-07-29T00:10:00.000Z

## Sleep
sleepMode=on
firstHopApproaching=true
`;
    const fixture = parseDumpFixture(text);
    expect(fixture.sleepMode).toBe('on');
  });

  it('## Sleep 섹션 부재 시 undefined', () => {
    const text = `[Subway debug] 2026-07-29T00:10:00.000Z

## GPS
lat=37.5, lng=127.0, speed=- m/s, accuracy=10 m
`;
    const fixture = parseDumpFixture(text);
    expect(fixture.sleepMode).toBeUndefined();
  });

  it('sleep prop 미전달 (sleepMode=—, UNKNOWN_LABEL) → undefined', () => {
    const text = `[Subway debug] 2026-07-29T00:10:00.000Z

## Sleep
sleepMode=—
firstHopApproaching=—
`;
    const fixture = parseDumpFixture(text);
    expect(fixture.sleepMode).toBeUndefined();
  });
});
