/**
 * Backend self-poll realtimePosition (S4 #1537 / #1614 Phase A).
 *
 * 배경
 * ====
 * 기존 backend는 lock 활성 trip의 trainCode 추적 시점(`scheduled.ts:1888`)에만
 * `seoul.fetchPositions(lock.line)`을 호출한다. lock 부재(lockless) trip에는 realtimePosition을
 * 활용하지 않아 `consensusGate.ts:155` strongCB (positionTrainAgreement + arrival) 분기가
 * 영구 닫혀 있었다. 6/19 + 6/20 trip evidence — BG 지하 boardingPrompt 0건 + lock 부착 fail.
 *
 * 본 모듈은 cron 진입부에서 활성 trip의 line set을 추출 → 각 line마다
 * `seoul.fetchPositions(line)`을 병렬 호출 → 결과를 KV `realtime-position:<line>` 30s TTL로
 * stamp한다. caller(`advanceTripPosition` site들)는 본 stamp를 lock.trainCode와 cross-match해
 * `evidence.type='position-train'`을 합성 → strongCB 통과 가능.
 *
 * KV cacheTtl 정책
 * ================
 * `expirationTtl: 30s` — Cloudflare KV 런타임 floor(`KV_MIN_CACHE_TTL_SEC=30`). cron 1분 race
 * 보호: 같은 cycle 내 중복 호출 차단 + 다음 cycle 시작 직전까지 stale snapshot 활용 가능.
 * cacheTtl<30 회귀(#1364, [[lesson_cron_cachettl_runtime_constraint]])를 직접 차단.
 *
 * Rate limit / cost
 * =================
 * 호선당 1 entry — 활성 trip line union (대개 1~3 line)이므로 cron tick당 추가 KV write 1~3건,
 * Seoul API call도 1~3건. 같은 line trip이 여러 개여도 호출은 1회로 dedup.
 *
 * 본 모듈은 SeoulArrivalClient의 in-memory cache(15s)와는 별개 — Worker isolate가 바뀌면
 * in-memory cache가 사라지지만 KV stamp는 30s 살아남는다. 두 layer로 안정성 확보.
 */

import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';
import type { PositionEntry, SeoulArrivalClient } from './seoul';
import type { LineNumber } from './types';

/** KV key prefix — 노선 단위 1 entry. */
const SELF_POLL_PREFIX = 'realtime-position:';

/**
 * KV expirationTtl — Cloudflare 런타임 floor(`CRON_READ_CACHE_TTL_SEC=30`).
 *
 * 같은 cron cycle 내 dedup + 다음 cycle 시작 직전까지 stale snapshot 활용. Seoul API rate
 * limit 보호도 겸한다 — 호선당 30s에 1회 fetch 보장.
 */
export const SELF_POLL_TTL_SEC = CRON_READ_CACHE_TTL_SEC;

/** KV에 stamp된 self-poll entry (live PositionEntry[] + 적재 시점 stamp). */
interface SelfPollEntry {
  /** Seoul realtimePosition 결과 (호선 단위 모든 운행 trainCode 위치). */
  positions: PositionEntry[];
  /** stamp 시점 epoch ms — caller가 staleness 판정에 사용 (TTL 안쪽이라도 30s 직전이면 보수적 선택 가능). */
  fetchedAt: number;
}

export function selfPollKey(line: LineNumber): string {
  return `${SELF_POLL_PREFIX}${line}`;
}

/**
 * KV에서 line의 마지막 self-poll position 결과를 조회.
 *
 * `expirationTtl=30s` 안쪽이면 stamp가 살아 있고, 초과 시 KV가 자동 삭제 → null 반환.
 * caller(advanceTripPosition site들)가 trainCode cross-match 시도용.
 *
 * @param kv TRIPS KV namespace
 * @param line `LineNumber` (canonicalLineName로 정규화된 값)
 * @returns 마지막 stamp 또는 null
 */
export async function readSelfPollPosition(
  kv: KVNamespace,
  line: LineNumber,
): Promise<SelfPollEntry | null> {
  assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
  const raw = await kv.get(selfPollKey(line), { cacheTtl: CRON_READ_CACHE_TTL_SEC });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SelfPollEntry;
  } catch {
    return null;
  }
}

/**
 * `SeoulArrivalClient.fetchPositions(line)` 결과를 KV에 30s TTL로 stamp.
 *
 * Seoul API 호출 실패 시 빈 배열을 받을 수 있음(SeoulArrivalClient 내부에서 error→[] 매핑) —
 * 본 함수는 그대로 stamp한다. caller가 빈 배열을 "positionTrainAgreement undefined"로 자연
 * fallback (strongBE 분기 유지).
 *
 * @param kv TRIPS KV namespace
 * @param line `LineNumber`
 * @param positions `seoul.fetchPositions(line)` 결과
 * @param now stamp 시점 epoch ms
 */
export async function writeSelfPollPosition(
  kv: KVNamespace,
  line: LineNumber,
  positions: PositionEntry[],
  now: number,
): Promise<void> {
  const entry: SelfPollEntry = { positions, fetchedAt: now };
  await kv.put(selfPollKey(line), JSON.stringify(entry), {
    expirationTtl: SELF_POLL_TTL_SEC,
  });
}

/**
 * Self-poll 호출 stats — `runScheduled`의 stats 객체에 누적된다.
 *
 * - `fetched`: 실제 Seoul API 호출 횟수 (KV cache miss).
 * - `cacheHit`: KV stamp가 살아 있어 fetch skip한 횟수.
 * - `error`: SeoulArrivalClient throw + KV write throw 등 전반 실패.
 */
export interface SelfPollStats {
  fetched: number;
  cacheHit: number;
  error: number;
}

/**
 * 활성 trip line union에 대해 self-poll을 1회 수행하고 결과를 KV에 stamp.
 *
 * `runScheduled` 진입부에서 `listTrips`로 활성 trip을 enumerate한 caller가 `Set<LineNumber>`를
 * 모아 본 함수에 전달. 각 line에 대해 (1) KV stamp가 살아있으면 skip (cacheHit++) (2) 없으면
 * `seoul.fetchPositions(line)` 후 `writeSelfPollPosition` (fetched++).
 *
 * 병렬 `Promise.allSettled` — 한 line 실패가 다른 line 영향 X. 실패는 error++ 누적 후 graceful
 * (caller는 stamp 부재로 자연 fallback).
 *
 * @param kv TRIPS KV namespace
 * @param seoul SeoulArrivalClient
 * @param lines 활성 trip line union
 * @param now 현재 epoch ms (KV stamp 시점)
 * @returns SelfPollStats
 */
export async function pollLinesAndStamp(
  kv: KVNamespace,
  seoul: SeoulArrivalClient,
  lines: ReadonlySet<LineNumber>,
  now: number,
): Promise<SelfPollStats> {
  const stats: SelfPollStats = { fetched: 0, cacheHit: 0, error: 0 };
  if (lines.size === 0) return stats;
  await Promise.allSettled(
    Array.from(lines).map(async (line) => {
      try {
        const existing = await readSelfPollPosition(kv, line);
        if (existing) {
          stats.cacheHit += 1;
          return;
        }
        const positions = await seoul.fetchPositions(line);
        await writeSelfPollPosition(kv, line, positions, now);
        stats.fetched += 1;
      } catch {
        stats.error += 1;
      }
    }),
  );
  return stats;
}
