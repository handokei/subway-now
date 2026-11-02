import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #2510 재오픈 (2026-11-02) — alarm.wav 우회 차단 가드 (`noRawSqlGuard.test.ts` 관례).
 *
 * 일반(비취침) 모드에서 alarm.wav가 나가는 사고(#2158 → #2510 → 11/02 트립 186)는 매번 발사 지점마다
 * `sound: 'alarm.wav'`를 직접 쓰면서 재발했다. 이제 리터럴은 정책 표(`alertSoundPolicy.ts`) 한 곳에만 둔다.
 *  1) backend 비테스트 코드의 `'alarm.wav'` 리터럴 **매치 총수 = 1**, 그 1건이 alertSoundPolicy.ts.
 *  2) alertSoundPolicy.ts의 export 이름 집합이 허용목록과 정확히 일치 — `ALARM` 상수·`AlarmOn` 타입을
 *     export해 정책 표를 우회하는 길을 막는다.
 */
const SRC_DIR = join(__dirname, '..');
const POLICY_FILE = join(SRC_DIR, 'alertSoundPolicy.ts');
const ALARM_LITERAL = /['"]alarm\.wav['"]/g;

const ALLOWED_EXPORTS = [
  'ArrivalContent',
  'OneStopContent',
  'STATION_ALERT_POLICY',
  'StationAlertKind',
  'TripMode',
  'resolveStationAlert',
  'sendStationAlert',
  'stationAlertKind',
  'tripMode',
];

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('alarm.wav 리터럴 가드 (#2510)', () => {
  it("backend 비테스트 코드의 'alarm.wav' 리터럴은 정확히 1건이고 alertSoundPolicy.ts 안에 있다", () => {
    const matches: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const count = (readFileSync(file, 'utf-8').match(ALARM_LITERAL) ?? []).length;
      for (let i = 0; i < count; i += 1) matches.push(file.replace(`${SRC_DIR}/`, ''));
    }
    expect(matches).toEqual(['alertSoundPolicy.ts']);
  });

  it('alertSoundPolicy.ts export 이름 집합이 허용목록과 정확히 일치한다', () => {
    const source = readFileSync(POLICY_FILE, 'utf-8');
    const names = [...source.matchAll(/^export\s+(?:async\s+)?(?:const|function|type|interface)\s+(\w+)/gm)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual([...ALLOWED_EXPORTS].sort());
  });
});
