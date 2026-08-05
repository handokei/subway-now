/**
 * boardingPrompt counter 24h 누적 (#2160, follow-up of #2151 / PR #2156 P2 리뷰).
 *
 * 배경
 * ====
 * PR #2156은 boardingPrompt skip/fire counter를 obs-metrics 갱신 tick(1h 주기)의 **1분
 * 스냅샷**으로 노출했다 — 특정 trip의 프롬프트 평가가 그 1분 tick에 걸릴 확률이 ~1/60이라,
 * 원 이슈(#2151)의 목적인 "특정 trip 사후 RCA 판별"을 사실상 충족하지 못했다.
 *
 * 본 모듈은 trip이 1개 이상 활성인 tick(=아래 delta 중 하나라도 >0인 tick)에서만 단일 KV
 * 키를 read-modify-write로 누적한다. idle tick(활성 trip 0 → delta 전부 0)은 read/write 모두
 * 발생하지 않는다 — CF 무료 quota cron burn 재발 방지
 * ([[lesson_cf_free_quota_cron_kv_burn]]).
 *
 * TTL은 매 write마다 24h로 갱신되는 rolling window — 마지막 활성 tick으로부터 24h 동안
 * 누적치가 유지된다(엄밀한 "지난 24h만" 슬라이딩 윈도우는 아니지만, 단독 사용자 기준 하루 수십
 * 회의 활성 tick이 지속적으로 TTL을 갱신하므로 실질적으로 최근 활동을 반영한다).
 *
 * cacheTtl 런타임 제약(Cloudflare KV는 cacheTtl < 30을 throw, [[lesson_cron_cachettl_runtime_constraint]])
 * 준수를 위해 read 시 `CRON_READ_CACHE_TTL_SEC`(30s)를 명시한다.
 */

import { CRON_READ_CACHE_TTL_SEC } from './kvConsistency';

/** 누적 KV 키. hourly bucket이 아닌 단일 rolling 키. */
export const BOARDING_PROMPT_COUNTER_KEY = 'boarding-prompt-counters:v1';

/** TTL — 24h. 매 활성 tick write마다 갱신(rolling). */
const BOARDING_PROMPT_COUNTER_TTL_SEC = 24 * 60 * 60;

/** 한 tick에서 발생한 boardingPrompt counter 증분(delta). */
export interface BoardingPromptCounterDelta {
  evaluated: number;
  fired: number;
  blocked: number;
  skippedNoContext: number;
  skippedStale: number;
  skippedTooFar: number;
  skippedTrainDuplicate: number;
}

/**
 * 누적된 boardingPrompt counter. self-describing 필드로 `window`(누적 의미: rolling 24h TTL
 * 기반이라 정확한 "지난 24h 합"은 아니고 "마지막 활성 tick까지의 누적치"임을 명시)와
 * `sampledAt`(마지막 누적 write epoch ms)을 포함해 obs-metrics 응답 소비자가 이 값이
 * PR #2156의 1분 스냅샷이 아님을 오독하지 않도록 한다.
 */
export interface BoardingPromptCounters extends BoardingPromptCounterDelta {
  window: '24h';
  sampledAt: number;
}

/** `boardingPromptCounters` 미제공 시(cold-compute) 사용하는 zero 기본값. */
export const EMPTY_BOARDING_PROMPT_COUNTERS: BoardingPromptCounters = {
  evaluated: 0,
  fired: 0,
  blocked: 0,
  skippedNoContext: 0,
  skippedStale: 0,
  skippedTooFar: 0,
  skippedTrainDuplicate: 0,
  window: '24h',
  sampledAt: 0,
};

/**
 * 누적 KV 키에서 현재까지 누적된 boardingPrompt counter를 읽는다.
 * 키가 없거나(첫 누적 전) malformed JSON이면 null.
 */
export async function readBoardingPromptCounters(
  tripsKv: KVNamespace,
): Promise<BoardingPromptCounters | null> {
  const raw = await tripsKv.get(BOARDING_PROMPT_COUNTER_KEY, {
    cacheTtl: CRON_READ_CACHE_TTL_SEC,
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BoardingPromptCounters;
  } catch {
    return null;
  }
}

/**
 * 이번 tick의 delta를 누적 KV 키에 read-modify-write.
 *
 * delta 전부 0이면(=idle tick, 활성 trip 0) KV read/write 모두 skip하고 null 반환 —
 * 이 gate가 "idle tick write 0" 불변식의 유일한 강제 지점이다.
 *
 * @returns 누적 후 최신 counters. idle-skip 시 null.
 */
export async function accumulateBoardingPromptCounters(
  tripsKv: KVNamespace,
  delta: BoardingPromptCounterDelta,
  now: number,
): Promise<BoardingPromptCounters | null> {
  const hasDelta =
    delta.evaluated > 0 ||
    delta.fired > 0 ||
    delta.blocked > 0 ||
    delta.skippedNoContext > 0 ||
    delta.skippedStale > 0 ||
    delta.skippedTooFar > 0 ||
    delta.skippedTrainDuplicate > 0;
  if (!hasDelta) return null;

  const existing = await readBoardingPromptCounters(tripsKv);
  const merged: BoardingPromptCounters = {
    evaluated: (existing?.evaluated ?? 0) + delta.evaluated,
    fired: (existing?.fired ?? 0) + delta.fired,
    blocked: (existing?.blocked ?? 0) + delta.blocked,
    skippedNoContext: (existing?.skippedNoContext ?? 0) + delta.skippedNoContext,
    skippedStale: (existing?.skippedStale ?? 0) + delta.skippedStale,
    skippedTooFar: (existing?.skippedTooFar ?? 0) + delta.skippedTooFar,
    skippedTrainDuplicate: (existing?.skippedTrainDuplicate ?? 0) + delta.skippedTrainDuplicate,
    window: '24h',
    sampledAt: now,
  };
  await tripsKv.put(BOARDING_PROMPT_COUNTER_KEY, JSON.stringify(merged), {
    expirationTtl: BOARDING_PROMPT_COUNTER_TTL_SEC,
  });
  return merged;
}
