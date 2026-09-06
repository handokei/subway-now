/**
 * maestro-retry (#1252) — junit XML 파싱 + flow name 맵 + main() 통합 단위 테스트.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseFailedTestcaseNames,
  buildFlowNameMap,
  resolveFailedFlows,
  decodeXmlEntities,
  unquoteYaml,
  main,
} = require('../maestro-retry');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-retry-'));
}

function writeFlow(dir, file, name) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const body =
    name === null
      ? 'appId: com.example\n---\n- launchApp\n'
      : `appId: com.example\nname: ${name}\n---\n- launchApp\n`;
  fs.writeFileSync(full, body);
  return full;
}

const PASS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="2" failures="0">
    <testcase name="flow-one" classname="suite" time="1.0"/>
    <testcase name="flow-two" classname="suite" time="1.0"/>
  </testsuite>
</testsuites>
`;

const ONE_FAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="2" failures="1">
    <testcase name="flow-one" classname="suite" time="1.0"/>
    <testcase name="flow-two" classname="suite" time="0.5">
      <failure message="boom">stack</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

const MULTI_FAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="suite" tests="3" failures="2">
    <testcase name="flow-one" classname="suite" time="1.0">
      <failure message="x">y</failure>
    </testcase>
    <testcase name="flow-two" classname="suite" time="0.5">
      <error message="boom">stack</error>
    </testcase>
    <testcase name="flow-three" classname="suite" time="1.0"/>
  </testsuite>
</testsuites>
`;

describe('parseFailedTestcaseNames', () => {
  it('returns empty for all-pass junit', () => {
    expect(parseFailedTestcaseNames(PASS_XML)).toEqual([]);
  });

  it('extracts a single failed testcase name', () => {
    expect(parseFailedTestcaseNames(ONE_FAIL_XML)).toEqual(['flow-two']);
  });

  it('extracts both failure and error testcases', () => {
    expect(parseFailedTestcaseNames(MULTI_FAIL_XML)).toEqual(['flow-one', 'flow-two']);
  });

  it('decodes XML entities in name attribute', () => {
    const xml = `<testcase name="A &amp; B"><failure/></testcase>`;
    expect(parseFailedTestcaseNames(xml)).toEqual(['A & B']);
  });

  it('skips failed testcase that has no name attribute', () => {
    const xml = `<testcase classname="x"><failure/></testcase>`;
    expect(parseFailedTestcaseNames(xml)).toEqual([]);
  });

  // #1268 회귀: maestro junit이 `file=".maestro/flows/smoke/X.yaml"` 같이 슬래시가 포함된
  // 속성을 내보낼 때 attrs 클래스가 `[^>/]` 였던 시기엔 매칭이 깨져 retry가 동작하지 않았다.
  it('extracts failed testcase even when attributes contain slashes (issue 1268)', () => {
    const xml = `<testcase id="smoke - flow" name="smoke - flow" classname="suite" file=".maestro/flows/smoke/06.yaml" time="65.0" status="ERROR">
      <failure>Assertion is false: id: search-input is visible</failure>
    </testcase>`;
    expect(parseFailedTestcaseNames(xml)).toEqual(['smoke - flow']);
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the five standard XML entities', () => {
    expect(decodeXmlEntities('&lt;&gt;&quot;&apos;&amp;')).toBe(`<>"'&`);
  });
});

describe('unquoteYaml', () => {
  it('strips matched double quotes', () => {
    expect(unquoteYaml('  "hello"  ')).toBe('hello');
  });
  it('strips matched single quotes', () => {
    expect(unquoteYaml("'hello'")).toBe('hello');
  });
  it('leaves unquoted values intact', () => {
    expect(unquoteYaml('hello world')).toBe('hello world');
  });
});

describe('buildFlowNameMap', () => {
  it('maps yaml `name:` field and file stem to the file path', () => {
    const dir = makeTmpDir();
    const p1 = writeFlow(dir, '01_launch.yaml', '"smoke - launch"');
    const p2 = writeFlow(dir, 'sub/02_nav.yaml', 'navigation flow');
    const map = buildFlowNameMap(dir);
    expect(map.get('smoke - launch')).toBe(p1);
    expect(map.get('01_launch')).toBe(p1);
    expect(map.get('navigation flow')).toBe(p2);
    expect(map.get('02_nav')).toBe(p2);
  });

  it('falls back to file stem when yaml has no name field', () => {
    const dir = makeTmpDir();
    const p = writeFlow(dir, '03_nameless.yaml', null);
    const map = buildFlowNameMap(dir);
    expect(map.get('03_nameless')).toBe(p);
  });

  it('does not overwrite stem entry when name field already mapped to same key', () => {
    const dir = makeTmpDir();
    // file stem matches name field — should still resolve
    const p = writeFlow(dir, 'shared.yaml', 'shared');
    const map = buildFlowNameMap(dir);
    expect(map.get('shared')).toBe(p);
  });

  it('ignores non-yaml files', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'readme.md'), 'not a flow');
    const p = writeFlow(dir, 'flow.yml', 'flow');
    const map = buildFlowNameMap(dir);
    expect(map.get('flow')).toBe(p);
    expect([...map.values()]).not.toContain(path.join(dir, 'readme.md'));
  });
});

describe('resolveFailedFlows', () => {
  it('deduplicates flow paths when multiple names map to the same file', () => {
    const map = new Map([
      ['flow A', '/x/a.yaml'],
      ['a', '/x/a.yaml'],
    ]);
    const { paths, unresolved } = resolveFailedFlows(['flow A', 'a'], map);
    expect(paths).toEqual(['/x/a.yaml']);
    expect(unresolved).toEqual([]);
  });

  it('collects unresolved names', () => {
    const map = new Map([['known', '/x/k.yaml']]);
    const { paths, unresolved } = resolveFailedFlows(['known', 'ghost'], map);
    expect(paths).toEqual(['/x/k.yaml']);
    expect(unresolved).toEqual(['ghost']);
  });
});

function runMain(args) {
  const stdout = { buf: '', write: (s) => (stdout.buf += s) };
  const stderr = { buf: '', write: (s) => (stderr.buf += s) };
  const code = main(['node', 'maestro-retry.js', ...args], { stdout, stderr });
  return { code, stdout: stdout.buf, stderr: stderr.buf };
}

describe('main CLI', () => {
  it('exits 1 with usage when args are missing', () => {
    const { code, stderr } = runMain([]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Usage:/);
  });

  it('falls back to process.stdout/stderr when io is omitted', () => {
    const writeSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = main(['node', 'maestro-retry.js']);
      expect(code).toBe(1);
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('exits 1 when junit XML does not exist', () => {
    const dir = makeTmpDir();
    const { code, stderr } = runMain(['/nope/missing.xml', dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/junit XML not found/);
  });

  it('exits 1 when flows dir does not exist', () => {
    const dir = makeTmpDir();
    const xml = path.join(dir, 'r.xml');
    fs.writeFileSync(xml, PASS_XML);
    const { code, stderr } = runMain([xml, '/nope/flows']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/flows directory not found/);
  });

  it('exits 0 with empty stdout when no failures', () => {
    const dir = makeTmpDir();
    writeFlow(dir, '01.yaml', 'flow-one');
    const xml = path.join(dir, 'r.xml');
    fs.writeFileSync(xml, PASS_XML);
    const { code, stdout, stderr } = runMain([xml, dir]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('prints failed flow yaml paths, one per line', () => {
    const dir = makeTmpDir();
    writeFlow(dir, '01.yaml', 'flow-one');
    const failedPath = writeFlow(dir, '02.yaml', 'flow-two');
    const xml = path.join(dir, 'r.xml');
    fs.writeFileSync(xml, ONE_FAIL_XML);
    const { code, stdout } = runMain([xml, dir]);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toEqual([failedPath]);
  });

  it('returns 1 when a failed testcase name has no matching flow', () => {
    const dir = makeTmpDir();
    writeFlow(dir, '01.yaml', 'flow-one');
    // No file for "flow-two" → unresolved
    const xml = path.join(dir, 'r.xml');
    fs.writeFileSync(xml, ONE_FAIL_XML);
    const { code, stderr } = runMain([xml, dir]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unresolved/);
    expect(stderr).toMatch(/flow-two/);
  });
});
