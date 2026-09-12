/**
 * 회귀(regression) 사례별 카운터 집계 + backend `/telemetry/regression` 업로드 (Epic #1204 그룹 0 PR B).
 *
 * Plan v7 Slide 0 박제 27건 중 본 PR이 다루는 "frontend에서 감지 가능한 회귀" id 4종을
 * 단일 SSOT(`KNOWN_REGRESSION_IDS`)로 정의한다. 카운트 자체를 발생시키는 코드(예: alarmKey
 * routeSig 비교, useArrivalInfo 캐시 mismatch)는 그룹 4/5에서 후속 wiring되며,
 * 본 PR은 인프라(카운터 + flush)만 제공한다.
 *
 * 패턴: 기존 `silentPushTelemetryFlush` / `triggerTripEndRecall`과 동형 graceful 정책.
 *   - URL/token 미설정 → no-op (skipped)
 *   - 합계 0 → 네트워크 호출 skip
 *   - fetch 실패 → 카운터 유지 (다음 trip-end에서 재시도)
 *   - 200 응답 → 카운터 reset
 *
 * 카운터는 모듈 메모리(빠른 record) + AsyncStorage 누적(앱 재시작/콜드 복귀에서도 유지) 이중 보관.
 * record 호출은 await 없이 fire-and-forget으로 트리거 코드의 critical path를 차단하지 않는다.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from './logger';
import {
  fetchWithTelemetryTimeout,
  getAlarmBackendUrl,
} from './telemetryHttp';

const log = createLogger('regressionMetrics');

/**
 * Backend `regressionTelemetry.ts`의 동일 id 집합과 양방향 SSOT.
 * 새 회귀 id 추가 시 본 배열 한 곳만 갱신하면 record/flush 양쪽이 자동 확장된다.
 *
 * 현재 id 매핑 (Slide 0 박제 기준):
 *   '8'  — alarmKey routeSig mismatch에 의한 매역 알림 누락
 *   '10' — useArrivalInfo provider 캐시 stale
 *   '11' — 환승 leg boundary에서 lockless trip 정확도 저하
 *   '12' — boardingPrompt 응답 후 lockless trip이 lock 활성과 다른 게이트로 처리됨
 */
export const KNOWN_REGRESSION_IDS = ['8', '10', '11', '12'] as const;

export type RegressionId = (typeof KNOWN_REGRESSION_IDS)[number];

/** AsyncStorage 카운터 저장 키 prefix. id 추가 시 자동 확장 — 별도 상수 갱신 불필요. */
const STORAGE_KEY_PREFIX = '@regression_counts:';

const storageKeyFor = (id: RegressionId): string => `${STORAGE_KEY_PREFIX}${id}`;

/**
 * 모듈 스코프 in-memory 카운터. record는 메모리만 즉시 증가 + AsyncStorage 누적은
 * fire-and-forget. flush는 메모리/스토리지 양쪽을 합산해 backend로 보낸다.
 */
const counters: Record<RegressionId, number> = createEmptyCounters();

/**
 * id별 persist 직렬화 큐. record→persist의 getItem→setItem R-M-W가 동일 id에 대해
 * 동시에 실행되면 두 번째 write가 첫 번째를 덮어쓰는 race가 발생한다. 직전 persist
 * 결과를 await한 뒤 다음 persist를 시작해 직렬화한다.
 */
const persistChains: Record<RegressionId, Promise<void>> = createEmptyChains();

function createEmptyCounters(): Record<RegressionId, number> {
  const out = {} as Record<RegressionId, number>;
  for (const id of KNOWN_REGRESSION_IDS) {
    out[id] = 0;
  }
  return out;
}

function createEmptyChains(): Record<RegressionId, Promise<void>> {
  const out = {} as Record<RegressionId, Promise<void>>;
  for (const id of KNOWN_REGRESSION_IDS) {
    out[id] = Promise.resolve();
  }
  return out;
}

/**
 * 회귀 1건 카운트 증가.
 *
 * 호출자(후속 그룹 4/5 PR이 회귀 검출 시점에 wire)는 fire-and-forget으로 호출한다.
 * AsyncStorage 쓰기 실패는 메모리 카운터로 graceful fallback — 실패는 warn 로그만 남기고
 * 호출자 흐름을 차단하지 않는다.
 *
 * @param id   회귀 id (KNOWN_REGRESSION_IDS 중 하나)
 * @param ctx  선택적 컨텍스트 (stationName 등). 본 PR에서는 로깅만, backend 전송 X.
 */
export function recordRegression(
  id: RegressionId,
  ctx?: { stationName?: string },
): void {
  counters[id] += 1;
  // 직전 persist 체인 settle 후 다음 R-M-W 시작(per-id 직렬화). persistCounter 실패는
  // 최종 .catch에서 흡수해 체인 자체는 항상 resolved 상태로 유지된다 — 다음 record가
  // 안전하게 .then으로 이어진다.
  persistChains[id] = persistChains[id]
    .then(() => persistCounter(id))
    .catch((e) => {
      log.warn(`persist failed id=${id}`, e);
    });
  if (ctx?.stationName) {
    log.debug(`record id=${id} station=${ctx.stationName}`);
  } else {
    log.debug(`record id=${id}`);
  }
}

async function persistCounter(id: RegressionId): Promise<void> {
  const key = storageKeyFor(id);
  const prevRaw = await AsyncStorage.getItem(key);
  const prev = parseCount(prevRaw);
  await AsyncStorage.setItem(key, String(prev + 1));
}

function parseCount(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * DebugModal (그룹 0 PR C) 표기용. id별 누적 카운트 스냅샷(메모리 기준).
 * 외부에서 수정 불가하도록 객체 복사본을 반환한다.
 */
export function getRegressionCountsSnapshot(): Record<RegressionId, number> {
  return { ...counters };
}

/**
 * trip 종료 시 호출되는 flush. AsyncStorage + 메모리 카운터를 합산해 backend로 1건 upload.
 * 200 응답 시 메모리/스토리지 양쪽 reset, 실패 시 유지(다음 trip-end에서 재시도).
 *
 * graceful: URL/token 미설정, 합계 0, fetch 실패 모두 throw 없이 graceful return.
 *
 * @param token APNs device token (호출자 책임으로 발급된 식별자).
 */
export async function flushRegressionCounters(token: string): Promise<void> {
  try {
    const base = getAlarmBackendUrl();
    if (!base) {
      log.info('ALARM_BACKEND_URL not set — skip regression flush');
      return;
    }
    if (!token) {
      log.info('empty token — skip regression flush');
      return;
    }

    const until = Date.now();
    const since = await readSinceKey();
    const counts = await readCombinedCounts();
    const total = sumCounts(counts);
    if (total === 0) {
      // 보낼 데이터 없음 — since만 갱신해 다음 윈도우를 좁힌다.
      await writeSinceKey(until);
      return;
    }

    const res = await fetchWithTelemetryTimeout(`${base}/telemetry/regression`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, since, until, counts }),
    });

    if (!res.ok) {
      log.warn(`regression flush failed status=${res.status}`);
      return;
    }
    await resetCounters();
    await writeSinceKey(until);
  } catch (e) {
    log.warn('regression flush error', e);
  }
}

const SINCE_KEY = `${STORAGE_KEY_PREFIX}__since`;

async function readSinceKey(): Promise<number> {
  const raw = await AsyncStorage.getItem(SINCE_KEY);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeSinceKey(until: number): Promise<void> {
  await AsyncStorage.setItem(SINCE_KEY, String(until));
}

/**
 * AsyncStorage 누적값 + 메모리 카운터 합산. 콜드 복귀(앱 강제종료 후 재실행) 후에도
 * record가 메모리에만 들어간 카운트가 사라지지 않게 한다.
 */
async function readCombinedCounts(): Promise<Record<RegressionId, number>> {
  const out = createEmptyCounters();
  for (const id of KNOWN_REGRESSION_IDS) {
    const raw = await AsyncStorage.getItem(storageKeyFor(id));
    out[id] = parseCount(raw) + counters[id];
  }
  return out;
}

function sumCounts(counts: Record<RegressionId, number>): number {
  let total = 0;
  for (const id of KNOWN_REGRESSION_IDS) {
    total += counts[id];
  }
  return total;
}

async function resetCounters(): Promise<void> {
  for (const id of KNOWN_REGRESSION_IDS) {
    counters[id] = 0;
    await AsyncStorage.removeItem(storageKeyFor(id));
  }
}

/**
 * 테스트 전용: 모든 id의 pending persist 체인이 settle될 때까지 대기.
 * 호출자가 recordRegression 직후 storage 상태를 검증해야 할 때만 사용.
 * 체인은 항상 resolved 상태로 유지되므로 추가 catch는 불필요.
 */
export async function __waitForPendingPersists(): Promise<void> {
  await Promise.all(KNOWN_REGRESSION_IDS.map((id) => persistChains[id]));
}
