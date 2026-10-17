import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, resolveWranglerCommand, runCli } from '../../scripts/cliUtils.mjs';

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

  describe('로컬 bin 없음 → npx --no-install fallback (#2598 리뷰 — 실제 빈 디렉토리로 검증, repo 부모 경로 의존 제거)', () => {
    let noBinDir: string;

    beforeEach(() => {
      // scriptDir/../node_modules/.bin/wrangler가 절대 존재할 수 없는 격리된 임시 디렉토리.
      // 이전 구현(scriptsDir의 조상 경로 하드코딩)은 repo 구조 변경에 취약했다.
      noBinDir = mkdtempSync(path.join(tmpdir(), 'resolve-wrangler-no-bin-'));
    });

    afterEach(() => {
      rmSync(noBinDir, { recursive: true, force: true });
    });

    it('npx --no-install wrangler로 fallback한다(unpinned 설치/interactive prompt 차단, PATH에 글로벌 wrangler 없어도 동작)', () => {
      expect(resolveWranglerCommand(noBinDir)).toEqual({ cmd: 'npx', prefixArgs: ['--no-install', 'wrangler'] });
    });
  });
});

describe('runCli — cwd 옵션 (#2600, fixtureFromTrip.mjs 공용화)', () => {
  // fake scriptDir/../node_modules/.bin/wrangler — 실행되면 자신의 cwd만 stdout에 찍는
  // 셔블 스크립트. resolveWranglerCommand가 이 fake 로컬 bin을 고르도록 scriptDir 트리를
  // 구성해, 실제 wrangler.toml/네트워크 없이 "cwd가 실제로 자식 프로세스에 전달되는가"만
  // 격리해서 검증한다.
  let fakeScriptDir: string;
  let workDir: string;

  beforeEach(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'run-cli-cwd-'));
    fakeScriptDir = path.join(root, 'scripts');
    workDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-cli-cwd-target-')));
    const binDir = path.join(root, 'node_modules', '.bin');
    mkdirSync(fakeScriptDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const fakeWranglerPath = path.join(binDir, 'wrangler');
    writeFileSync(fakeWranglerPath, '#!/usr/bin/env node\nprocess.stdout.write(process.cwd());\n');
    chmodSync(fakeWranglerPath, 0o755);
  });

  afterEach(() => {
    rmSync(path.dirname(fakeScriptDir), { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('cwd 옵션을 지정하면 자식 프로세스가 그 디렉토리에서 실행된다 (repo 루트 등 다른 위치에서 실행해도 wrangler.toml 발견)', () => {
    const output = runCli(fakeScriptDir, ['--version'], { cwd: workDir });
    expect(output).toBe(workDir);
  });

  it('cwd 옵션 미지정 시 기존 동작(현재 process.cwd()) 그대로 유지된다', () => {
    const output = runCli(fakeScriptDir, ['--version']);
    expect(output).toBe(process.cwd());
  });
});
