#!/usr/bin/env node
/**
 * Maestro CI retry helper (#1252).
 *
 * Maestro의 junit XML(`maestro test --format junit --output X.xml`)을 파싱해
 * 실패한 flow에 해당하는 YAML 파일 경로만 stdout으로 출력한다.
 * CI는 이 출력을 받아 실패한 flow만 2차 실행해 시뮬레이터 환경 flake를 흡수한다.
 *
 * Maestro junit XML 구조:
 *   <testsuites>
 *     <testsuite>
 *       <testcase name="<flow YAML의 name 필드>" classname="..." time="..">
 *         <failure>...</failure>  (실패 시)
 *       </testcase>
 *     </testsuite>
 *   </testsuites>
 *
 * testcase는 flow yaml 파일 경로를 직접 담지 않으므로, 같은 flows 디렉토리를
 * 스캔해 yaml `name:` 필드 → 파일 경로 매핑을 구성한다.
 *
 * Usage:
 *   node scripts/maestro-retry.js <junit.xml> <flows-dir>
 *
 * Exit codes:
 *   0  - 성공 (실패한 flow 없거나, 매핑 모두 해석됨)
 *   1  - 인자 부족 / 입력 파일 누락 / 매핑되지 않은 실패 testcase 존재
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * junit XML에서 실패한 testcase의 name 속성 배열을 추출한다.
 * 정규식 기반(런너에 xml 의존성 추가 없이 동작).
 */
function parseFailedTestcaseNames(xml) {
  const names = [];
  // <testcase ...>...</testcase> 블록 단위로 순회
  // attrs는 `[^>]` 가 아니라 `[^>/]` — 그렇지 않으면 self-closing `/>` 의 `/` 까지
  // 탐욕적으로 소비해 `\/>` 분기가 실패하고 다음 `</testcase>` 까지 long-match된다.
  // (alternation은 backtrack 없이 첫 성공 분기를 채택하므로 attrs 클래스 자체를 좁힌다.)
  const blockRe = /<testcase\b([^>/]*)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    const attrs = match[1];
    const inner = match[3] || '';
    const isFailure = /<failure\b/.test(inner) || /<error\b/.test(inner);
    if (!isFailure) {
      continue;
    }
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    if (nameMatch) {
      names.push(decodeXmlEntities(nameMatch[1]));
    }
  }
  return names;
}

function decodeXmlEntities(s) {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const YAML_EXT_RE = /\.ya?ml$/i;
// 선형 시간 보장: `.+?` + `\s*$` 같은 backtracking-prone 조합 대신 라인 단위로 자른 뒤 trim.
const YAML_NAME_FIELD_RE = /^[ \t]*name[ \t]*:[ \t]*([^\n\r]*)/m;

/**
 * 단일 YAML 파일을 맵에 등록한다.
 *  - yaml `name:` 필드가 있으면 그 값을 키로 등록 (강한 매핑)
 *  - 파일 stem도 fallback 키로 등록 (yaml name 누락 대비)
 */
function registerYamlFlow(map, fullPath, baseName) {
  const text = fs.readFileSync(fullPath, 'utf8');
  const nameMatch = YAML_NAME_FIELD_RE.exec(text);
  if (nameMatch) {
    map.set(unquoteYaml(nameMatch[1]), fullPath);
  }
  const stem = baseName.replace(YAML_EXT_RE, '');
  if (!map.has(stem)) {
    map.set(stem, fullPath);
  }
}

/**
 * flows 디렉토리(재귀)를 스캔해 yaml `name:` 필드 → 파일 경로 맵 생성.
 * name 필드가 없으면 파일 stem을 fallback 키로도 추가.
 */
function buildFlowNameMap(flowsDir) {
  const map = new Map();
  const stack = [flowsDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && YAML_EXT_RE.test(ent.name)) {
        registerYamlFlow(map, full, ent.name);
      }
    }
  }
  return map;
}

function unquoteYaml(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 실패한 testcase 이름 → flow 파일 경로 변환.
 * @returns {{ paths: string[], unresolved: string[] }}
 */
function resolveFailedFlows(failedNames, nameToPath) {
  const paths = [];
  const unresolved = [];
  for (const name of failedNames) {
    const p = nameToPath.get(name);
    if (p) {
      if (!paths.includes(p)) {
        paths.push(p);
      }
    } else {
      unresolved.push(name);
    }
  }
  return { paths, unresolved };
}

function main(argv, io) {
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  const junitXmlPath = argv[2];
  const flowsDir = argv[3];
  if (!junitXmlPath || !flowsDir) {
    stderr.write('Usage: node scripts/maestro-retry.js <junit.xml> <flows-dir>\n');
    return 1;
  }
  if (!fs.existsSync(junitXmlPath)) {
    stderr.write(`junit XML not found: ${junitXmlPath}\n`);
    return 1;
  }
  if (!fs.existsSync(flowsDir)) {
    stderr.write(`flows directory not found: ${flowsDir}\n`);
    return 1;
  }
  const xml = fs.readFileSync(junitXmlPath, 'utf8');
  const failedNames = parseFailedTestcaseNames(xml);
  if (failedNames.length === 0) {
    return 0;
  }
  const nameToPath = buildFlowNameMap(flowsDir);
  const { paths, unresolved } = resolveFailedFlows(failedNames, nameToPath);
  for (const p of paths) {
    stdout.write(`${p}\n`);
  }
  if (unresolved.length > 0) {
    stderr.write(
      `Unresolved failed testcase names (not found in ${flowsDir}):\n` +
        unresolved.map((n) => `  - ${n}`).join('\n') +
        '\n',
    );
    return 1;
  }
  return 0;
}

module.exports = {
  parseFailedTestcaseNames,
  buildFlowNameMap,
  resolveFailedFlows,
  decodeXmlEntities,
  unquoteYaml,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv));
}
