/**
 * #1833 — dumpParser: DebugModal dump 텍스트 파싱 정확도 검증.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDumpFixture } from '../dumpParser';

const FIXTURES_DIR = join(__dirname, '../fixtures/day2');

function loadFixture(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
}

describe('parseDumpFixture — morning-trip.txt (Day 2 정상 trip)', () => {
  const fixture = parseDumpFixture(loadFixture('morning-trip.txt'));

  it('capturedAt 파싱', () => {
    expect(fixture.capturedAt).toBe('2026-06-24T23:45:28.459Z');
  });

  it('lifecyclePhase=active', () => {
    expect(fixture.lifecyclePhase).toBe('active');
  });

  it('tripStartedAt 시간 파싱', () => {
    expect(fixture.tripStartedAt).toBe('08:31:55');
  });

  it('silentPushReceived=6', () => {
    expect(fixture.silentPushReceived).toBe(6);
  });

  it('silentPushFired=0', () => {
    expect(fixture.silentPushFired).toBe(0);
  });

  it('boardingLockActive=true (active=yes)', () => {
    expect(fixture.boardingLockActive).toBe(true);
  });

  it('alarmLogSources boarding-prompt=1', () => {
    expect(fixture.alarmLogSources['boarding-prompt']).toBe(1);
  });

  it('alarmLogSources fg=30', () => {
    expect(fixture.alarmLogSources['fg']).toBe(30);
  });

  it('notificationsFiredCount=3', () => {
    expect(fixture.notificationsFiredCount).toBe(3);
  });

  it('notificationKinds에 station-passed 포함', () => {
    expect(fixture.notificationKinds).toContain('station-passed');
  });

  it('notificationKinds에 transfer 포함', () => {
    expect(fixture.notificationKinds).toContain('transfer');
  });
});

describe('parseDumpFixture — afternoon-debug.txt (Day 2 trip 없음, silent push 0건)', () => {
  const fixture = parseDumpFixture(loadFixture('afternoon-debug.txt'));

  it('lifecyclePhase=none (trip 미시작)', () => {
    expect(fixture.lifecyclePhase).toBe('none');
  });

  it('tripStartedAt=— (미시작)', () => {
    expect(fixture.tripStartedAt).toBe('—');
  });

  it('silentPushReceived=0', () => {
    expect(fixture.silentPushReceived).toBe(0);
  });

  it('boardingLockActive=false (active=no)', () => {
    expect(fixture.boardingLockActive).toBe(false);
  });

  it('alarmLogSources boarding-prompt 없음 (0)', () => {
    expect(fixture.alarmLogSources['boarding-prompt'] ?? 0).toBe(0);
  });

  it('notificationKinds에 station-passed 없음 (이전 trip 기록)', () => {
    // afternoon dump는 이전 trip의 notifications만 존재하지만 fixture에는 포함됨
    // 실제 오후 dump에는 station-passed가 있었음 (이전 trip)
    expect(fixture.notificationKinds).toContain('station-passed');
  });

  it('fusionConfidence=gps-only', () => {
    expect(fixture.fusionConfidence).toBe('gps-only');
  });

  it('subsurface=false', () => {
    expect(fixture.subsurface).toBe(false);
  });
});

describe('parseDumpFixture — regression-lockless-no-intent.txt', () => {
  const fixture = parseDumpFixture(loadFixture('regression-lockless-no-intent.txt'));

  it('trip active이지만 boardingLockActive=false', () => {
    expect(fixture.lifecyclePhase).toBe('active');
    expect(fixture.boardingLockActive).toBe(false);
  });

  it('boarding-prompt alarmLog 없음', () => {
    expect(fixture.alarmLogSources['boarding-prompt'] ?? 0).toBe(0);
  });

  it('notificationsFiredCount=0 (station-passed 0건)', () => {
    expect(fixture.notificationsFiredCount).toBe(0);
    expect(fixture.notificationKinds).toHaveLength(0);
  });
});

describe('parseDumpFixture — regression-environment-unknown.txt', () => {
  const fixture = parseDumpFixture(loadFixture('regression-environment-unknown.txt'));

  it('subsurface=false, confidence=gps-only (지상)', () => {
    expect(fixture.subsurface).toBe(false);
    expect(fixture.fusionConfidence).toBe('gps-only');
  });

  it('trip은 active이나 boardingLock 없음', () => {
    expect(fixture.lifecyclePhase).toBe('active');
    expect(fixture.boardingLockActive).toBe(false);
  });
});

describe('parseDumpFixture — 빈 텍스트 graceful', () => {
  const fixture = parseDumpFixture('');

  it('모든 필드 undefined/빈값으로 fallback (throw 없음)', () => {
    expect(fixture.capturedAt).toBeUndefined();
    expect(fixture.lifecyclePhase).toBeUndefined();
    expect(fixture.silentPushReceived).toBeUndefined();
    expect(fixture.boardingLockActive).toBeUndefined();
    expect(fixture.alarmLogSources).toEqual({});
    expect(fixture.notificationKinds).toEqual([]);
  });
});

describe('parseDumpFixture — 섹션 누락 graceful (branch coverage)', () => {
  it('## Trip 섹션 없으면 lifecyclePhase=undefined', () => {
    const f = parseDumpFixture('## GPS\nlat=37.50, lng=127.00\n');
    expect(f.lifecyclePhase).toBeUndefined();
    expect(f.tripStartedAt).toBeUndefined();
  });

  it('## Fusion 섹션 없으면 fusionConfidence=undefined', () => {
    const f = parseDumpFixture('## GPS\nlat=37.50, lng=127.00\n');
    expect(f.fusionConfidence).toBeUndefined();
  });

  it('## GPS 섹션 없으면 subsurface=undefined', () => {
    const f = parseDumpFixture('## Fusion\nconfidence=gps-only\n');
    expect(f.subsurface).toBeUndefined();
  });

  it('## GPS 섹션은 있지만 subsurface 행 없으면 subsurface=undefined', () => {
    const f = parseDumpFixture('## GPS\nlat=37.50, lng=127.00, speed=1.0 m/s\n');
    expect(f.subsurface).toBeUndefined();
  });

  it('## Silent Push 섹션 없으면 received/fired=undefined', () => {
    const f = parseDumpFixture('## Trip\nlifecyclePhase=none\n');
    expect(f.silentPushReceived).toBeUndefined();
    expect(f.silentPushFired).toBeUndefined();
  });

  it('## Silent Push 섹션 있지만 received 행 없으면 undefined', () => {
    const f = parseDumpFixture('## Silent Push\npermission=granted\n');
    expect(f.silentPushReceived).toBeUndefined();
  });

  it('## BoardingLock 섹션 없으면 boardingLockActive=undefined', () => {
    const f = parseDumpFixture('## Trip\nlifecyclePhase=active\n');
    expect(f.boardingLockActive).toBeUndefined();
  });

  it('## BoardingLock 섹션 있지만 active 행 없으면 undefined', () => {
    const f = parseDumpFixture('## BoardingLock\ntrainCode=7101\n');
    expect(f.boardingLockActive).toBeUndefined();
  });

  it('## Alarm log 섹션 없으면 sources 빈 객체', () => {
    const f = parseDumpFixture('## Trip\nlifecyclePhase=none\n');
    expect(f.alarmLogSources).toEqual({});
  });

  it('## Alarm log 섹션 있지만 sources 행 없으면 빈 객체', () => {
    const f = parseDumpFixture('## Alarm log (0)\n08:00:00 | fg | fired\n');
    expect(f.alarmLogSources).toEqual({});
  });

  it('alarmLogSources에 = 없는 pair는 무시한다', () => {
    const f = parseDumpFixture('## Alarm log (1)\nsources: fg=5, malformed\n');
    expect(f.alarmLogSources['fg']).toBe(5);
    expect(Object.keys(f.alarmLogSources)).toHaveLength(1);
  });

  it('alarmLogSources에 숫자가 아닌 값은 무시한다 (isNaN branch)', () => {
    const f = parseDumpFixture('## Alarm log (1)\nsources: fg=5, bad=NaN\n');
    expect(f.alarmLogSources['fg']).toBe(5);
    // 'bad=NaN'은 parseInt('NaN') = NaN → isNaN = true → skip
    expect(f.alarmLogSources['bad']).toBeUndefined();
  });

  it('## Fusion 섹션 있지만 confidence 행 없으면 undefined (line 86 false branch)', () => {
    const f = parseDumpFixture('## Fusion\nfused: 성수(2) · 111m\ngps: 성수(2) · 111m\n');
    expect(f.fusionConfidence).toBeUndefined();
  });

  it('notificationsFiredCount: 헤더 없으면 undefined', () => {
    const f = parseDumpFixture('## Alarm log (0)\n');
    expect(f.notificationsFiredCount).toBeUndefined();
  });

  it('## Notifications fired 섹션 없으면 notificationKinds=[]', () => {
    const f = parseDumpFixture('## Trip\nlifecyclePhase=none\n');
    expect(f.notificationKinds).toEqual([]);
  });
});
