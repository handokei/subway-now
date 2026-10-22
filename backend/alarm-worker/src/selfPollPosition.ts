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
import { updateStationTrainLogs, type StationTrainLogs } from './anchorDepartures';
import type { PositionEntry, SeoulArrivalClient } from './seoul';
import type { LineNumber } from './types';

/** KV key prefix — 노선 단위 1 entry (기존 line-unit polling 유지). */
const SELF_POLL_PREFIX = 'realtime-position:';

/**
 * KV expirationTtl (초).
 *
 * #2073 (Issue TTL) — 30s(cron 60s 주기보다 짧음)라 매 tick마다 KV entry가 항상 만료돼 있어
 * `existing` cache-hit이 절대 성립하지 않고 line/station마다 매 tick 강제 재fetch + 재write를
 * 유발했다(활성 trip 1개 = write 600~900/시간, station stamp ×5가 지배적, 2026-07-29 quota audit).
 *
 * 90s로 상향(cron 60s의 1.5배)하면 다음 tick(60s 후)에도 entry가 살아있어 소비자(`readFreshSelfPollPosition`)가
 * 읽을 수 있다. 단 이 TTL은 "fetch 주기"가 아니라 "생존 기간"이다 — 위치 fetch 주기는
 * `SELF_POLL_REFRESH_MS`가 정한다(#3118).
 *
 * 2026-10-21 발견(#3118): 원래 `pollLinesAndStamp`는 entry 존재만으로 cache hit 처리해, TTL 90s 때문에
 * 위치가 2 tick에 1회만 갱신됐다(실제 동작은 "120s에 1회 fetch"). #2073 스펙은 매 tick fetch였으므로
 * 위치 경로는 스펙 이탈이었고 `SELF_POLL_REFRESH_MS`로 복원했다. (역 도착정보 stamp `pollStationsAndStamp`는
 * 읽는 곳이 없어 #3166에서 제거.)
 */
export const SELF_POLL_TTL_SEC = 90;

/**
 * #3118 — 위치 KV stamp 재fetch 임계(ms). `now - fetchedAt`이 이 값 이상이면 cache hit이 아니라 재fetch.
 * cron tick이 :45~:46에 도착하므로 45s면 매 tick 재fetch가 보장되면서, 같은 tick의 이중 호출
 * (수십 ms~수 초 간격)은 계속 흡수한다. 위치(`pollLinesAndStamp`) 전용.
 */
export const SELF_POLL_REFRESH_MS = 45_000;

/**
 * #2079 (P2, #2077 사후 리뷰 follow-up) — position consumer용 staleness 게이트(초).
 *
 * `SELF_POLL_TTL_SEC` 90s 상향(#2073) 이후 `pollLinesAndStamp`의 cache-hit 분기가 정상 동작하면
 * KV entry가 최대 90s까지 재fetch 없이 살아남는다. 이 자체는 write 감축 의도대로지만, trainCode
 * 재합성처럼 "현재 위치"를 근거로 판단하는 consumer(예: vanish-reattach `attachTrainCodeForLeg`)가
 * 그 90s 전 snapshot을 staleness 게이트 없이 그대로 쓰면 이미 waypoint를 통과한 열차의 trainCode를
 * 재합성해 잘못된 lock으로 이어질 수 있다(vanish-reattach 오lock).
 *
 * `readFreshSelfPollPosition`이 이 상수로 consumer 측에서만 게이트한다 — `pollLinesAndStamp`의
 * 내부 cache-hit 체크(`readSelfPollPosition` 직접 사용)는 그대로 두어 TTL 90s의 write 감축 효과를
 * 보존한다(게이트를 그 경로에도 적용하면 cron 60s 주기와 60s 임계값이 거의 겹쳐 매 tick 재fetch로
 * 되돌아가 #2073 회귀가 재발한다).
 */
export const SELF_POLL_POSITION_MAX_AGE_SEC = 60;

/** KV에 stamp된 self-poll entry (live PositionEntry[] + 적재 시점 stamp). */
interface SelfPollEntry {
  /** Seoul realtimePosition 결과 (호선 단위 모든 운행 trainCode 위치). */
  positions: PositionEntry[];
  /** stamp 시점 epoch ms — caller가 staleness 판정에 사용 (TTL 안쪽이라도 30s 직전이면 보수적 선택 가능). */
  fetchedAt: number;
  /**
   * #3155 — 추적 역별 최근 10분 출발 기록. 같은 put에 실려 추가 KV write가 없다. 추적 역 인자가 없거나
   * 기록할 열차가 없으면 필드 자체가 없다(기존 stamp 형태 불변).
   */
  stationLogs?: StationTrainLogs;
}

export function selfPollKey(line: LineNumber): string {
  return `${SELF_POLL_PREFIX}${line}`;
}

/**
 * KV에서 line의 마지막 self-poll position 결과를 조회.
 *
 * `expirationTtl=SELF_POLL_TTL_SEC`(90s) 안쪽이면 stamp가 살아 있고, 초과 시 KV가 자동 삭제 →
 * null 반환. `pollLinesAndStamp`의 내부 cache-hit 체크가 이 raw 함수를 직접 사용한다 — staleness
 * 게이트를 적용하지 않아 TTL 90s의 write 감축 효과를 그대로 보존한다.
 *
 * trainCode 재합성처럼 "현재 위치" 판단에 쓰는 consumer는 이 함수 대신
 * `readFreshSelfPollPosition`(#2079 P2 staleness 게이트 적용)을 사용한다.
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
 * #2079 (P2) — position consumer(예: vanish-reattach `attachTrainCodeForLeg`)용 staleness
 * 게이트가 적용된 `readSelfPollPosition` wrapper.
 *
 * `entry.fetchedAt`이 `now` 기준 `SELF_POLL_POSITION_MAX_AGE_SEC`(60s)를 초과하면 KV entry가
 * TTL(90s) 안쪽에 살아 있어도 stale로 간주해 `null`을 반환한다. "현재 위치"를 근거로 trainCode를
 * 재합성하는 모든 consumer는 이 함수를 사용해야 한다(단일 게이트 지점).
 *
 * `pollLinesAndStamp`의 내부 cache-hit 체크에는 적용하지 않는다 — write 감축 목적은 raw
 * `readSelfPollPosition`으로 유지한다.
 *
 * @param kv TRIPS KV namespace
 * @param line `LineNumber`
 * @param now 판정 시점 epoch ms (caller의 tick `now`)
 * @returns staleness 게이트를 통과한 stamp 또는 null(부재/malformed/stale)
 */
export async function readFreshSelfPollPosition(
  kv: KVNamespace,
  line: LineNumber,
  now: number,
): Promise<SelfPollEntry | null> {
  const entry = await readSelfPollPosition(kv, line);
  if (!entry) return null;
  const ageSec = (now - entry.fetchedAt) / 1000;
  if (ageSec > SELF_POLL_POSITION_MAX_AGE_SEC) return null;
  return entry;
}

/**
 * `SeoulArrivalClient.fetchPositions(line)` 결과를 KV에 30s TTL로 stamp.
 *
 * Seoul API 호출 실패 시 빈 배열을 받을 수 있음(SeoulArrivalClient 내부에서 error→[] 매핑) —
 * 본 함수는 그대로 stamp한다. caller가 빈 배열이면 position-train evidence를 합성하지 못해
 * strongBE(arrival + lockAttachable) 분기로 자연 fallback한다.
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
  stationLogs?: StationTrainLogs,
): Promise<void> {
  const entry: SelfPollEntry = { positions, fetchedAt: now, ...(stationLogs ? { stationLogs } : {}) };
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
  trackedStations?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SelfPollStats> {
  const stats: SelfPollStats = { fetched: 0, cacheHit: 0, error: 0 };
  if (lines.size === 0) return stats;
  await Promise.allSettled(
    Array.from(lines).map(async (line) => {
      try {
        const existing = await readSelfPollPosition(kv, line);
        if (existing && now - existing.fetchedAt < SELF_POLL_REFRESH_MS) {
          stats.cacheHit += 1;
          return;
        }
        const positions = await seoul.fetchPositions(line);
        // #3155 — 직전 stamp(existing)와 비교한 앵커역 출발 기록을 **같은 put**에 싣는다(추가 write 0).
        const tracked = trackedStations?.get(line);
        const stationLogs = tracked
          ? updateStationTrainLogs(existing?.stationLogs, positions, tracked, now)
          : undefined;
        await writeSelfPollPosition(kv, line, positions, now, stationLogs);
        stats.fetched += 1;
      } catch {
        stats.error += 1;
      }
    }),
  );
  return stats;
}
