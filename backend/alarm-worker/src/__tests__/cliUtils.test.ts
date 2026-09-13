import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, resolveWranglerCommand } from '../../scripts/cliUtils.mjs';

describe('parseArgs', () => {
  it('--key value 쌍을 object로 파싱한다', () => {
    expect(parseArgs(['--trip', 'abc', '--out', '/tmp/x'])).toEqual({ trip: 'abc', out: '/tmp/x' });
  });

  it('-- 로 시작하지 않는 토큰은 무시한다', () => {
    expect(parseArgs(['stray', '--trip', 'abc'])).toEqual({ trip: 'abc' });
  });

  it('booleanFlags 없이 호출하면 모든 --key가 다음 토큰을 값으로 소비한다(기존 동작)', () => {
    expect(parseArgs(['--force'])).toEqual({ force: undefined });
  });

  describe('boolean flag 지원(#2586 코드리뷰 — 재현 확인된 버그 fix)', () => {
    it('bare boolean flag가 맨 끝에 오면 다음 토큰이 없어도 true로 설정된다', () => {
      expect(parseArgs(['--token-hash', 'aabbccdd', '--force'], ['force'])).toEqual({
        'token-hash': 'aabbccdd',
        force: true,
      });
    });

    it('bare boolean flag 뒤에 다른 --key value가 와도 삼키지 않는다(재현: --force --token-hash x)', () => {
      expect(parseArgs(['--force', '--token-hash', 'x'], ['force'])).toEqual({
        force: true,
        'token-hash': 'x',
      });
    });

    it('boolean flag가 여러 개면 전부 값 소비 없이 true', () => {
      expect(parseArgs(['--force', '--dry-run', '--out', '/tmp/x'], ['force', 'dry-run'])).toEqual({
        force: true,
        'dry-run': true,
        out: '/tmp/x',
      });
    });

    it('booleanFlags에 없는 키는 여전히 값 소비 동작을 유지한다(회귀 없음)', () => {
      expect(parseArgs(['--in', '/tmp/in', '--out', '/tmp/out'], ['force'])).toEqual({
        in: '/tmp/in',
        out: '/tmp/out',
      });
    });
  });
});

describe('resolveWranglerCommand (#2598 — bare wrangler spawn ENOENT 수리)', () => {
  const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
  const localBinPath = path.join(scriptsDir, '..', 'node_modules', '.bin', 'wrangler');

  it('scriptDir/../node_modules/.bin/wrangler가 존재하면 그 경로를 그대로 cmd로 쓴다', () => {
    // devDependency 로컬 설치를 전제 — repo 표준 워크플로우에서 항상 참이어야 한다.
    expect(existsSync(localBinPath)).toBe(true);

    expect(resolveWranglerCommand(scriptsDir)).toEqual({ cmd: localBinPath, prefixArgs: [] });
  });

  it('로컬 bin이 없는 baseDir이면 npx wrangler로 fallback한다(PATH에 글로벌 wrangler 없어도 동작)', () => {
    const noBinDir = path.join(scriptsDir, '..', '..', '..'); // node_modules/.bin/wrangler가 없는 상위 디렉토리

    expect(resolveWranglerCommand(noBinDir)).toEqual({ cmd: 'npx', prefixArgs: ['wrangler'] });
  });
});
