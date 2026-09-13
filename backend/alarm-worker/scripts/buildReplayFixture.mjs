#!/usr/bin/env node
/**
 * Seoul capture cycle JSON들(로컬 디렉토리) → 재생 fixture 번들 CLI (#2580, Epic #2239 P0-b).
 *
 * R2 다운로드는 이 스크립트 책임이 아니다 — 사용자/메인이 `wrangler r2 object get`으로
 * 미리 받아둔 로컬 디렉토리를 입력으로 받는다(단순성 우선, 자동화는 P1).
 * 병합/정렬/window trim/검증 로직은 전부 `../src/replayFixture.ts`에 있다 — 이 파일은
 * 얇은 파일 I/O + CLI 인자 파싱 셸이다.
 *
 * Usage:
 *   node scripts/buildReplayFixture.mjs --in <captureDir> --out <fixture.json> [--from <ISO|ms>] [--to <ISO|ms>]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReplayFixture } from '../src/replayFixture.ts';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

/** ISO 문자열 또는 epoch ms 문자열 → epoch ms. */
function parseTimeArg(value) {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`시간 인자를 파싱할 수 없습니다: ${value}`);
  }
  return parsed;
}

/** cycle 파일 하나를 읽어 SeoulCaptureCycle로 최소 검증. 실패 시 이유와 함께 null. */
function readCycleFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { error: `JSON 파싱 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'object가 아님' };
  if (parsed.schemaVersion !== 1) return { error: `schemaVersion !== 1 (got ${parsed.schemaVersion})` };
  if (typeof parsed.cycleStartMs !== 'number') return { error: 'cycleStartMs가 number가 아님' };
  if (!Array.isArray(parsed.entries)) return { error: 'entries가 배열이 아님' };
  return { cycle: parsed };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error('Usage: node scripts/buildReplayFixture.mjs --in <captureDir> --out <fixture.json> [--from <ISO|ms>] [--to <ISO|ms>]');
    process.exit(1);
  }

  const inDir = args.in;
  const files = readdirSync(inDir).filter((name) => name.endsWith('.json'));

  const cycles = [];
  let skipped = 0;
  for (const file of files) {
    const filePath = path.join(inDir, file);
    const result = readCycleFile(filePath);
    if ('error' in result) {
      console.warn(`[skip] ${file}: ${result.error}`);
      skipped += 1;
      continue;
    }
    cycles.push(result.cycle);
  }

  const fromMs = parseTimeArg(args.from);
  const toMs = parseTimeArg(args.to);
  const window = fromMs !== undefined && toMs !== undefined ? { fromMs, toMs } : undefined;

  const fixture = buildReplayFixture(cycles, window);
  const json = JSON.stringify(fixture, null, 2);
  writeFileSync(args.out, json);

  console.log(
    [
      `cycles: ${cycles.length} (skipped: ${skipped})`,
      `entries: ${fixture.entries.length}`,
      `window: ${new Date(fixture.window.fromMs).toISOString()} ~ ${new Date(fixture.window.toMs).toISOString()}`,
      `bytes: ${Buffer.byteLength(json, 'utf-8')}`,
      `out: ${args.out}`,
    ].join('\n'),
  );
}

main();
