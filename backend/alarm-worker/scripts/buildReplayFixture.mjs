#!/usr/bin/env node
/**
 * Seoul capture cycle JSON들(로컬 디렉토리) → 재생 fixture 번들 CLI (#2580, Epic #2239 P0-b).
 *
 * R2 다운로드는 이 스크립트 책임이 아니다 — 사용자/메인이 `wrangler r2 object get`으로
 * 미리 받아둔 로컬 디렉토리를 입력으로 받는다(단순성 우선, 자동화는 P1). 절차는
 * `backend/alarm-worker/README.md`의 "Seoul capture → replay fixture" 참고.
 * 병합/정렬/window trim/검증 로직은 전부 `../src/replayFixture.ts`에 있다 — 이 파일은
 * 얇은 파일 I/O + CLI 인자 파싱 셸이다(검증 로직을 갖지 않는다, #2580 리뷰).
 *
 * `../src/replayFixture.ts`를 직접 import한다 — Node의 타입 스트리핑(TypeScript 타입
 * 구문 erasure) 기능이 필요하다. `package.json`의 `engines.node` 참고.
 *
 * Usage:
 *   node scripts/buildReplayFixture.mjs --in <captureDir> --out <fixture.json> [--from <ISO|ms>] [--to <ISO|ms>]
 *   --from/--to는 한쪽만 줘도 된다 — 그 방향만 제약하고 반대쪽은 실제 데이터 범위로 자동 산출한다.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReplayFixture, parseSeoulCaptureCycle } from '../src/replayFixture.ts';
import { parseArgs, readCycleFile } from './cliUtils.mjs';

/** ISO 문자열 또는 epoch ms 문자열 → epoch ms. */
function parseTimeArg(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`시간 인자를 파싱할 수 없습니다: ${value}`);
  }
  return parsed;
}

function formatBoundLabel(ms) {
  return ms === undefined ? '(open)' : new Date(ms).toISOString();
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
    const result = readCycleFile(filePath, parseSeoulCaptureCycle);
    if ('error' in result) {
      console.warn(`[skip] ${file}: ${result.error}`);
      skipped += 1;
      continue;
    }
    cycles.push(result.cycle);
  }

  const hasFrom = args.from !== undefined;
  const hasTo = args.to !== undefined;
  const fromMs = hasFrom ? parseTimeArg(args.from) : undefined;
  const toMs = hasTo ? parseTimeArg(args.to) : undefined;
  const window = hasFrom || hasTo ? { fromMs, toMs } : undefined;

  const fixture = buildReplayFixture(cycles, window);
  const json = JSON.stringify(fixture, null, 2);
  writeFileSync(args.out, json);

  const { fromMs: appliedFromMs, toMs: appliedToMs } = fixture.window;
  const { droppedEntries, failedCycleStartsMs } = fixture;

  console.log(
    [
      `cycles: ${cycles.length} (skipped: ${skipped})`,
      `entries: ${fixture.entries.length}`,
      `window constraint: from=${formatBoundLabel(fromMs)} to=${formatBoundLabel(toMs)}`,
      `window (fixture): ${new Date(appliedFromMs).toISOString()} ~ ${new Date(appliedToMs).toISOString()}`,
      ...(droppedEntries ? [`droppedEntries: ${droppedEntries}`] : []),
      ...(failedCycleStartsMs?.length ? [`failedCycleStartsMs: ${failedCycleStartsMs.length}`] : []),
      `bytes: ${Buffer.byteLength(json, 'utf-8')}`,
      `out: ${args.out}`,
    ].join('\n'),
  );
}

main();
