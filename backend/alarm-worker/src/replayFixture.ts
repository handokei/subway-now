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
  /**
   * 포함된 cycle 시작 시각들 (오름차순) — 재생 cron tick 기준점. 어떤 cycle의 entry가
   * window 안에 하나도 남지 않으면 그 cycle의 cycleStartMs는 여기 포함하지 않는다
   * (entries와 cycleStartsMs의 소속 불일치를 막기 위해, #2580 리뷰).
   */
  cycleStartsMs: number[];
  /** 전 cycle entries 평탄화, tMs 오름차순. */
  entries: SeoulCaptureEntry[];
  /**
   * window에 걸친 cycle들(`SeoulCaptureCycle.droppedEntries`)에서 캡처 상한
   * (MAX_ENTRIES/MAX_TOTAL_BODY_BYTES, `seoulCapture.ts`)으로 유실된 entry 수의 합.
   * 유실이 없으면(0) 필드 자체를 생략한다 — P0-c가 이 fixture로 재생한 trip의 신뢰도를
   * 판단할 때(불완전 캡처 경고) 참조한다.
   */
  droppedEntries?: number;
  /**
   * window에 걸친 cycle 중 `scanned === -1`(index.ts — runScheduled가 throw해 stats를
   * 확보하지 못한 실패 cycle의 sentinel)인 cycleStartMs들, 오름차순. 없으면 필드 자체를
   * 생략한다 — P0-c가 이 구간의 재생 결과를 "입력 자체가 불완전했다"로 구분해 경고하는
   * 데 쓴다.
   */
  failedCycleStartsMs?: number[];
}

/** window 제약 — 한쪽만 지정하면 그 방향은 열린 구간으로 취급한다. */
export interface ReplayFixtureWindowBound {
  fromMs?: number;
  toMs?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * capture cycle 배열 → fixture 병합.
 * - `window`를 완전히 지정(`fromMs`+`toMs` 둘 다)하면 그 값을 그대로 fixture.window로
 *   쓴다(범위 밖 entry/cycleStartMs는 제외).
 * - 한쪽만 지정하면 그 방향만 제약하고 반대쪽은 실제 데이터 범위로 자동 산출한다.
 * - 아예 미지정하면 cycle 전체 범위(entries의 tMs min~max, entries가 없으면 cycleStartMs
 *   min~max)를 자동 산출한다.
 * - entries는 tMs 오름차순 정렬해 반환한다(입력 cycle 순서에 의존하지 않음).
 * - cycleStartsMs는 "그 cycle의 entry가 window에 하나라도 남았는가"로 판단한다.
 *   cycleStartMs 자체로 필터하면 entry는 window 안인데 소속 cycle의 cycleStartMs만
 *   밖으로 밀려나 tick이 탈락하는 불일치가 생긴다(#2580 리뷰).
 * - cycle의 `truncated` entry는 그대로 보존한다 — 재생 시 빈 응답 취급은 하네스 책임.
 */
export function buildReplayFixture(cycles: SeoulCaptureCycle[], window?: ReplayFixtureWindowBound): ReplayFixture {
  const fromBound = window?.fromMs;
  const toBound = window?.toMs;
  const inWindow = (ms: number): boolean =>
    (fromBound === undefined || ms >= fromBound) && (toBound === undefined || ms <= toBound);

  const includedCycles = cycles.filter((cycle) => cycle.entries.some((entry) => inWindow(entry.tMs)));

  const entries = includedCycles
    .flatMap((cycle) => cycle.entries.filter((entry) => inWindow(entry.tMs)))
    .sort((a, b) => a.tMs - b.tMs);

  const cycleStartsMs = includedCycles.map((cycle) => cycle.cycleStartMs).sort((a, b) => a - b);

  // droppedEntries/failedCycleStartsMs는 cycle 자체가 이 시간창에 걸치는지(cycleStartMs
  // 기준)로 판단한다 — 손실/실패 신호는 그 cycle이 실제로 entry를 살렸는지와 무관하다.
  const cyclesInWindow = cycles.filter((cycle) => inWindow(cycle.cycleStartMs));

  const droppedEntriesTotal = cyclesInWindow.reduce((sum, cycle) => sum + (cycle.droppedEntries ?? 0), 0);
  const failedCycleStartsMs = cyclesInWindow
    .filter((cycle) => cycle.scanned === -1)
    .map((cycle) => cycle.cycleStartMs)
    .sort((a, b) => a - b);

  const resolvedWindow =
    fromBound !== undefined && toBound !== undefined
      ? { fromMs: fromBound, toMs: toBound }
      : computeWindow(
          entries,
          cycles.map((cycle) => cycle.cycleStartMs),
          fromBound,
          toBound,
        );

  return {
    schemaVersion: 1,
    source: 'backend-seoul',
    window: resolvedWindow,
    cycleStartsMs,
    entries,
    ...(droppedEntriesTotal > 0 ? { droppedEntries: droppedEntriesTotal } : {}),
    ...(failedCycleStartsMs.length > 0 ? { failedCycleStartsMs } : {}),
  };
}

/**
 * window 미지정(또는 한쪽만 지정) 시 반대쪽을 자동 산출한다 — entries 우선, entries가
 * 없으면 cycleStartMs로 fallback. entries는 이미 tMs 오름차순 정렬된 상태로 들어오므로
 * 첫/끝 원소를 바로 쓴다(스프레드 min/max는 entry 수가 많을 때 RangeError 위험, #2580 리뷰).
 */
function computeWindow(
  sortedEntries: SeoulCaptureEntry[],
  allCycleStartsMs: number[],
  fromBound?: number,
  toBound?: number,
): { fromMs: number; toMs: number } {
  const derived = deriveDataRange(sortedEntries, allCycleStartsMs);
  return {
    fromMs: fromBound ?? derived.fromMs,
    toMs: toBound ?? derived.toMs,
  };
}

function deriveDataRange(
  sortedEntries: SeoulCaptureEntry[],
  allCycleStartsMs: number[],
): { fromMs: number; toMs: number } {
  if (sortedEntries.length > 0) {
    return { fromMs: sortedEntries[0].tMs, toMs: sortedEntries[sortedEntries.length - 1].tMs };
  }
  if (allCycleStartsMs.length > 0) {
    const sorted = [...allCycleStartsMs].sort((a, b) => a - b);
    return { fromMs: sorted[0], toMs: sorted[sorted.length - 1] };
  }
  return { fromMs: 0, toMs: 0 };
}

/**
 * fixture가 캡처 유실/실패 신호(`droppedEntries`/`failedCycleStartsMs`)를 갖고 있는지 —
 * 이 신호가 있으면 이 fixture로 만든 재생 결과(특히 "발사 안 됨" 결론)는 불완전한 입력으로
 * 만들어진 것이니 신뢰도 판단에 반영해야 한다. 이 판정 로직의 SSoT는 스키마를 소유한 이
 * 모듈이며, `replayHarness.ts`(runCaptureReplay 결과의 lossyCapture)와
 * `replay_library.full.test.ts`(라이브러리 lossy 등록 가드) 양쪽이 이 함수 하나를 소비한다
 * (#2585 리뷰 — 인라인 중복 판정 제거).
 */
export function isLossyFixture(fixture: ReplayFixture): boolean {
  return (fixture.droppedEntries ?? 0) > 0 || (fixture.failedCycleStartsMs?.length ?? 0) > 0;
}

/**
 * unknown JSON → ReplayFixture 검증 파싱. 필드 타입/불변식이 한 곳이라도 어긋나면
 * 이유를 포함한 Error를 throw한다(`parseBoardingLock`류 방어적 fallback과 달리, fixture는
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
  const cycleStartsMs = parseNumberArray(o.cycleStartsMs, 'cycleStartsMs');

  if (!Array.isArray(o.entries)) {
    throw new Error('replay fixture: entries는 배열이어야 합니다');
  }
  const entries = o.entries.map((entry, index) => parseCaptureEntry(entry, index));

  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].tMs < entries[i - 1].tMs) {
      throw new Error(`replay fixture: entries는 tMs 오름차순이어야 합니다 (entries[${i}].tMs < entries[${i - 1}].tMs)`);
    }
  }

  const fixture: ReplayFixture = { schemaVersion: 1, source: 'backend-seoul', window, cycleStartsMs, entries };

  if (o.droppedEntries !== undefined) {
    if (!isFiniteNumber(o.droppedEntries)) {
      throw new Error('replay fixture: droppedEntries는 유한한 number여야 합니다');
    }
    fixture.droppedEntries = o.droppedEntries;
  }
  if (o.failedCycleStartsMs !== undefined) {
    fixture.failedCycleStartsMs = parseNumberArray(o.failedCycleStartsMs, 'failedCycleStartsMs');
  }

  return fixture;
}

function parseWindow(raw: unknown): { fromMs: number; toMs: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('replay fixture: window는 object여야 합니다');
  }
  const o = raw as Record<string, unknown>;
  if (!isFiniteNumber(o.fromMs)) {
    throw new Error('replay fixture: window.fromMs는 유한한 number여야 합니다');
  }
  if (!isFiniteNumber(o.toMs)) {
    throw new Error('replay fixture: window.toMs는 유한한 number여야 합니다');
  }
  if (o.fromMs > o.toMs) {
    throw new Error(`replay fixture: window.fromMs(${o.fromMs})는 window.toMs(${o.toMs})보다 클 수 없습니다`);
  }
  return { fromMs: o.fromMs, toMs: o.toMs };
}

function parseNumberArray(raw: unknown, fieldName: string): number[] {
  if (!Array.isArray(raw) || !raw.every((v) => isFiniteNumber(v))) {
    throw new Error(`replay fixture: ${fieldName}는 유한한 number[]여야 합니다`);
  }
  return raw;
}

function parseCaptureEntry(raw: unknown, index: number): SeoulCaptureEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`capture entry: entries[${index}]는 object여야 합니다`);
  }
  const o = raw as Record<string, unknown>;

  if (!isFiniteNumber(o.tMs)) {
    throw new Error(`capture entry: entries[${index}].tMs는 유한한 number여야 합니다`);
  }
  if (o.kind !== 'arrival' && o.kind !== 'position') {
    throw new Error(`capture entry: entries[${index}].kind는 'arrival'|'position'이어야 합니다`);
  }
  if (typeof o.target !== 'string') {
    throw new Error(`capture entry: entries[${index}].target는 string이어야 합니다`);
  }
  if (typeof o.url !== 'string') {
    throw new Error(`capture entry: entries[${index}].url는 string이어야 합니다`);
  }
  if (!isFiniteNumber(o.status)) {
    throw new Error(`capture entry: entries[${index}].status는 유한한 number여야 합니다`);
  }
  if (typeof o.body !== 'string') {
    throw new Error(`capture entry: entries[${index}].body는 string이어야 합니다`);
  }
  if (o.truncated !== undefined && typeof o.truncated !== 'boolean') {
    throw new Error(`capture entry: entries[${index}].truncated는 boolean이어야 합니다`);
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

/**
 * unknown JSON → SeoulCaptureCycle 검증 파싱. 번들러 CLI(`scripts/buildReplayFixture.mjs`)가
 * 로컬 capture 파일을 읽을 때 쓴다 — mjs는 얇은 I/O 셸이라 검증 로직을 갖지 않고 이 함수를
 * 호출만 한다(#2580 리뷰). entry 검증은 `parseCaptureEntry`를 그대로 재사용한다.
 */
export function parseSeoulCaptureCycle(raw: unknown): SeoulCaptureCycle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('seoul capture cycle: root은 object여야 합니다');
  }
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== 1) {
    throw new Error(`seoul capture cycle: schemaVersion은 1이어야 합니다 (got ${JSON.stringify(o.schemaVersion)})`);
  }
  if (!isFiniteNumber(o.cycleStartMs)) {
    throw new Error('seoul capture cycle: cycleStartMs는 유한한 number여야 합니다');
  }
  if (!isFiniteNumber(o.scanned)) {
    throw new Error('seoul capture cycle: scanned는 유한한 number여야 합니다');
  }
  if (!isFiniteNumber(o.seoulCalls)) {
    throw new Error('seoul capture cycle: seoulCalls는 유한한 number여야 합니다');
  }
  if (!Array.isArray(o.entries)) {
    throw new Error('seoul capture cycle: entries는 배열이어야 합니다');
  }
  const entries = o.entries.map((entry, index) => parseCaptureEntry(entry, index));

  if (o.droppedEntries !== undefined && !isFiniteNumber(o.droppedEntries)) {
    throw new Error('seoul capture cycle: droppedEntries는 유한한 number여야 합니다');
  }

  return {
    schemaVersion: 1,
    cycleStartMs: o.cycleStartMs,
    scanned: o.scanned,
    seoulCalls: o.seoulCalls,
    entries,
    ...(o.droppedEntries !== undefined ? { droppedEntries: o.droppedEntries as number } : {}),
  };
}
