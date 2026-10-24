/**
 * #3100 — 취침 알람 collapse-id / dedup 키 호출부 가드.
 *
 * 칸별 id(`alarm-s{N}-…`)와 dedup 키(`…:s{N}`)는 두 함수가 같은 `remaining`을 받아야 서로 어긋나지 않는다.
 * 호출부가 `maybeFireSleepAlarm` 한 곳뿐이고 둘 다 `remaining` 인자를 넘기는지 소스 스캔으로 고정한다
 * (station-notif 쪽 `stationNotifCollapseIdCallsites.test.ts`는 sleep collapse를 다루지 않는다).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');

function productionSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : productionSources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/** 주석 제거 후 `marker(` 호출(정의 제외)의 괄호 안 인자 문자열 목록. */
function callArgs(source: string, marker: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf(`${marker}(`, from);
    if (at === -1) break;
    from = at + marker.length + 1;
    if (/function\s+$/.test(code.slice(0, at))) continue;
    let depth = 1;
    let i = from;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
      i += 1;
    }
    out.push(code.slice(from, i - 1));
  }
  return out;
}

describe('#3100 sleepAlarmCollapseId / sleepAlarmFireKey 호출부', () => {
  const sources = productionSources(SRC_DIR).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  it('sleepAlarmCollapseId 호출은 scheduled.ts 한 곳뿐이고 remaining 인자를 넘긴다', () => {
    const calls = sources.flatMap(({ file, text }) => callArgs(text, 'sleepAlarmCollapseId').map((args) => ({ file, args })));
    expect(calls).toHaveLength(1);
    expect(calls[0].file.endsWith('scheduled.ts')).toBe(true);
    expect(calls[0].args.split(',').length).toBe(3);
  });

  it('sleepAlarmFireKey 호출은 scheduled.ts 안에서 모두 remaining 인자를 넘긴다', () => {
    const calls = sources.flatMap(({ file, text }) => callArgs(text, 'sleepAlarmFireKey').map((args) => ({ file, args })));
    expect(calls.length).toBeGreaterThan(0);
    for (const { file, args } of calls) {
      expect(file.endsWith('scheduled.ts')).toBe(true);
      expect(args.split(',').length).toBe(3);
    }
  });
});
