#!/usr/bin/env node
/**
 * i18n key audit
 *
 * - Flattens all locale JSON files under src/shared/i18n/locales/
 * - Reports keys that exist in some locales but not others (regression risk:
 *   raw key string is shown to user when their locale is the missing one)
 * - Scans source files for t('...') / i18n.t('...') usage and reports:
 *   - used keys missing from any locale (regression)
 *   - dead keys defined in all locales but never used (cleanup candidates)
 *
 * Exit codes:
 *   0 - no missing-across-locales keys and no used-but-missing keys
 *   1 - regressions detected
 *
 * Dead keys do not fail the script (cleanup is a separate concern).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(REPO_ROOT, 'src/shared/i18n/locales');
const LOCALES = ['ko', 'en', 'ja', 'zh'];

const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'app'),
  path.join(REPO_ROOT, 'modules'),
];
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIR = new Set(['__tests__', '__mocks__', 'node_modules', '.expo']);

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v, next, out);
    } else {
      out[next] = v;
    }
  }
  return out;
}

function loadLocales() {
  const result = {};
  for (const locale of LOCALES) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    result[locale] = flatten(raw);
  }
  return result;
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      // skip test files
      if (/\.test\.[tj]sx?$/.test(entry.name)) continue;
      files.push(full);
    }
  }
  return files;
}

// Match t(...) / i18n.t(...) / i18next.t(...) calls and extract all quoted
// dotted keys within the first argument (which may be a ternary).
// We scan for the call prefix, then read forward up to the first balanced
// ')' or a comma at depth-0 — extracting any quoted dotted strings on the way.
const T_CALL_RE = /\b(?:i18n(?:ext)?\.)?t\(/g;
const QUOTED_KEY_INNER_RE = /(['"])([a-zA-Z]\w*(?:\.[\w-]+)+)\1/g;

// Also pick up table-driven keys: labelKey: 'settings.themeAuto', key: 'foo.bar'
const LABEL_KEY_RE = /\b(?:labelKey|titleKey|i18nKey|translationKey)\s*:\s*(['"])([a-zA-Z]\w*(?:\.[\w-]+)+)\1/g;

// Template-literal prefixes like `lines.${...}` — any key under that prefix is live.
const TEMPLATE_PREFIX_RE = /`([a-zA-Z]\w*(?:\.[\w-]+)*)\.\$\{/g;

function skipString(text, start, quote) {
  // Return index of the closing quote (or text.length if unterminated).
  let i = start;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i++;
    i++;
  }
  return i;
}

function extractTCallArg(text, start) {
  // start is the index right after '('. Read until matching ')' or depth-0 ','.
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i + 1, ch);
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(start, i);
    } else if (ch === ',' && depth === 1) {
      return text.slice(start, i);
    }
    i++;
  }
  return text.slice(start, i);
}

function recordKey(used, byKey, rel, key) {
  used.add(key);
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(rel);
}

function scanFile(text, rel, ctx) {
  const { used, dynamicPrefixes, byKey } = ctx;
  T_CALL_RE.lastIndex = 0;
  let m;
  while ((m = T_CALL_RE.exec(text)) !== null) {
    const arg = extractTCallArg(text, m.index + m[0].length);
    QUOTED_KEY_INNER_RE.lastIndex = 0;
    let km;
    while ((km = QUOTED_KEY_INNER_RE.exec(arg)) !== null) {
      recordKey(used, byKey, rel, km[2]);
    }
  }
  LABEL_KEY_RE.lastIndex = 0;
  while ((m = LABEL_KEY_RE.exec(text)) !== null) {
    recordKey(used, byKey, rel, m[2]);
  }
  TEMPLATE_PREFIX_RE.lastIndex = 0;
  while ((m = TEMPLATE_PREFIX_RE.exec(text)) !== null) {
    dynamicPrefixes.add(m[1]);
  }
}

function extractUsedKeys() {
  const ctx = { used: new Set(), dynamicPrefixes: new Set(), byKey: new Map() };
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file);
      scanFile(text, rel, ctx);
    }
  }
  return ctx;
}

function diff(locales) {
  const allKeys = new Set();
  for (const loc of LOCALES) {
    for (const k of Object.keys(locales[loc])) allKeys.add(k);
  }
  const missingByLocale = {};
  for (const loc of LOCALES) missingByLocale[loc] = [];
  for (const key of allKeys) {
    for (const loc of LOCALES) {
      if (!(key in locales[loc])) missingByLocale[loc].push(key);
    }
  }
  for (const loc of LOCALES) missingByLocale[loc].sort((a, b) => a.localeCompare(b));
  return { allKeys, missingByLocale };
}

// i18next v4 plural suffixes: t('foo') with { count } resolves to foo_one / foo_other / foo_zero / foo_two / foo_few / foo_many.
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

function hasKeyWithPlural(locale, key) {
  if (key in locale) return true;
  for (const suf of PLURAL_SUFFIXES) {
    if ((key + suf) in locale) return true;
  }
  return false;
}

function stripPluralSuffix(key) {
  for (const suf of PLURAL_SUFFIXES) {
    if (key.endsWith(suf)) return key.slice(0, -suf.length);
  }
  return key;
}

function isUnderDynamicPrefix(key, dynamicPrefixes) {
  for (const p of dynamicPrefixes) {
    if (key === p || key.startsWith(p + '.')) return true;
  }
  return false;
}

function isDynamicallyReferenced(key, used) {
  const base = stripPluralSuffix(key);
  for (const u of used) {
    if (u === key || u === base) return true;
    if (u.startsWith(key + '.') || key.startsWith(u + '.')) return true;
    if (u.startsWith(base + '.') || base.startsWith(u + '.')) return true;
  }
  return false;
}

function reportCrossLocaleMissing(missingByLocale) {
  console.log('--- Cross-locale missing keys ---');
  let regression = false;
  for (const loc of LOCALES) {
    const miss = missingByLocale[loc];
    if (miss.length === 0) {
      console.log(`  ${loc}: OK`);
      continue;
    }
    regression = true;
    console.log(`  ${loc}: missing ${miss.length}`);
    for (const k of miss) console.log(`    - ${k}`);
  }
  console.log();
  return regression;
}

function reportUsedMissing(locales, used) {
  console.log('--- Used keys missing from any locale ---');
  const usedMissing = [];
  for (const key of used) {
    const missingIn = LOCALES.filter((loc) => !hasKeyWithPlural(locales[loc], key));
    if (missingIn.length > 0) usedMissing.push({ key, missingIn });
  }
  if (usedMissing.length === 0) {
    console.log('  OK');
    console.log();
    return false;
  }
  for (const { key, missingIn } of usedMissing) {
    console.log(`  - ${key}  (missing: ${missingIn.join(', ')})`);
  }
  console.log();
  return true;
}

function findDeadKeys(allKeys, locales, used, dynamicPrefixes) {
  const dead = [];
  for (const key of allKeys) {
    const inAll = LOCALES.every((loc) => key in locales[loc]);
    if (!inAll) continue;
    if (used.has(key)) continue;
    if (isUnderDynamicPrefix(key, dynamicPrefixes)) continue;
    if (isDynamicallyReferenced(key, used)) continue;
    dead.push(key);
  }
  dead.sort((a, b) => a.localeCompare(b));
  return dead;
}

function reportDeadKeys(dead) {
  console.log('--- Dead keys (defined but never referenced statically) ---');
  if (dead.length === 0) {
    console.log('  OK');
    return;
  }
  console.log(`  ${dead.length} candidates (cleanup is a separate concern, not failing):`);
  for (const k of dead) console.log(`    - ${k}`);
}

function printSummary(locales, allKeys, used) {
  console.log('=== i18n audit ===\n');
  console.log(`Locales: ${LOCALES.join(', ')}`);
  for (const loc of LOCALES) {
    console.log(`  ${loc}: ${Object.keys(locales[loc]).length} keys`);
  }
  console.log(`Total unique keys (union): ${allKeys.size}`);
  console.log(`Used keys in source: ${used.size}\n`);
}

function main() {
  const locales = loadLocales();
  const { allKeys, missingByLocale } = diff(locales);
  const { used, dynamicPrefixes } = extractUsedKeys();

  printSummary(locales, allKeys, used);

  const crossLocaleRegression = reportCrossLocaleMissing(missingByLocale);
  const usedMissingRegression = reportUsedMissing(locales, used);
  const dead = findDeadKeys(allKeys, locales, used, dynamicPrefixes);
  reportDeadKeys(dead);

  console.log();
  if (crossLocaleRegression || usedMissingRegression) {
    console.log('FAIL: regressions detected.');
    process.exit(1);
  }
  console.log('OK');
}

if (require.main === module) {
  main();
}

module.exports = { flatten, loadLocales, diff, extractUsedKeys };
