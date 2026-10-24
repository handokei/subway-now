/**
 * #923 permission-matrix-runner 단위 테스트.
 * 외부 영향(maestro 실행, FS)을 격리하기 위해 dep injection으로 spawnSync/stdout을 mock한다.
 */
const path = require('node:path');
const {
  parseArgs,
  selectCells,
  buildMaestroCommand,
  main,
} = require('../permission-matrix-runner');

function createStream() {
  return {
    chunks: [],
    write(s) {
      this.chunks.push(s);
    },
    get text() {
      return this.chunks.join('');
    },
  };
}

const MATRIX_PATH = path.join(__dirname, '..', 'permission-matrix.json');

describe('parseArgs', () => {
  it.each([
    [[], { cell: null, baselineOnly: false, list: false, dryRun: false }],
    [['--cell', 'foo'], { cell: 'foo', baselineOnly: false, list: false, dryRun: false }],
    [['--baseline'], { cell: null, baselineOnly: true, list: false, dryRun: false }],
    [['--list'], { cell: null, baselineOnly: false, list: true, dryRun: false }],
    [['--dry-run'], { cell: null, baselineOnly: false, list: false, dryRun: true }],
  ])('parses %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it('flags help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('records unknown argument as error', () => {
    expect(parseArgs(['--bogus']).error).toMatch(/Unknown/);
  });
});

describe('selectCells', () => {
  const matrix = {
    cells: [
      { id: 'a', baseline: true, flow: 'a.yaml' },
      { id: 'b', flow: 'b.yaml' },
      { id: 'c', baseline: false, flow: 'c.yaml' },
    ],
  };

  it('returns all when no filter', () => {
    expect(selectCells(matrix, parseArgs([])).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters by cell id', () => {
    expect(selectCells(matrix, parseArgs(['--cell', 'b'])).map((c) => c.id)).toEqual(['b']);
  });

  it('throws when cell id not found', () => {
    expect(() => selectCells(matrix, parseArgs(['--cell', 'zzz']))).toThrow(/not found/);
  });

  it('filters by baseline', () => {
    expect(selectCells(matrix, parseArgs(['--baseline'])).map((c) => c.id)).toEqual(['a']);
  });
});

describe('buildMaestroCommand', () => {
  it('produces flow path and junit/debug outputs anchored on cell id', () => {
    const cmd = buildMaestroCommand(
      { id: 'x', flow: 'x.yaml' },
      { flowsDir: '/flows', outputDir: '/out', maestroBin: 'maestro' },
    );
    expect(cmd.bin).toBe('maestro');
    expect(cmd.args).toEqual([
      'test',
      '/flows/x.yaml',
      '--format',
      'junit',
      '--output',
      '/out/permission-matrix-x.xml',
      '--debug-output',
      '/out/permission-matrix-debug-x',
    ]);
  });
});

describe('main', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 0 and prints help on --help', () => {
    const stdout = createStream();
    const stderr = createStream();
    const code = main(['--help'], { exec: jest.fn(), stdout, stderr });
    expect(code).toBe(0);
    expect(stdout.text).toMatch(/permission-matrix-runner/);
  });

  it('returns 2 on unknown argument', () => {
    const stderr = createStream();
    const code = main(['--bogus'], { exec: jest.fn(), stdout: createStream(), stderr });
    expect(code).toBe(2);
    expect(stderr.text).toMatch(/Unknown/);
  });

  it('returns 2 when matrix file missing', () => {
    process.env.MATRIX_JSON = '/nonexistent/matrix.json';
    const stderr = createStream();
    const code = main([], { exec: jest.fn(), stdout: createStream(), stderr });
    expect(code).toBe(2);
    expect(stderr.text).toMatch(/not found/);
  });

  it('lists cells without executing maestro', () => {
    process.env.MATRIX_JSON = MATRIX_PATH;
    const stdout = createStream();
    const exec = jest.fn();
    const code = main(['--list'], { exec, stdout, stderr: createStream() });
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(stdout.text).toContain('whileInUse-fg-aboveground-normal-ios18');
    expect(stdout.text).toContain('baseline=true');
  });

  it('dry-run prints commands without invoking exec', () => {
    process.env.MATRIX_JSON = MATRIX_PATH;
    const stdout = createStream();
    const exec = jest.fn();
    const code = main(['--baseline', '--dry-run'], { exec, stdout, stderr: createStream() });
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(stdout.text).toContain('maestro test');
    expect(stdout.text).toContain('1 cell(s) passed');
  });

  it('returns 0 when exec succeeds for all cells', () => {
    process.env.MATRIX_JSON = MATRIX_PATH;
    const stdout = createStream();
    const exec = jest.fn().mockReturnValue({ status: 0 });
    const code = main(['--baseline'], { exec, stdout, stderr: createStream() });
    expect(code).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stdout.text).toContain('passed');
  });

  it('returns 1 when any cell fails', () => {
    process.env.MATRIX_JSON = MATRIX_PATH;
    const stderr = createStream();
    const exec = jest.fn().mockReturnValue({ status: 1 });
    const code = main(['--baseline'], { exec, stdout: createStream(), stderr });
    expect(code).toBe(1);
    expect(stderr.text).toContain('FAIL');
  });
});
