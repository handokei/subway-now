#!/usr/bin/env node
/**
 * 권한 매트릭스 회귀 테스트 dispatcher (#923 E2).
 *
 * scripts/permission-matrix.json을 읽어 cell 단위로 Maestro flow를 실행한다.
 * 데이터 주도: 새 셀 추가는 JSON entry 1개로 끝난다. 본 파일은 수정하지 않는다.
 *
 * 사용:
 *   node scripts/permission-matrix-runner.js                  # 모든 cell 순차 실행
 *   node scripts/permission-matrix-runner.js --cell <id>      # 특정 cell만
 *   node scripts/permission-matrix-runner.js --baseline       # baseline=true인 cell만
 *   node scripts/permission-matrix-runner.js --list           # cell 목록만 출력 후 종료
 *   node scripts/permission-matrix-runner.js --dry-run        # 실행 없이 명령만 출력
 *
 * 환경 변수:
 *   MAESTRO_BIN     : maestro 실행 경로 (기본 "maestro")
 *   FLOWS_DIR       : flow 디렉토리 (기본 ".maestro/flows/permissions")
 *   MATRIX_JSON     : 매트릭스 JSON 경로 (기본 "scripts/permission-matrix.json")
 *   OUTPUT_DIR      : junit/디버그 출력 디렉토리 (기본 ".")
 *
 * 종료 코드:
 *   0 — 선택된 모든 cell 통과
 *   1 — 하나 이상 cell 실패
 *   2 — 사용법/입력 오류
 */
const { readFileSync, existsSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = join(__dirname, '..');

function resolveFromRoot(p) {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}

function parseArgs(argv) {
  const args = { cell: null, baselineOnly: false, list: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cell') {
      args.cell = argv[i + 1];
      i += 1;
    } else if (token === '--baseline') {
      args.baselineOnly = true;
    } else if (token === '--list') {
      args.list = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      args.error = `Unknown argument: ${token}`;
    }
  }
  return args;
}

function loadMatrix(path) {
  if (!existsSync(path)) {
    throw new Error(`Matrix file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.cells) || parsed.cells.length === 0) {
    throw new Error('Matrix must contain non-empty cells array');
  }
  return parsed;
}

function selectCells(matrix, args) {
  const all = matrix.cells;
  if (args.cell) {
    const found = all.filter((c) => c.id === args.cell);
    if (found.length === 0) {
      throw new Error(`Cell not found: ${args.cell}`);
    }
    return found;
  }
  if (args.baselineOnly) {
    return all.filter((c) => c.baseline === true);
  }
  return all;
}

function buildMaestroCommand(cell, options) {
  const flowPath = join(options.flowsDir, cell.flow);
  const junit = join(options.outputDir, `permission-matrix-${cell.id}.xml`);
  const debug = join(options.outputDir, `permission-matrix-debug-${cell.id}`);
  return {
    bin: options.maestroBin,
    args: ['test', flowPath, '--format', 'junit', '--output', junit, '--debug-output', debug],
  };
}

function printHelp(stdout) {
  // help 메시지는 파일 상단 주석에서 단일 출처로 유지.
  // 호출자가 grep할 수 있도록 핵심 사용법만 stderr가 아닌 stdout으로 출력.
  stdout.write(
    [
      'permission-matrix-runner — #923 권한 매트릭스 dispatcher',
      'usage: node scripts/permission-matrix-runner.js [--cell <id>|--baseline|--list|--dry-run]',
      '자세한 옵션은 파일 상단 주석 참고.',
      '',
    ].join('\n'),
  );
}

function main(argv, deps = {}) {
  const exec = deps.exec || spawnSync;
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  const args = parseArgs(argv);
  if (args.help) {
    printHelp(stdout);
    return 0;
  }
  if (args.error) {
    stderr.write(`${args.error}\n`);
    return 2;
  }

  const matrixPath = resolveFromRoot(process.env.MATRIX_JSON || 'scripts/permission-matrix.json');
  const flowsDir = resolveFromRoot(process.env.FLOWS_DIR || '.maestro/flows/permissions');
  const outputDir = resolveFromRoot(process.env.OUTPUT_DIR || '.');
  const maestroBin = process.env.MAESTRO_BIN || 'maestro';

  let matrix;
  try {
    matrix = loadMatrix(matrixPath);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  let cells;
  try {
    cells = selectCells(matrix, args);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  if (args.list) {
    for (const cell of cells) {
      stdout.write(`${cell.id}\t${cell.flow}\tbaseline=${Boolean(cell.baseline)}\n`);
    }
    return 0;
  }

  const options = { flowsDir, outputDir, maestroBin };
  let failed = 0;
  for (const cell of cells) {
    const command = buildMaestroCommand(cell, options);
    const display = `${command.bin} ${command.args.join(' ')}`;
    stdout.write(`[matrix] cell=${cell.id} → ${display}\n`);
    if (args.dryRun) {
      continue;
    }
    const result = exec(command.bin, command.args, { stdio: 'inherit', cwd: REPO_ROOT });
    if (result.status !== 0) {
      stderr.write(`[matrix] FAIL cell=${cell.id} status=${result.status}\n`);
      failed += 1;
    }
  }

  if (failed > 0) {
    stderr.write(`[matrix] ${failed}/${cells.length} cell(s) failed\n`);
    return 1;
  }
  stdout.write(`[matrix] ${cells.length} cell(s) passed\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  parseArgs,
  loadMatrix,
  selectCells,
  buildMaestroCommand,
  main,
};
