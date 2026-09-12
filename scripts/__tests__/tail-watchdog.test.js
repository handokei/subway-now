/**
 * tail-watchdog.sh (#1453) — 좀비 감지, log rotation, max-restarts shell 동작 검증.
 *
 * 실제 wrangler를 띄우지 않고 TAIL_CMD 환경변수로 mock 명령(`echo + sleep`)을 주입한다.
 * STALE_SECS / CHECK_INTERVAL / MAX_BYTES / MAX_RESTARTS를 짧게 줄여 빠르게 검증한다.
 *
 * 타이밍-독립 패턴: 고정 timeout으로 sleep하지 않고 "조건을 만족할 때까지 poll" 후
 * SIGTERM으로 종료한다. CI runner의 spawn cost 변동에 영향받지 않는다.
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// SonarCloud S4036 — bash 절대경로로 PATH 해석 의존성 제거.
const BASH = '/bin/bash';

/**
 * Spawn the watchdog and return { child, exited }. Caller decides when to kill.
 * Caller MUST call `child.kill()` and `await exited` to avoid jest open handles.
 */
function spawnWatchdog(env) {
  const child = spawn(BASH, [SCRIPT, 'test'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      // 자식의 watchdog 서브셸이 상속한 pipe end를 닫아 jest event loop를 풀어준다.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout: () => stdout, stderr: () => stderr });
    });
  });
  return { child, exited };
}

/**
 * Poll `predicate()` every `intervalMs` until it returns true or `maxMs` elapses.
 * Returns true if predicate met, false on timeout.
 */
async function pollUntil(predicate, maxMs, intervalMs = 50) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

async function killAndAwait(child, exited, hardKillMs = 1500) {
  child.kill('SIGTERM');
  const hardKill = setTimeout(() => child.kill('SIGKILL'), hardKillMs);
  try {
    return await exited;
  } finally {
    clearTimeout(hardKill);
  }
}

describe('tail-watchdog.sh', () => {
  jest.setTimeout(30000);

  test('writes to jsonl when TAIL_CMD emits lines', async () => {
    const dir = makeTmp();
    const jsonlPath = path.join(dir, 'wrangler-tail-watchdog.jsonl');
    // mock: emit one line every 200ms for 1s+, exit. We poll until lines 1 & 5 appear.
    const env = {
      OUT_DIR: dir,
      TAIL_CMD: String.raw`for i in 1 2 3 4 5; do echo "{\"i\":$i}"; sleep 0.2; done`,
      STALE_SECS: '60',
      CHECK_INTERVAL: '60',
      MAX_BYTES: '10485760',
      MAX_RESTARTS: '100',
      RESPAWN_SLEEP: '1',
    };
    const { child, exited } = spawnWatchdog(env);
    const ok = await pollUntil(() => {
      if (!fs.existsSync(jsonlPath)) return false;
      const c = fs.readFileSync(jsonlPath, 'utf8');
      return /"i":1/.test(c) && /"i":5/.test(c);
    }, 15000);
    await killAndAwait(child, exited);
    expect(ok).toBe(true);
    const jsonl = fs.readFileSync(jsonlPath, 'utf8');
    expect(jsonl).toMatch(/"i":1/);
    expect(jsonl).toMatch(/"i":5/);
  });

  test('rotates jsonl when MAX_BYTES exceeded', async () => {
    const dir = makeTmp();
    // pre-seed jsonl above rotation threshold so first rotate fires before spawn
    fs.writeFileSync(path.join(dir, 'wrangler-tail-watchdog.jsonl'), 'x'.repeat(200));
    const env = {
      OUT_DIR: dir,
      TAIL_CMD: 'echo "fresh"; sleep 5',
      STALE_SECS: '60',
      CHECK_INTERVAL: '60',
      MAX_BYTES: '100', // 100 bytes → pre-seeded 200B triggers rotation
      MAX_RESTARTS: '100',
      RESPAWN_SLEEP: '1',
    };
    const { child, exited } = spawnWatchdog(env);
    const ok = await pollUntil(() => {
      const files = fs.readdirSync(dir);
      return files.some((f) => /wrangler-tail-watchdog\.jsonl\.\d+/.test(f));
    }, 15000);
    await killAndAwait(child, exited);
    expect(ok).toBe(true);
    const files = fs.readdirSync(dir);
    const rotated = files.filter((f) => /wrangler-tail-watchdog\.jsonl\.\d+/.test(f));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  test('stops with ALERT when MAX_RESTARTS exceeded', async () => {
    const dir = makeTmp();
    const alertPath = path.join(dir, 'wrangler-tail-watchdog.alert');
    const env = {
      OUT_DIR: dir,
      // tail command exits immediately → forces respawn each iteration
      TAIL_CMD: String.raw`echo "{\"x\":1}"; exit 0`,
      STALE_SECS: '600',
      CHECK_INTERVAL: '600',
      MAX_BYTES: '10485760',
      MAX_RESTARTS: '3',
      RESPAWN_SLEEP: '0.1',
    };
    const { child, exited } = spawnWatchdog(env);
    // Watchdog self-exits via cleanup(); wait for that, then assert alert content.
    const ok = await pollUntil(() => fs.existsSync(alertPath), 20000);
    // killAndAwait는 child가 이미 종료됐어도 안전(SIGTERM은 no-op, exited는 즉시 resolve)
    await killAndAwait(child, exited);
    expect(ok).toBe(true);
    const alert = fs.readFileSync(alertPath, 'utf8');
    expect(alert).toMatch(/max-restarts/);
  });
});
