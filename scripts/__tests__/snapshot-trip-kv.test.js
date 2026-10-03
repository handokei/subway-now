/**
 * snapshot-trip-kv.sh (#1519) — 인자 검증 + mock wrangler로 NDJSON 출력 동작 검증.
 *
 * 실제 wrangler/Cloudflare를 호출하지 않고 WRANGLER_BIN 환경변수로 mock 명령을 주입한다.
 * --interval / --duration을 1초로 줄여 빠르게 1~2 sample만 캡처한다.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.resolve(__dirname, '..', 'snapshot-trip-kv.sh');
const BASH = '/bin/bash';

function makeMockWrangler(tmpDir, payload) {
  const mockPath = path.join(tmpDir, 'mock-wrangler.sh');
  const escaped = payload.replaceAll("'", String.raw`'\''`);
  fs.writeFileSync(
    mockPath,
    `#!/bin/bash\nprintf '%s' '${escaped}'\n`,
    { mode: 0o755 },
  );
  return mockPath;
}

function runSnapshot(prefix, payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-kv-'));
  const mock = makeMockWrangler(tmp, payload);
  const res = spawnSync(
    BASH,
    [SCRIPT, prefix, '--interval=1', '--duration=1'],
    { encoding: 'utf8', env: { ...process.env, WRANGLER_BIN: mock }, timeout: 15000 },
  );
  expect(res.status).toBe(0);
  const out = latestSnapshotFile(prefix);
  expect(out).toBeTruthy();
  const lines = readNdjson(out);
  return { lines, cleanup: () => fs.unlinkSync(out) };
}

function readNdjson(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function latestSnapshotFile(tokenPrefix) {
  const dir = path.join(REPO_ROOT, 'tasks');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('trip-kv-') && f.endsWith(`-${tokenPrefix}.jsonl`))
    .map((f) => path.join(dir, f));
  files.sort();
  return files.pop();
}

describe('snapshot-trip-kv.sh', () => {
  test('rejects invalid tokenPrefix', () => {
    const res = spawnSync(BASH, [SCRIPT, 'not-hex!'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/tokenPrefix/);
  });

  test('rejects missing tokenPrefix', () => {
    const res = spawnSync(BASH, [SCRIPT], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/tokenPrefix/);
  });

  test('rejects non-positive interval', () => {
    const res = spawnSync(BASH, [SCRIPT, 'abcd', '--interval=0'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/interval/);
  });

  test('rejects unknown flag', () => {
    const res = spawnSync(BASH, [SCRIPT, 'abcd', '--nope=1'], { encoding: 'utf8' });
    expect(res.status).toBe(2);
  });

  test('captures one sample with valid JSON KV payload', () => {
    const { lines, cleanup } = runSnapshot(
      'deadbeef',
      '{"currentLine":"2","lock":{"active":true,"stationName":"강남"}}',
    );
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatchObject({ kv: { currentLine: '2' } });
    expect(typeof lines[0].ts).toBe('string');
    cleanup();
  });

  test('records null when KV returns empty', () => {
    const { lines, cleanup } = runSnapshot('cafebabe', '');
    expect(lines[0].kv).toBeNull();
    expect(lines[0].error).toBeUndefined();
    cleanup();
  });

  test('records error when KV returns non-JSON garbage', () => {
    const { lines, cleanup } = runSnapshot('feedface', 'not-json-output');
    expect(lines[0].kv).toBeNull();
    expect(lines[0].error).toMatch(/not-json-output/);
    cleanup();
  });
});
