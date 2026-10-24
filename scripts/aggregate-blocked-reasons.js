#!/usr/bin/env node
/**
 * boarding-prompt 9단 게이트 blocked reason 분포 집계 — #854.
 *
 * 입력: capture-blocked-reasons.sh가 만든 jsonl (wrangler tail JSON line / 라인 당 1 이벤트).
 *       각 라인은 보통 `{ "logs": [{ "message": ["<json-string>", ...] }], ... }` 형태이며,
 *       message[0]에 `console.log(JSON.stringify({ msg, ...meta }))` 결과가 박혀 있다.
 *
 * SSOT 정합:
 *   backend/alarm-worker/src/boardingPrompt.ts의 `GateSkipReason` union literals를
 *   정규식으로 직접 추출해 reasons label 집합을 구성한다. 새 reason 추가/제거 시 본
 *   스크립트 수정 없이 자동 반영 (CLAUDE.md 글로벌 룰 3 — 하드코딩 금지).
 *
 * 임계값 stamp:
 *   ORIGIN_RADIUS_KM / DIRECTION_COSINE_THRESHOLD / MIN_WINDOW_SAMPLES /
 *   MIN_FUSED_SPEED_KMH / DISMISS_SILENCE_MS 도 같은 파일에서 정규식으로 읽어
 *   결과 summary에 함께 출력 — 측정 시점의 설정을 영속화.
 *
 * 출력:
 *   - 표 형태(markdown): reason / count / share / 임계값 stamp
 *   - 입력 파일 옆에 .summary.md 저장
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BOARDING_PROMPT_PATH = path.join(
  REPO_ROOT,
  'backend/alarm-worker/src/boardingPrompt.ts',
);
const THRESHOLD_NAMES = [
  'ORIGIN_RADIUS_KM',
  'DIRECTION_COSINE_THRESHOLD',
  'MIN_WINDOW_SAMPLES',
  'MIN_FUSED_SPEED_KMH',
  'DISMISS_SILENCE_MS',
];

function readArgs() {
  const [input] = process.argv.slice(2);
  if (!input) {
    console.error('사용: node scripts/aggregate-blocked-reasons.js <input.jsonl>');
    process.exit(2);
  }
  return { input };
}

/**
 * backend의 GateSkipReason union에서 string literal들을 추출.
 *   export type GateSkipReason =
 *     | 'no-series'
 *     | 'window-too-small'
 *     | ...;
 */
function extractKnownReasons(source) {
  const unionMatch = source.match(/export type GateSkipReason\s*=([\s\S]*?);/);
  if (!unionMatch) {
    throw new Error(
      'GateSkipReason union을 ' +
        BOARDING_PROMPT_PATH +
        '에서 찾지 못했습니다. backend 변경 확인 필요.',
    );
  }
  const literals = Array.from(unionMatch[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error('GateSkipReason union literals 추출 실패.');
  }
  return literals;
}

/**
 * 임계값 stamp — 정규식으로 export const 한 줄을 그대로 추출.
 * 형태: `export const NAME = <expr>;` 같은 한 줄을 가정한다.
 *       multi-line 값은 ($) 앵커로 차단해 부정확한 합성 결과를 막는다.
 */
function extractThresholdStamps(source) {
  return THRESHOLD_NAMES.reduce((acc, name) => {
    const re = new RegExp(
      '^export const ' + name + '\\s*=\\s*([^;\\n]+);',
      'm',
    );
    const m = source.match(re);
    acc[name] = m ? m[1].trim() : '(미발견)';
    return acc;
  }, {});
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * wrangler tail의 envelope에서 console.log 메시지를 끄집어 후보 문자열 배열로 반환.
 * 두 형태 모두 허용: (a) 라인이 곧바로 JSON object (b) wrangler 래퍼 (logs[].message[]).
 */
function collectCandidateMessages(parsed) {
  if (typeof parsed === 'string') return [parsed];
  if (!parsed || typeof parsed !== 'object') return [];
  if (!Array.isArray(parsed.logs)) return [JSON.stringify(parsed)];
  const out = [];
  for (const entry of parsed.logs) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Array.isArray(entry.message)) continue;
    for (const part of entry.message) {
      if (typeof part === 'string') out.push(part);
    }
  }
  return out;
}

/**
 * 한 줄에서 boarding-prompt blocked 이벤트를 1건 추출 (없으면 null).
 * knownReasons에 없으면 `__unknown:<reason>`으로 표기해 추후 SSOT 드리프트 감지.
 */
function parseLine(line, knownReasons) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parsed = tryParseJson(trimmed);
  if (!parsed) return null;

  const candidates = collectCandidateMessages(parsed);
  for (const candidate of candidates) {
    const decoded = tryParseJson(candidate);
    if (!decoded || typeof decoded !== 'object') continue;
    if (decoded.msg !== 'boarding-prompt: gate blocked') continue;
    const reason = decoded.reason;
    if (typeof reason !== 'string') continue;
    return {
      reason: knownReasons.has(reason) ? reason : '__unknown:' + reason,
      token: typeof decoded.token === 'string' ? decoded.token : null,
      ts: typeof decoded.ts === 'number' ? decoded.ts : null,
    };
  }
  return null;
}

function aggregate(input, knownReasons) {
  const reasonSet = new Set(knownReasons);
  const perReason = new Map(knownReasons.map((r) => [r, 0]));
  const perToken = new Map();

  const lines = fs.readFileSync(input, 'utf8').split('\n');
  let blockedEvents = 0;
  let unknownReasons = 0;

  for (const line of lines) {
    const evt = parseLine(line, reasonSet);
    if (!evt) continue;
    blockedEvents += 1;
    perReason.set(evt.reason, (perReason.get(evt.reason) || 0) + 1);
    if (evt.reason.startsWith('__unknown:')) unknownReasons += 1;
    if (evt.token) perToken.set(evt.token, (perToken.get(evt.token) || 0) + 1);
  }

  return {
    totalLines: lines.length,
    blockedEvents,
    unknownReasons,
    perReason,
    perToken,
  };
}

function renderMarkdown(input, result, thresholds) {
  const { blockedEvents, perReason, perToken, totalLines, unknownReasons } = result;
  const denominator = blockedEvents || 1;

  const reasonRows = Array.from(perReason.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      const share = ((count / denominator) * 100).toFixed(1);
      return '| `' + reason + '` | ' + count + ' | ' + share + '% |';
    });

  const tokenEntries = Array.from(perToken.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const tokenBlock =
    tokenEntries.length === 0
      ? '_token 정보 없음 (백엔드 log meta 누락 또는 token 필드 비포함)_'
      : [
          '| token | count |',
          '| --- | ---: |',
          ...tokenEntries.map(([t, c]) => '| `' + t + '` | ' + c + ' |'),
        ].join('\n');

  const thresholdRows = Object.entries(thresholds).map(
    ([name, value]) => '| `' + name + '` | ' + value + ' |',
  );

  return [
    '# boarding-prompt blocked reason 분포',
    '',
    '- 입력 파일: `' + path.relative(REPO_ROOT, input) + '`',
    '- 캡처 라인 수: ' + totalLines,
    '- blocked 이벤트: ' + blockedEvents,
    '- 미식별 reason: ' + unknownReasons,
    '',
    '## reason 분포 (count desc)',
    '',
    '| reason | count | share |',
    '| --- | ---: | ---: |',
    ...reasonRows,
    '',
    '## token 상위 10',
    '',
    tokenBlock,
    '',
    '## 임계값 stamp (boardingPrompt.ts 자동 추출)',
    '',
    '| name | value |',
    '| --- | --- |',
    ...thresholdRows,
    '',
    '_자동 생성 — scripts/aggregate-blocked-reasons.js (#854)._',
    '',
  ].join('\n');
}

function main() {
  const { input } = readArgs();
  if (!fs.existsSync(input)) {
    console.error('입력 파일 없음: ' + input);
    process.exit(1);
  }
  const source = fs.readFileSync(BOARDING_PROMPT_PATH, 'utf8');
  const knownReasons = extractKnownReasons(source);
  const thresholds = extractThresholdStamps(source);

  const result = aggregate(input, knownReasons);
  const markdown = renderMarkdown(input, result, thresholds);

  const summaryPath = input.replace(/\.jsonl?$/, '') + '.summary.md';
  fs.writeFileSync(summaryPath, markdown, 'utf8');

  process.stdout.write(markdown);
  console.error('\n[aggregate] summary → ' + summaryPath);
}

main();
