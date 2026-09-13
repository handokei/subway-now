/**
 * 재생 fixture 표준 스키마 + 병합/검증 (Epic #2239 P0-b, #2580).
 *
 * P0-a(#2579)가 R2에 쌓는 `SeoulCaptureCycle` JSON들(cycle 단위, 로컬 시간 조각)을
 * 시간창 기준으로 병합해 P0-c 재생 하네스가 곧장 소비할 수 있는 fixture 하나로
 * 만든다. R2 다운로드/네트워크 IO는 이 모듈 책임이 아니다 — 순수 변환 함수만 둔다
 * (shell CLI는 `scripts/buildReplayFixture.mjs`).
 */
import type { SeoulCaptureEntry, SeoulCaptureCycle } from './seoulCapture';

/** 재생 fixture 스키마 v1 — capture cycle들을 시간창으로 병합한 것. */
export interface ReplayFixture {
  schemaVersion: 1;
  source: 'backend-seoul';
  /** 병합에 포함된 시간창 (epoch ms). */
  window: { fromMs: number; toMs: number };
  /** 포함된 cycle 시작 시각들 (오름차순) — 재생 cron tick 기준점. */
  cycleStartsMs: number[];
  /** 전 cycle entries 평탄화, tMs 오름차순. */
  entries: SeoulCaptureEntry[];
}

/**
 * capture cycle 배열 → fixture 병합.
 * - `window` 미지정 시 cycle 전체 범위(entries의 tMs min~max, entries가 없으면
 *   cycleStartMs min~max)를 자동 산출한다.
 * - `window` 지정 시 범위(inclusive) 밖 entry/cycleStartMs는 제외한다.
 * - entries는 tMs 오름차순 정렬해 반환한다(입력 cycle 순서에 의존하지 않음).
 * - cycle의 `truncated` entry는 그대로 보존한다 — 재생 시 빈 응답 취급은 하네스 책임.
 */
export function buildReplayFixture(
  cycles: SeoulCaptureCycle[],
  window?: { fromMs: number; toMs: number },
): ReplayFixture {
  const allEntries = cycles.flatMap((cycle) => cycle.entries);
  const allCycleStartsMs = cycles.map((cycle) => cycle.cycleStartMs);

  const inWindow = (ms: number): boolean => !window || (ms >= window.fromMs && ms <= window.toMs);

  const entries = allEntries.filter((entry) => inWindow(entry.tMs)).sort((a, b) => a.tMs - b.tMs);
  const cycleStartsMs = allCycleStartsMs.filter(inWindow).sort((a, b) => a - b);

  return {
    schemaVersion: 1,
    source: 'backend-seoul',
    window: window ?? computeWindow(entries, allCycleStartsMs),
    cycleStartsMs,
    entries,
  };
}

/** window 미지정 시 자동 산출 — entries 우선, entries가 없으면 cycleStartMs로 fallback. */
function computeWindow(
  entries: SeoulCaptureEntry[],
  cycleStartsMs: number[],
): { fromMs: number; toMs: number } {
  if (entries.length > 0) {
    const tMsValues = entries.map((entry) => entry.tMs);
    return { fromMs: Math.min(...tMsValues), toMs: Math.max(...tMsValues) };
  }
  if (cycleStartsMs.length > 0) {
    return { fromMs: Math.min(...cycleStartsMs), toMs: Math.max(...cycleStartsMs) };
  }
  return { fromMs: 0, toMs: 0 };
}

/**
 * unknown JSON → ReplayFixture 검증 파싱. 필드 타입이 한 곳이라도 어긋나면 이유를
 * 포함한 Error를 throw한다(`parseBoardingLock`류 방어적 fallback과 달리, fixture는
 * 재생 입력 그 자체라 silent drop 대신 fail-fast가 맞다).
 */
export function parseReplayFixture(raw: unknown): ReplayFixture {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('replay fixture: root은 object여야 합니다');
  }
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== 1) {
    throw new Error(`replay fixture: schemaVersion은 1이어야 합니다 (got ${JSON.stringify(o.schemaVersion)})`);
  }
  if (o.source !== 'backend-seoul') {
    throw new Error(`replay fixture: source는 'backend-seoul'이어야 합니다 (got ${JSON.stringify(o.source)})`);
  }

  const window = parseWindow(o.window);
  const cycleStartsMs = parseCycleStartsMs(o.cycleStartsMs);

  if (!Array.isArray(o.entries)) {
    throw new Error('replay fixture: entries는 배열이어야 합니다');
  }
  const entries = o.entries.map((entry, index) => parseCaptureEntry(entry, index));

  return { schemaVersion: 1, source: 'backend-seoul', window, cycleStartsMs, entries };
}

function parseWindow(raw: unknown): { fromMs: number; toMs: number } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('replay fixture: window는 object여야 합니다');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.fromMs !== 'number') {
    throw new Error('replay fixture: window.fromMs는 number여야 합니다');
  }
  if (typeof o.toMs !== 'number') {
    throw new Error('replay fixture: window.toMs는 number여야 합니다');
  }
  return { fromMs: o.fromMs, toMs: o.toMs };
}

function parseCycleStartsMs(raw: unknown): number[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'number')) {
    throw new Error('replay fixture: cycleStartsMs는 number[]여야 합니다');
  }
  return raw;
}

function parseCaptureEntry(raw: unknown, index: number): SeoulCaptureEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`replay fixture: entries[${index}]는 object여야 합니다`);
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.tMs !== 'number') {
    throw new Error(`replay fixture: entries[${index}].tMs는 number여야 합니다`);
  }
  if (o.kind !== 'arrival' && o.kind !== 'position') {
    throw new Error(`replay fixture: entries[${index}].kind는 'arrival'|'position'이어야 합니다`);
  }
  if (typeof o.target !== 'string') {
    throw new Error(`replay fixture: entries[${index}].target는 string이어야 합니다`);
  }
  if (typeof o.url !== 'string') {
    throw new Error(`replay fixture: entries[${index}].url는 string이어야 합니다`);
  }
  if (typeof o.status !== 'number') {
    throw new Error(`replay fixture: entries[${index}].status는 number여야 합니다`);
  }
  if (typeof o.body !== 'string') {
    throw new Error(`replay fixture: entries[${index}].body는 string이어야 합니다`);
  }
  if (o.truncated !== undefined && typeof o.truncated !== 'boolean') {
    throw new Error(`replay fixture: entries[${index}].truncated는 boolean이어야 합니다`);
  }

  return {
    tMs: o.tMs,
    kind: o.kind,
    target: o.target,
    url: o.url,
    status: o.status,
    body: o.body,
    ...(o.truncated !== undefined ? { truncated: o.truncated } : {}),
  };
}
