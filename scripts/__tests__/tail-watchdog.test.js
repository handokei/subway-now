/**
 * tail-watchdog.sh (#1453) — 좀비 감지, log rotation, max-restarts shell 동작 검증.
 *
 * 실제 wrangler를 띄우지 않고 TAIL_CMD 환경변수로 mock 명령(`echo + sleep`)을 주입한다.
 * STALE_SECS / CHECK_INTERVAL / MAX_BYTES / MAX_RESTARTS를 짧게 줄여 빠르게 검증한다.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'tail-watchdog.sh');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tail-watchdog-'));
}

function runWatchdog(env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, 'test'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const softKill = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    // bash trap이 watchdog 서브셸 정리 race를 만들 수 있어 SIGKILL fallback으로 jest
    // open handle 누수를 막는다.
    const hardKill = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs + 1500);
    child.on('exit', (code) => {
      clearTimeout(softKill);
      clearTimeout(hardKill);
      // 자식의 watchdog 서브셸이 상속한 pipe end를 닫아 jest event loop를 풀어준다.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('tail-watchdog.sh', () => {
  jest.setTimeout(20000);

  test('writes to jsonl when TAIL_CMD emits lines', async () => {
    const dir = makeTmp();
    // mock: emit one line every 200ms for 3s, then exit
    const env = {
      OUT_DIR: dir,
      TAIL_CMD: 'for i in 1 2 3 4 5; do echo "{\\"i\\":$i}"; sleep 0.2; done',
      STALE_SECS: '60',
      CHECK_INTERVAL: '60',
      MAX_BYTES: '10485760',
      MAX_RESTARTS: '100',
      RESPAWN_SLEEP: '1',
    };
    const p = runWatchdog(env, 2500);
    await p;
    const jsonl = fs.readFileSync(path.join(dir, 'wrangler-tail-watchdog.jsonl'), 'utf8');
    expect(jsonl).toMatch(/"i":1/);
    expect(jsonl).toMatch(/"i":5/);
  });

  test('rotates jsonl when MAX_BYTES exceeded', async () => {
    const dir = makeTmp();
    // pre-seed jsonl above rotation threshold so first rotate fires before spawn
    fs.writeFileSync(path.join(dir, 'wrangler-tail-watchdog.jsonl'), 'x'.repeat(200));
    const env = {
      OUT_DIR: dir,
      TAIL_CMD: 'echo "fresh"; sleep 0.2',
      STALE_SECS: '60',
      CHECK_INTERVAL: '60',
      MAX_BYTES: '100', // 100 bytes → pre-seeded 200B triggers rotation
      MAX_RESTARTS: '100',
      RESPAWN_SLEEP: '1',
    };
    await runWatchdog(env, 1500);
    const files = fs.readdirSync(dir);
    const rotated = files.filter((f) => /wrangler-tail-watchdog\.jsonl\.\d+/.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  test('stops with ALERT when MAX_RESTARTS exceeded', async () => {
    const dir = makeTmp();
    const env = {
      OUT_DIR: dir,
      // tail command exits immediately → forces respawn each iteration
      TAIL_CMD: 'echo "{\\"x\\":1}"; exit 0',
      STALE_SECS: '600',
      CHECK_INTERVAL: '600',
      MAX_BYTES: '10485760',
      MAX_RESTARTS: '3',
      RESPAWN_SLEEP: '0.1',
    };
    const { code } = await runWatchdog(env, 8000);
    // Should self-exit (code 0 via cleanup) before SIGTERM at 8s
    await sleep(50);
    const alert = fs.readFileSync(path.join(dir, 'wrangler-tail-watchdog.alert'), 'utf8');
    expect(alert).toMatch(/max-restarts/);
    expect(code).toBe(0);
  });
});
